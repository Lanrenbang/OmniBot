/**
 * 消息路由系统 (MessageRouter)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * P5: 所有文本消息由 Router 回声。
 *   Channel Agent 在投递前已将 MessagePayload.userId 设为平台 ID。
 *   Router 回声时不经过 IdentityMapper——直接将原 userId 和 chatId 返回。
 *
 * 后期计划（做好 WIP 标记，暂不实现）：
 *   1. 斜杠命令匹配与路由（如 /help, /check 等 → 对应 Business Agent）
 *   2. Business Agent 对接（收到 Business 响应后 call IdentityMapper.reverse）
 *   3. 异步回复场景：Business 只知全局 UUID → Router 调 reverse 拿平台 ID
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { MessagePayload } from "./types";
import { channelManager } from "./channel-manager";

export interface RouteHandler {
  patterns: string[];
  handle(msg: MessagePayload): Promise<MessagePayload | null>;
  priority: number;
}

class MessageRouter {
  private handlers: RouteHandler[] = [];

  register(handler: RouteHandler) {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 处理统一消息
   *
   * 此时 msg.userId 为平台 UserID（Channel Agent 已填充，尚未经 IdentityMapper）。
   * Router 回声时直接回传原 userId 和 chatId。
   */
  async handleMessage(msg: MessagePayload, env: Env): Promise<void> {
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
    //     // 业务回复用 userId → IdentityMapper.reverse → platformUserId
    //     // const mapper = env.IDENTITY_MAPPER.getByName("default");
    //     // const { platformUserId } = await mapper.reverse(response.userId);
    //     await channelManager.send(env, {
    //       channelId: msg.channelId,
    //       userId: platformUserId,    // from mapper.reverse
    //       chatId: msg.chatId,
    //       ...response,
    //     });
    //     return;
    //   }
    // }

    // ─── P5 回声 ────────────────────────────────────────────────
    // 直接回传原 userId 和 chatId（回声场景不经过 IdentityMapper）
    await channelManager.send(env, {
      channelId: msg.channelId,
      userId: msg.userId,
      chatId: msg.chatId,
      messageType: "text",
      text: text
    });
  }
}

export const router = new MessageRouter();
