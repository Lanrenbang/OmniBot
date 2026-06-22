import { Agent, callable, getAgentByName } from "agents";
import { MessageType } from "./types";
import { authHeaders, buildBaseInfo } from "./api";

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

    // user_channels: 存储 (bot_id, user_id) → 凭证映射。
    // 用于 sendMessage 时查找与用户关联的 Bot 账号凭证。
    // chatId（即 iLink context_token）由业务侧在 MessagePayload 中传递，
    // Agent 不再持久化此值——Agent 是纯被动的，只能由业务侧触发 sendMessage，
    // 每次调用都会携带 chatId。
    this.sql`CREATE TABLE IF NOT EXISTS user_channels (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
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
          base_info: buildBaseInfo()
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
        // 清理该账号关联的用户通道记录，避免垃圾数据残留
        this.sql`DELETE FROM user_channels WHERE bot_id = ${account.ilink_bot_id}`;
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

        // 持久化 (user_id → 凭证) 映射，供后续 sendMessage 查找 Bot 账号凭证。
        // 不存 context_token——它由业务侧在 MessagePayload.chatId 中传递。
        this.sql`INSERT OR REPLACE INTO user_channels
          (bot_id, user_id, bot_token, base_url, wechat_uin, updated_at)
          VALUES (${account.ilink_bot_id}, ${msg.from_user_id},
                  ${account.bot_token}, ${account.base_url}, ${account.wechat_uin}, ${Date.now()})`;

        // 使用 MessagePayload 统一结构投递
        // userId 先填平台 ID（msg.from_user_id），后续由 Router 或 IdentityMapper
        // 在入站路径上改写为全局 UUID。chatId 承载 WeChat 的 context_token。
        const payload: import("../../framework/types").MessagePayload = {
          channelId: "wechat",
          userId: msg.from_user_id,
          chatId: msg.context_token ?? "",
          messageType,
          text: this.extractText(msg)
        };
        console.log(`[BotAgent] 转发消息至 Router: from=${msg.from_user_id}, text=${payload.text?.slice(0, 50)}`);
        await this.env.ROUTER.routeMessage(payload);
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
   * 根据统一 MessagePayload 发送消息
   *
   * payload.userId 此时已被 Router 还原为平台 ilink_user_id（回声场景直传，
   * 业务回复场景经 IdentityMapper.reverse 还原）。
   * payload.chatId 承载 WeChat 的 context_token（被动回复时来自入站消息，
   * 主动消息时可能为空字符串，此时 Agent 不再 fallback 查表）。
   *
   * Agent 通过 payload.userId 在 user_channels 表中查找对应的 Bot 账号凭证。
   * 注意：context_token 不再从 user_channels 表读取——它由业务侧在
   * MessagePayload.chatId 中传递。Agent 是纯被动的，只能由业务侧触发
   * sendMessage，每次调用都会携带 chatId。
   */
  @callable()
  async sendMessage(payload: import("../../framework/types").MessagePayload) {
    // 查找与用户关联的 Bot 账号凭证
    const [channel] = this.sql<{
      bot_token: string;
      base_url: string;
      wechat_uin: string;
    }>`
      SELECT bot_token, base_url, wechat_uin
      FROM user_channels
      WHERE user_id = ${payload.userId}
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    if (!channel) throw new Error(`未找到与用户 ${payload.userId} 关联的 Bot 账号`);

    // chatId 承载 WeChat context_token（入站时从 msg.context_token 获取，
    // 出站时由业务侧传递，Agent 不再 fallback）
    const contextToken = payload.chatId || undefined;

    // 构建 item_list（支持文本和后续媒体）
    const itemList: { type: number; text_item?: { text: string } }[] = [];
    if (payload.text) {
      itemList.push({ type: 1, text_item: { text: payload.text } });
    }

    return fetch(`${channel.base_url}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: authHeaders(channel.bot_token, channel.wechat_uin),
      body: JSON.stringify({
        msg: {
          to_user_id: payload.userId,
          client_id: crypto.randomUUID(),
          message_type: MessageType.BOT,
          message_state: (payload.metadata?.messageState as number) ?? 2,
          context_token: contextToken,
          item_list: itemList
        },
        base_info: buildBaseInfo()
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

  /**
   * 返回最近 N 个已登录账号的 bot_token 列表。
   * 供 QRCodeAgent 获取二维码时上报 local_token_list，实现 binded_redirect 加速。
   * 参考上游 openclaw-weixin/src/auth/login-qr.ts getLocalBotTokenList()
   */
  @callable()
  async getRecentTokens(count: number = 10): Promise<string[]> {
    const rows = this.sql<{ bot_token: string }>`
      SELECT bot_token FROM accounts ORDER BY connected_at DESC LIMIT ${count}
    `;
    return rows.map((r) => r.bot_token).filter(Boolean);
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
