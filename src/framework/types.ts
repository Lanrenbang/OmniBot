/**
 * 框架核心类型定义
 *
 * 遵循开发计划 §3.1 和 §7.2-7.3 定义。
 * IMChannel, NormalizedMessage, SendPayload, ChannelWranglerConfig 等核心类型。
 */

import type { Elysia } from "elysia";

/** Channel 定义的 wrangler.jsonc 配置片段（仅构建时预处理，非运行时期） */
export interface ChannelWranglerConfig {
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
   */
  routes?: ((app: Elysia) => Elysia) | Elysia;

  /**
   * wrangler.jsonc 配置（仅构建时预处理，非运行时）
   * channel-manager 脚本读取此字段并合成到 wrangler.jsonc
   */
  wrangler?: ChannelWranglerConfig;

  /**
   * Channel 初始化（在 worker 启动时调用）
   */
  init?(env: Env): Promise<{ available: boolean }>;

  /**
   * 统一发送消息接口
   * 各 channel 实现自己的发送逻辑
   * @param msg.rawPlatformUserId - 收件人平台 ID（由 IdentityMapper.reverse 或 Router 提供）
   */
  sendMessage(env: Env, msg: SendPayload): Promise<SendResult>;
}

/** 标准化消息格式（入站） */
export interface NormalizedMessage {
  channelId: string;
  messageId: string;

  // ── 平台原始 ID（Channel normalize 时填充） ──
  /**
   * 平台原始用户 ID（如微信 wxid、飞书 open_id/user_id）
   * Channel 的 normalize() 必须填充此字段
   */
  rawPlatformUserId: string;
  /** 平台原始聊天/群组 ID（单聊时与 rawPlatformUserId 相同） */
  rawPlatformChatId?: string;

  // ── 统一内部 ID（Channel 调用 IdentityMapper.resolve 后填充） ──
  /** 经 IdentityMapper.resolve() 解析后的项目级统一用户 ID */
  internalUserId: string;
  /** 经 IdentityMapper 解析后的统一聊天 ID */
  internalChatId: string;

  messageType: "text" | "image" | "audio" | "video" | "file" | "event";
  text?: string;
  media?: {
    url?: string;
    encrypted?: boolean;
    format?: string;
  };
  raw: unknown;
  contextToken?: string; // 平台特定上下文令牌（如微信 context_token），Router 透传
}

/** 统一发送结果 */
export interface SendResult {
  success: boolean;
  platformMessageId?: string;
  platformError?: string;
  raw?: unknown;
}

/**
 * 统一发送载荷（出站）
 *
 * rawPlatformUserId 由 IdentityMapper.reverse() 或 Router 从 NormalizedMessage 直传。
 * contextToken 和 metadata 为透传字段——Router 不修改不丢弃。
 */
export interface SendPayload {
  channelId: string;

  /**
   * 收件人平台 ID。
   * - 回声场景：Router 从 NormalizedMessage.rawPlatformUserId 直传
   * - 业务回复：Router 调 IdentityMapper.reverse(internalUserId) 得到
   */
  rawPlatformUserId: string;
  rawPlatformChatId?: string;

  messageType: "text" | "image" | "audio" | "video" | "file";
  text?: string;
  media?: {
    data?: ArrayBuffer;
    url?: string;
    format?: string;
  };
  replyTo?: string;

  /**
   * 平台上下文令牌。
   * Channel Agent 在 normalize 时从原始消息提取，Router 透传。
   * 如微信的 context_token、飞书的 context 等。
   */
  contextToken?: string;

  /**
   * 透传元数据。
   * Channel Agent 可在此放置发送所需的额外字段，
   * Router 不修改不丢弃。
   */
  metadata?: Record<string, unknown>;
}
