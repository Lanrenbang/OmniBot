/**
 * 框架核心类型定义
 *
 * 遵循开发计划 §3.1 和 §7.2-7.3 定义。
 * IMChannel, MessagePayload, SendResult, ChannelWranglerConfig 等核心类型。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MessagePayload 设计——链路传输的统一消息结构
 *
 * 设计原则：
 *   userId 在链路中经过 IdentityMapper 时会发生值的变化（入站：平台 ID → 全局 UUID；
 *   出站：全局 UUID → 平台 ID），但除 IdentityMapper 外，各节点无需关心 userId
 *   的"身份"。chatId 同理——由各 Channel 自行解释其语义（微信 = context_token，
 *   飞书 = chat_id）。
 *
 * 各字段职责：
 *   channelId — 路由目标
 *   userId    — 链路各节点统一的用户标识（IdentityMapper 在入/出站时改写此值）
 *   chatId    — 回复寻址令牌（微信 = context_token，飞书 = chat_id；主动消息时可为空）
 *   replyTo   — 引用消息（被回复消息的相关信息，Channel 可据此构造 ref_msg）
 *   metadata  — 平台特定参数的兜底容器（Router 透传，不修改不丢弃）
 *
 * 与旧方案的差异（NormalizedMessage + SendPayload → MessagePayload）：
 *   - userId 替代 rawPlatformUserId + internalUserId 的二元结构
 *   - chatId 替代 rawPlatformChatId + internalChatId + contextToken
 *   - replyTo 从字符串变为对象（支持媒体引用等信息）
 *   - 无 raw 字段（去重由各 Channel 自行管理）
 *   - 无 messageId 顶层字段
 * ═══════════════════════════════════════════════════════════════════════════
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
   *
   * @param msg - MessagePayload 实例。userId 应为平台用户 ID（已由 Router 或
   *   IdentityMapper.reverse 在出站前还原）。chatId 承载回复会话令牌。
   */
  sendMessage(env: Env, msg: MessagePayload): Promise<SendResult>;
}

// ═══════════════════════════════════════════════════════════════════════════
// MessagePayload —— 链路传输的统一消息结构
//
// 设计原则：
//   userId 在链路中经过 IdentityMapper 时会发生值的变化（入站：平台 ID → 全局 UUID；
//   出站：全局 UUID → 平台 ID），但除 IdentityMapper 外，各节点无需关心 userId
//   的"身份"。chatId 同理——由各 Channel 自行解释其语义（微信 = context_token，
//   飞书 = chat_id）。
// ═══════════════════════════════════════════════════════════════════════════

/** 入/出站统一消息结构。用于 Channel <-> Router <-> Business 之间的全链路传输。 */
export interface MessagePayload {
  channelId: string;

  /**
   * 用户标识。
   * 入站：Channel 填入平台 UserID（如 wxid_xxx）→ IdentityMapper.resolve() 后变为全局 UUID
   * 出站：业务填入全局 UUID → Router 调 IdentityMapper.reverse() 后变为平台 UserID
   * 除 IdentityMapper 外，各节点无需关心 userId 的"身份"。
   */
  userId: string;

  /**
   * 对话标识。用于出站时的回复寻址/会话令牌。
   * 微信 = context_token，飞书 = chat_id，由各 Channel 自行解释。
   * 主动消息（无 prior 入站消息）时可能为空字符串。
   */
  chatId: string;

  messageType: "text" | "image" | "audio" | "video" | "file" | "event";
  text?: string;
  media?: {
    url: string;
    format?: string;
    headers?: Record<string, string>;
  };

  /** 引用消息 */
  replyTo?: {
    chatId?: string;                          // 被引用消息的对话 ID（部分平台用）
    text?: string;
    media?: {
      url: string;
      format?: string;
      headers?: Record<string, string>;
    };
  };

  /**
   * 平台特定参数（Router 透传，不修改不丢弃）。
   * 如 WeChat 的 messageState、CDN 上传参数等。
   */
  metadata?: Record<string, unknown>;
}

/** 统一发送结果 */
export interface SendResult {
  success: boolean;
  platformMessageId?: string;
  platformError?: string;
  raw?: unknown;
}
