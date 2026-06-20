/**
 * 框架核心类型定义
 *
 * 遵循开发计划 3.1 节定义。
 * IMChannel, NormalizedMessage, SendPayload, ChannelWranglerConfig 等核心类型。
 */

import type { Elysia } from "elysia";

/** Channel 定义的 wrangler.jsonc 配置片段（仅构建时预处理，非运行时期） */
export interface ChannelWranglerConfig {
  /**
   * Agent / AIChatAgent / DO 的绑定声明。
   * Agent 和 AIChatAgent 均继承自 DurableObject，在 wrangler.jsonc 中声明方式与原生 DO 完全相同：
   * 使用 durable_objects.bindings + migrations.new_sqlite_classes。
   */
  durable_objects?: {
    bindings: Array<{
      name: string;
      class_name: string;
    }>;
  };
  migrations?: Array<{
    tag: string;
    new_sqlite_classes?: string[];
    new_classes?: string[];
    deleted_classes?: string[];
  }>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
  }>;
  kv_namespaces?: Array<{
    binding: string;
    id: string;
  }>;
  vars?: Record<string, string | number | boolean>;
}

/** IM 前端 Channel 接口 */
export interface IMChannel {
  /** Channel 唯一标识，如 "wechat"、"feishu" */
  id: string;
  /** Channel 显示名称 */
  name: string;
  /** Channel 描述（可选） */
  description?: string;

  /**
   * 路由注册（被动收信通道）
   * 返回一个 Elysia 实例或 (app) => app 的函数
   * 纯路由 channel 可实现完全自动发现
   */
  routes?: ((app: Elysia) => Elysia) | Elysia;

  /**
   * wrangler.jsonc 配置（仅构建时预处理，非运行时）
   * channel-manager 脚本读取此字段并合成到 wrangler.jsonc
   */
  wrangler?: ChannelWranglerConfig;

  /**
   * Channel 初始化（在 worker 启动时调用）
   * 可在此检测 env 中的 binding 是否就绪
   */
  init?(env: Env): Promise<{ available: boolean }>;

  /**
   * 统一发送消息接口
   * 各 channel 实现自己的发送逻辑
   */
  sendMessage(env: Env, msg: SendPayload): Promise<SendResult>;
}

/** 标准化消息格式 */
export interface NormalizedMessage {
  channelId: string;
  messageId: string;

  // ── 平台原始 ID（Channel normalize 时填充，Router 用于 IdentityMapper 解析） ──
  /**
   * 平台原始用户 ID（如微信 wxid、飞书 open_id/user_id）
   * Channel 的 normalize() 必须填充此字段，Router 通过 IdentityMapper.resolve()
   * 将其解析为 internalUserId
   */
  rawPlatformUserId: string;
  /**
   * 平台原始聊天/群组 ID（如微信 chatroom_id、飞书 chat_id）
   * 单聊时与 rawPlatformUserId 相同，群聊时为群 ID
   */
  rawPlatformChatId?: string;

  // ── 统一内部 ID（Router 经 IdentityMapper 解析后填充） ──
  internalUserId: string; // 经 IdentityMapper 解析后的统一用户 ID
  internalChatId: string; // 经 IdentityMapper 解析后的统一聊天 ID

  messageType: "text" | "image" | "audio" | "video" | "file" | "event";
  text?: string;
  media?: {
    url?: string;
    encrypted?: boolean;
    format?: string;
  };
  raw: unknown;
  contextToken?: string; // 微信等平台需要
}

/** 统一发送结果 */
export interface SendResult {
  success: boolean;
  platformMessageId?: string;
  platformError?: string;
  raw?: unknown;
}

/** 统一发送载荷 */
export interface SendPayload {
  channelId: string;
  internalUserId: string;
  internalChatId: string;
  messageType: "text" | "image" | "audio" | "video" | "file";
  text?: string;
  media?: {
    data?: ArrayBuffer;
    url?: string;
    format?: string;
  };
  replyTo?: string;
  contextToken?: string; // 微信等平台需要，用于引用回复
}
