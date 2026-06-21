/**
 * Channel 管理器
 *
 * 职责分离设计：
 * - 路由注册（静态）：在模块加载时完成，env 尚未可用。调用 installRoutes()
 * - init 检查（延迟）：在 fetch handler 首次请求时完成，env 已可用。调用 initChannels()
 * - sendMessage（运行时）：消息发送，需要 env
 */

import { Elysia } from "elysia";
import type { IMChannel, SendPayload, SendResult } from "./types";

import { channels as channelList } from "../channel";

export class ChannelManager {
  private channels: Map<string, IMChannel> = new Map();
  private initialized = false;

  /**
   * 静态路由注册（模块加载时调用，不需要 env）
   * 在 Elysia.compile() 之前执行
   */
  installRoutes(app: Elysia): void {
    for (const channel of channelList) {
      if (channel.routes) {
        if (channel.routes instanceof Elysia) {
          app.use(channel.routes);
        } else {
          channel.routes(app);
        }
      }
      this.channels.set(channel.id, channel);
    }
  }

  /**
   * 延迟初始化（fetch handler 首次请求时调用）
   * 此时 env 已可用，执行 channel.init() 检测绑定完整性
   * init 失败的 channel 不会从 Map 中移除（路由仍在），但标记为不可用
   */
  async initChannels(env: Env): Promise<void> {
    if (this.initialized) return;

    for (const [_id, channel] of this.channels) {
      if (channel.init) {
        const result = await channel.init(env);
        if (!result.available) {
          console.warn(`[${channel.id}] 初始化失败（可能未配置凭证），该 channel 功能不可用`);
        }
      }
    }

    this.initialized = true;

    if (this.channels.size === 0) {
      throw new Error("未注册任何 channel，系统无法启动");
    }
  }

  /** 获取已注册 channel */
  get(id: string): IMChannel | undefined {
    return this.channels.get(id);
  }

  /** 统一发送消息 */
  async send(env: Env, payload: SendPayload): Promise<SendResult> {
    const channel = this.channels.get(payload.channelId);
    if (!channel) throw new Error(`未知 channel: ${payload.channelId}`);
    return channel.sendMessage(env, payload);
  }
}

export const channelManager = new ChannelManager();
