/**
 * 消息路由系统 (MessageRouter)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * P5: 所有文本消息由 Router 回声。
 *   Channel Agent 在投递前已调用 IdentityMapper.resolve() 填充 internalUserId。
 *   Router 回声时以 NormalizedMessage.rawPlatformUserId 作为收件人 ID。
 *
 * 后期计划（做好 WIP 标记，暂不实现）：
 *   1. 斜杠命令匹配与路由（如 /help, /check 等 → 对应 Business Agent）
 *   2. Business Agent 对接（收到 Business 响应后 call IdentityMapper.reverse）
 *   3. 异步回复场景：Business 只知 internalUserId → Router 调 reverse 拿 rawPlatformUserId
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { NormalizedMessage, SendPayload } from "./types";
import { channelManager } from "./channel-manager";

export interface RouteHandler {
  patterns: string[];
  handle(msg: NormalizedMessage): Promise<SendPayload | null>;
  priority: number;
}

class MessageRouter {
  private handlers: RouteHandler[] = [];

  register(handler: RouteHandler) {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 处理归一化后的消息
   *
   * 此时 msg.internalUserId 已由 Channel Agent 调用 IdentityMapper.resolve() 填充。
   * Router 回声时直传 rawPlatformUserId 到 SendPayload。
   */
  async handleMessage(msg: NormalizedMessage, env: Env): Promise<void> {
    if (msg.messageType !== "text") {
      console.log(`[Router] 跳过非文本消息: ${msg.messageType}`);
      return;
    }

    const text = msg.text ?? "";
    console.log(`[Router] 收到文本消息: channel=${msg.channelId}, text="${text}"`);

    // ─── 斜杠命令匹配（WIP: 预留） ──────────────────────────────
    //
    // for (const handler of this.handlers) {
    //   for (const pattern of handler.patterns) {
    //     if (text.startsWith(pattern)) {
    //       const response = await handler.handle(msg);
    //       if (response) {
    //         await channelManager.send(env, response);
    //         return;
    //       }
    //     }
    //   }
    // }

    // ─── Business Agent 降级（WIP: 预留） ──────────────────────
    //
    // const businessAgent = (env as any).BUSINESS_AGENT;
    // if (businessAgent) {
    //   const stub = businessAgent.getByName("default");
    //   const response = await stub.processMessage(msg);
    //   if (response) {
    //     // 业务回复用 internalUserId → IdentityMapper.reverse → rawPlatformUserId
    //     // const mapper = env.IDENTITY_MAPPER.getByName("default");
    //     // const { platformUserId } = await mapper.reverse(response.internalUserId);
    //     await channelManager.send(env, {
    //       channelId: msg.channelId,
    //       rawPlatformUserId,    // from mapper.reverse
    //       contextToken: msg.contextToken,
    //       ...response,
    //     });
    //     return;
    //   }
    // }

    // ─── P5 回声 ────────────────────────────────────────────────
    // rawPlatformUserId 从 NormalizedMessage 直传，无需调 IdentityMapper.reverse
    await channelManager.send(env, {
      channelId: msg.channelId,
      rawPlatformUserId: msg.rawPlatformUserId,
      rawPlatformChatId: msg.rawPlatformChatId,
      messageType: "text",
      text: text,
      contextToken: msg.contextToken
    });
  }
}

export const router = new MessageRouter();
