import { Agent, callable, getAgentByName } from "agents";
import { MessageType } from "./types";
import { authHeaders } from "./api";

interface AccountInfo {
  ilink_bot_id: string;
  ilink_user_id: string;
  bot_token: string;
  base_url: string;
  updates_buf: string;
  wechat_uin: string;
}

export class WeChatBotAgent extends Agent<Env> {
  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS accounts (
      ilink_bot_id TEXT PRIMARY KEY,
      ilink_user_id TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      base_url TEXT NOT NULL,
      updates_buf TEXT NOT NULL DEFAULT '',
      wechat_uin TEXT NOT NULL DEFAULT '',
      connected_at INTEGER,
      last_active_at INTEGER
    )`;

    this.sql`CREATE TABLE IF NOT EXISTS processed_msgs (
      msg_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )`;

    // context_tokens: 存储每个账号与用户的会话上下文。
    // user_id = msg.from_user_id（收消息时的发送者，发消息时的收件人）。
    // IdentityMapper 只做 ID 替换，context_token 由 Agent 自行管理。
    this.sql`CREATE TABLE IF NOT EXISTS context_tokens (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      base_url TEXT NOT NULL,
      wechat_uin TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (bot_id, user_id)
    )`;

    // this.sql 返回 T[]，直接用变量接收
    const accounts = this.sql<AccountInfo>`
      SELECT * FROM accounts WHERE last_active_at > 0
    `;
    console.log(`[BotAgent] onStart: 恢复 ${accounts.length} 个账号的轮询`);
    for (const acc of accounts) {
      console.log(`[BotAgent] onStart: 调度轮询 bot=${acc.ilink_bot_id}`);
      // 使用 schedule() 通过 DO alarm 触发轮询，idempotent 防止多组 restart 重复
      await this.schedule(1, "startPolling", acc, { idempotent: true });
    }
  }

  async alarm() {
    console.log(`[BotAgent] alarm 触发`);
    this.sql`DELETE FROM processed_msgs WHERE processed_at < ${Date.now() - 7 * 24 * 60 * 60 * 1000}`;
    await super.alarm();
  }

  @callable()
  async registerAccount(info: {
    bot_token: string;
    ilink_bot_id: string;
    ilink_user_id: string;
    baseurl: string;
    wechat_uin: string;
  }) {
    // DO RPC 调用会绕过 PartyServer 的 fetch()，确保 onStart() 已执行创建用户表
    // eslint-disable-next-line typescript/no-explicit-any
    await (this as any).__unsafe_ensureInitialized();
    console.log(
      `[BotAgent] registerAccount: bot=${info.ilink_bot_id}, user=${info.ilink_user_id}, baseurl=${info.baseurl}`
    );
    try {
      this.sql`INSERT OR REPLACE INTO accounts
        (ilink_bot_id, ilink_user_id, bot_token, base_url, wechat_uin, connected_at, last_active_at)
        VALUES (${info.ilink_bot_id}, ${info.ilink_user_id}, ${info.bot_token},
                ${info.baseurl}, ${info.wechat_uin}, ${Date.now()}, ${Date.now()})`;
      const account = {
        ilink_bot_id: info.ilink_bot_id,
        ilink_user_id: info.ilink_user_id,
        bot_token: info.bot_token,
        base_url: info.baseurl,
        updates_buf: "",
        wechat_uin: info.wechat_uin
      };
      // 直接启动首次轮询。不通过 schedule(1) 避免被其他账号的长时间 HTTP 请求阻塞。
      // startPolling 末尾会自动 schedule(1) 调度后续轮询。
      this.startPolling(account).catch((err) => console.error(`[BotAgent] registerAccount: startPolling 异常: ${err}`));
      console.log(`[BotAgent] registerAccount: startPolling 已直接启动`);
    } catch (err) {
      console.error(`[BotAgent] registerAccount 失败: ${err}`);
    }
  }

  private consecutiveFailures = new Map<string, number>();
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private static readonly RETRY_DELAY_MS = 2_000;
  private static readonly BACKOFF_DELAY_MS = 30_000;

  private getFailureCount(botId: string): number {
    return this.consecutiveFailures.get(botId) ?? 0;
  }

  private recordFailure(botId: string): number {
    const count = this.getFailureCount(botId) + 1;
    this.consecutiveFailures.set(botId, count);
    return count;
  }

  private resetFailures(botId: string): void {
    this.consecutiveFailures.delete(botId);
  }

  async startPolling(account: AccountInfo) {
    console.log(`[BotAgent] startPolling 执行: bot=${account.ilink_bot_id}, buf_len=${account.updates_buf.length}`);
    try {
      const url = `${account.base_url}/ilink/bot/getupdates`;
      const response = await fetch(url, {
        method: "POST",
        headers: authHeaders(account.bot_token, account.wechat_uin),
        body: JSON.stringify({
          get_updates_buf: account.updates_buf,
          base_info: { channel_version: "2.1.6" }
        }),
        signal: AbortSignal.timeout(40_000)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        console.error(`[BotAgent] getUpdates HTTP ${response.status}: ${text}`);
        const httpFailCount = this.recordFailure(account.ilink_bot_id);
        const delay =
          httpFailCount >= WeChatBotAgent.MAX_CONSECUTIVE_FAILURES
            ? WeChatBotAgent.BACKOFF_DELAY_MS
            : WeChatBotAgent.RETRY_DELAY_MS;
        console.log(`[BotAgent] HTTP 错误重试: delay=${delay}ms, consecutive=${httpFailCount}`);
        await this.schedule(delay, "startPolling", account);
        return;
      }

      // eslint-disable-next-line typescript/no-explicit-any
      const data = (await response.json()) as any;
      console.log(
        `[BotAgent] getUpdates 响应: ret=${data.ret}, msgs=${data.msgs?.length ?? 0}, buf=${data.get_updates_buf?.length ?? 0}`
      );

      if (data.ret === -14 || data.errcode === -14) {
        console.warn(
          `[BotAgent] 账号已失效(ret=${data.ret}, errcode=${data.errcode})，停止轮询: bot=${account.ilink_bot_id}`
        );
        this.sql`UPDATE accounts SET last_active_at = 0 WHERE ilink_bot_id = ${account.ilink_bot_id}`;
        // 清理该账号关联的会话上下文，避免垃圾数据残留
        this.sql`DELETE FROM context_tokens WHERE bot_id = ${account.ilink_bot_id}`;
        return;
      }

      const isApiError =
        (data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0);
      if (isApiError) {
        console.error(
          `[BotAgent] getUpdates API 错误: ret=${data.ret}, errcode=${data.errcode}, errmsg=${data.errmsg ?? "(无)"}`
        );
        const apiFailCount = this.recordFailure(account.ilink_bot_id);
        const delay =
          apiFailCount >= WeChatBotAgent.MAX_CONSECUTIVE_FAILURES
            ? WeChatBotAgent.BACKOFF_DELAY_MS
            : WeChatBotAgent.RETRY_DELAY_MS;
        console.log(`[BotAgent] API 错误重试: delay=${delay}ms, consecutive=${apiFailCount}`);
        await this.schedule(delay, "startPolling", account);
        return;
      }

      this.resetFailures(account.ilink_bot_id);

      account.updates_buf = data.get_updates_buf;
      this.sql`UPDATE accounts SET updates_buf = ${data.get_updates_buf}, last_active_at = ${Date.now()}
        WHERE ilink_bot_id = ${account.ilink_bot_id}`;

      const msgs = data.msgs ?? [];
      if (msgs.length > 0) {
        console.log(`[BotAgent] 收到 ${msgs.length} 条消息`);
      }

      for (const msg of msgs) {
        const dedupKey = String(msg.message_id ?? crypto.randomUUID());
        const [existing] = this.sql<{ cnt: number }>`
          SELECT COUNT(*) as cnt FROM processed_msgs WHERE msg_id = ${dedupKey}
        `;
        if (existing.cnt > 0) continue;
        this.sql`INSERT INTO processed_msgs (msg_id, processed_at) VALUES (${dedupKey}, ${Date.now()})`;

        const messageType = this.inferType(msg);

        if (messageType !== "text") {
          console.log(`[BotAgent] 跳过非文本消息: type=${messageType}, from=${msg.from_user_id}`);
          continue;
        }

        // 存储 context_token（Agent 内部管理，IdentityMapper 不关心）
        if (msg.context_token) {
          this.sql`INSERT OR REPLACE INTO context_tokens
            (bot_id, user_id, context_token, bot_token, base_url, wechat_uin, updated_at)
            VALUES (${account.ilink_bot_id}, ${msg.from_user_id}, ${msg.context_token},
                    ${account.bot_token}, ${account.base_url}, ${account.wechat_uin}, ${Date.now()})`;
        }

        // 调用 IdentityMapper.resolve() 将 rawPlatformUserId 替换为 internalUserId
        let internalUserId = "";
        try {
          const mapper = this.env.IDENTITY_MAPPER;
          if (mapper) {
            const stub = await getAgentByName(mapper, "default");
            internalUserId = await stub.resolve({
              platform: "wechat",
              platformUserId: msg.from_user_id
            });
          }
        } catch (err) {
          console.error(`[BotAgent] IdentityMapper.resolve 失败: ${err}`);
        }

        const normalized = {
          channelId: "wechat",
          messageId: msg.msg_id ?? crypto.randomUUID(),
          rawPlatformUserId: msg.from_user_id,
          rawPlatformChatId: msg.from_user_id,
          internalUserId,
          internalChatId: "",
          messageType,
          text: this.extractText(msg),
          raw: msg,
          contextToken: msg.context_token
        };
        console.log(`[BotAgent] 转发消息至 Router: from=${msg.from_user_id}, text=${normalized.text?.slice(0, 50)}`);
        await this.env.ROUTER.routeMessage(normalized);
      }
    } catch (err) {
      console.error(`[BotAgent] startPolling 异常: ${err}`);
      const excFailCount = this.recordFailure(account.ilink_bot_id);
      const delay =
        excFailCount >= WeChatBotAgent.MAX_CONSECUTIVE_FAILURES
          ? WeChatBotAgent.BACKOFF_DELAY_MS
          : WeChatBotAgent.RETRY_DELAY_MS;
      console.log(`[BotAgent] 异常后重试: delay=${delay}ms, consecutive=${excFailCount}`);
      await this.schedule(delay, "startPolling", account);
      return;
    }

    await this.schedule(1, "startPolling", account);
  }

  /**
   * 发送文本消息给指定用户
   *
   * payload.rawPlatformUserId: 收件人平台 ID（Router 从 NormalizedMessage 直传或
   *   IdentityMapper.reverse 产出）。Agent 通过此值在 context_tokens 表中查找
   *   对应的账号凭证和 context_token。
   *
   * 多账号场景：context_tokens 表的 (bot_id, user_id) 复合主键可区分同一用户在
   *   不同 Bot 账号下的会话。查询按 updated_at DESC 取最近一个。
   */
  @callable()
  async sendMessage(payload: { rawPlatformUserId: string; text: string; contextToken?: string }) {
    const [ctx] = this.sql<{
      bot_token: string;
      base_url: string;
      wechat_uin: string;
      context_token: string;
    }>`
      SELECT bot_token, base_url, wechat_uin, context_token
      FROM context_tokens
      WHERE user_id = ${payload.rawPlatformUserId}
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    if (!ctx) throw new Error("未找到与该用户的会话信息（无 context_token）");

    const contextToken = payload.contextToken ?? ctx.context_token;

    return fetch(`${ctx.base_url}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: authHeaders(ctx.bot_token, ctx.wechat_uin),
      body: JSON.stringify({
        msg: {
          to_user_id: payload.rawPlatformUserId,
          client_id: crypto.randomUUID(),
          message_type: MessageType.BOT,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: payload.text } }]
        },
        base_info: { channel_version: "2.1.6" }
      })
    });
  }

  private inferType(msg: { item_list?: { type: number }[] }): string {
    if (!msg.item_list?.length) return "text";
    const type = msg.item_list[0].type;
    return type === 2 ? "image" : type === 3 ? "audio" : type === 4 ? "file" : type === 5 ? "video" : "text";
  }

  private extractText(msg: { item_list?: { type: number; text_item?: { text: string } }[] }): string | undefined {
    return msg.item_list?.find((i) => i.type === 1)?.text_item?.text;
  }

  @callable()
  async getAccounts() {
    // this.sql 返回 T[]，直接返回
    return this.sql<
      Pick<AccountInfo, "ilink_bot_id" | "ilink_user_id"> & { connected_at: number; last_active_at: number }
    >`
      SELECT ilink_bot_id, ilink_user_id, connected_at, last_active_at FROM accounts
    `;
  }
}
