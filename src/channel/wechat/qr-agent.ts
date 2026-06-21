import { Agent, callable, getAgentByName } from "agents";
import { commonHeaders, withUin, generateUin, DEFAULT_BASE_URL } from "./api";

/**
 * 从 WeChatBotAgent 获取最近已登录的 bot_token 列表（最多 10 个）。
 * 用于获取二维码时上报 local_token_list，使服务端识别已绑定的 Bot 并返回 binded_redirect。
 * 第一个 token 为空（无已登录账号）时返回空数组。
 */
async function fetchLocalTokenList(env: Env): Promise<string[]> {
  try {
    const botStub = await getAgentByName(env.WECHAT_BOT_AGENT, "default");
    const tokens = await botStub.getRecentTokens(10);
    return tokens.filter(Boolean);
  } catch {
    // BotAgent 尚未就绪（首次部署无账号）时静默返回空
    return [];
  }
}

interface QRStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

const MAX_QR_REFRESH_COUNT = 3;

export class WeChatQRCodeAgent extends Agent<Env> {
  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS qr_codes (
      qrcode TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'wait',
      bot_token TEXT,
      ilink_bot_id TEXT,
      ilink_user_id TEXT,
      baseurl TEXT,
      wechat_uin TEXT,
      pending_verify_code TEXT,
      refresh_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // 对已有旧表补充 pending_verify_code 列（ALTER 在列已存在时忽略）
    try { this.sql`ALTER TABLE qr_codes ADD COLUMN pending_verify_code TEXT`; } catch {}
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname.split("/").pop();

    switch (action) {
      case "fetch": {
        const uin = generateUin();
        const localTokenList = await fetchLocalTokenList(this.env);

        const resp = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
          method: "POST",
          headers: withUin({ ...commonHeaders(), "Content-Type": "application/json" }, uin),
          body: JSON.stringify({ local_token_list: localTokenList })
        });
        if (!resp.ok) {
          return new Response("获取二维码失败", { status: 502 });
        }
        const data = (await resp.json()) as {
          qrcode: string;
          qrcode_img_content?: string;
        };

        this.sql`INSERT INTO qr_codes (qrcode, status, wechat_uin, created_at, updated_at)
          VALUES (${data.qrcode}, 'wait', ${uin}, ${Date.now()}, ${Date.now()})`;

        this.schedule(0, "pollStatus", {
          qrcode: data.qrcode,
          baseUrl: DEFAULT_BASE_URL,
          uin
        });

        return Response.json({
          qrcode: data.qrcode,
          qrcodeImg: data.qrcode_img_content
        });
      }

      case "status": {
        const qrcode = url.searchParams.get("qrcode");
        if (!qrcode) return new Response("Missing qrcode", { status: 400 });

        const [record] = this.sql<{
          status: string;
          refresh_count: number;
          bot_token?: string;
          ilink_bot_id?: string;
          pending_verify_code?: string;
        }>`
          SELECT status, refresh_count, bot_token, ilink_bot_id, pending_verify_code
          FROM qr_codes WHERE qrcode = ${qrcode}
        `;
        const currentStatus = record?.status ?? "expired";
        console.log(`[QRAgent] status 查询: qrcode=${qrcode.slice(0, 12)}... status=${currentStatus} pendingVerify=${!!record?.pending_verify_code}`);
        return Response.json({
          status: currentStatus,
          refreshCount: record?.refresh_count ?? 0,
          alreadyBound:
            record?.status === "confirmed" || (record?.status === "binded_redirect" && !!record?.ilink_bot_id),
          hasPendingVerifyCode: !!record?.pending_verify_code
        });
      }

      case "verify-code": {
        const body = (await req.json()) as { qrcode: string; code: string };
        if (!body.qrcode || !body.code) {
          return new Response("Missing qrcode or code", { status: 400 });
        }
        // 将配对码存入 pending_verify_code，pollStatus 下一轮会读取并使用
        this.sql`UPDATE qr_codes SET pending_verify_code = ${body.code},
          status = 'need_verifycode', updated_at = ${Date.now()}
          WHERE qrcode = ${body.qrcode}`;
        return Response.json({ ok: true });
      }

      default:
        return new Response("Not found", { status: 404 });
    }
  }

  async pollStatus(params: { qrcode: string; baseUrl: string; uin: string; verifyCode?: string }) {
    console.log(`[QRAgent] pollStatus: qrcode=${params.qrcode?.slice(0, 12)}...`);
    try {
      // 从 DB 读取待提交的配对码（由前端 POST /verify-code 写入）
      const [pending] = this.sql<{ pending_verify_code: string }>`
        SELECT pending_verify_code FROM qr_codes WHERE qrcode = ${params.qrcode}
      `;
      const effectiveVerifyCode = pending?.pending_verify_code || params.verifyCode;

      let endpoint = `${params.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${params.qrcode}`;
      if (effectiveVerifyCode) {
        endpoint += `&verify_code=${encodeURIComponent(effectiveVerifyCode)}`;
      }

      const resp = await fetch(endpoint, {
        headers: commonHeaders()
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "(no body)");
        console.warn(`[QRAgent] pollStatus HTTP ${resp.status}: ${text}`);
        this.schedule(5, "pollStatus", params);
        return;
      }

      const rawText = await resp.text();
      const data = JSON.parse(rawText) as QRStatusResponse;

      this.sql`UPDATE qr_codes SET status = ${data.status}, updated_at = ${Date.now()}
        WHERE qrcode = ${params.qrcode}`;

      switch (data.status) {
        case "confirmed": {
          // 配对码验证成功（如需），清除暂存
          this.sql`UPDATE qr_codes SET pending_verify_code = NULL
            WHERE qrcode = ${params.qrcode}`;
          console.log(`[QRAgent] 扫码已确认，调用 registerAccount: bot=${data.ilink_bot_id}`);
          this.sql`UPDATE qr_codes SET
            bot_token = ${data.bot_token!}, ilink_bot_id = ${data.ilink_bot_id!},
            ilink_user_id = ${data.ilink_user_id!}, baseurl = ${data.baseurl!}
            WHERE qrcode = ${params.qrcode}`;

          const botStub = await getAgentByName(this.env.WECHAT_BOT_AGENT, "default");
          await botStub.registerAccount({
            bot_token: data.bot_token!,
            ilink_bot_id: data.ilink_bot_id!,
            ilink_user_id: data.ilink_user_id!,
            baseurl: data.baseurl!,
            wechat_uin: params.uin
          });
          return;
        }

        case "binded_redirect": {
          console.log(`[QRAgent] 账号已绑定(binded_redirect)`);
          this.sql`UPDATE qr_codes SET status = 'binded_redirect', updated_at = ${Date.now()}
            WHERE qrcode = ${params.qrcode}`;
          return;
        }

        case "expired": {
          console.log(`[QRAgent] 二维码已过期`);
          return;
        }

        case "scaned_but_redirect": {
          const newBaseUrl = data.redirect_host ? `https://${data.redirect_host}` : params.baseUrl;
          console.log(`[QRAgent] 重定向至: ${newBaseUrl}`);
          this.schedule(0, "pollStatus", { ...params, baseUrl: newBaseUrl });
          return;
        }

        case "need_verifycode": {
          if (effectiveVerifyCode) {
            // 已携带配对码但服务端仍需配对码 → 配对码错误
            // 清除 DB 中的错误码，让前端重新提示输入
            console.log(`[QRAgent] 配对码错误，清除并等待重新输入`);
            this.sql`UPDATE qr_codes SET pending_verify_code = NULL, updated_at = ${Date.now()}
              WHERE qrcode = ${params.qrcode}`;
          }
          // 无配对码时继续轮询，前端会在 need_verifycode 状态时显示输入框
          this.schedule(0, "pollStatus", { ...params, verifyCode: undefined });
          return;
        }

        case "verify_code_blocked": {
          console.warn(`[QRAgent] 配对码输入多次错误`);
          // 清除配对码暂存
          this.sql`UPDATE qr_codes SET pending_verify_code = NULL,
            refresh_count = refresh_count + 1, updated_at = ${Date.now()}
            WHERE qrcode = ${params.qrcode}`;
          const [record] = this.sql<{ refresh_count: number }>`
            SELECT refresh_count FROM qr_codes WHERE qrcode = ${params.qrcode}
          `;
          if (record && record.refresh_count >= MAX_QR_REFRESH_COUNT) {
            console.log(`[QRAgent] 超过最大刷新次数，停止轮询`);
            return;
          }
          return;
        }

        case "wait":
        case "scaned":
          this.schedule(0, "pollStatus", params);
          return;
      }
    } catch (err) {
      console.error(`[QRAgent] pollStatus 异常: ${err}`);
      this.schedule(5, "pollStatus", params);
    }
  }

  @callable()
  async getQRStatus(qrcode: string): Promise<{
    status: string;
    refreshCount?: number;
    alreadyBound?: boolean;
  }> {
    const [record] = this.sql<{
      status: string;
      refresh_count: number;
      bot_token?: string;
      ilink_bot_id?: string;
    }>`
      SELECT status, refresh_count, bot_token, ilink_bot_id
      FROM qr_codes WHERE qrcode = ${qrcode}
    `;
    return {
      status: record?.status ?? "expired",
      refreshCount: record?.refresh_count ?? 0,
      alreadyBound: record?.status === "confirmed" || (record?.status === "binded_redirect" && !!record?.ilink_bot_id)
    };
  }
}
