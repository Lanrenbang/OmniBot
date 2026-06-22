/**
 * iLink 协议核心类型定义
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 本文件内容来自 weixin-ilink 技能附件的资产文件。
 * 包含了 iLink 协议的核心类型定义和关键字段注释。
 *
 * 开发时的注意事项：
 *   1. 首次开发时，将技能附件的 types.ts 复制到此位置。
 *      命令参考: cp .agents/skills/weixin-ilink/assets/types.ts src/channel/wechat/types.ts
 *   2. 当 weixin-ilink 技能更新时，检查是否有类型变更，同步更新此文件。
 *   3. 本文件中不应有重复的类型声明——所有类型应从技能附件导入。
 *   4. 如果需要在 iLink 协议类型之外扩展应用层类型（如缓存结构），
 *      请在本文件的 WeixinMessage/MessageItem 之外额外声明，不要修改协议类型。
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─── 基础类型 ──────────────────────────────────────────────────────────

/** iLink 协议版本信息 */
export interface BaseInfo {
  channel_version: string;
}

// ─── 消息类型枚举 ──────────────────────────────────────────────────────

/** MessageType: 1=用户消息, 2=机器人消息 */
export const MessageType = {
  USER: 1,
  BOT: 2
} as const;

/** MessageState: 2=完成, 其他值待查 */
export const MessageState = {
  FINISH: 2
} as const;

/** MessageItemType: 消息项类型 */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
} as const;

/**
 * 媒体类型枚举，对应 CDN 上传/下载时的 media_type。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 以下为每种媒体在【不下载 CDN 内容】的情况下，可直接从 API 响应中获取的信息：
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * IMAGE(1):
 *   - media.encrypt_query_param / media.full_url（CDN 下载链接）
 *   - media.aes_key（AES 解密密钥, base64）/ image_item.aeskey（hex 编码, 优先用于解密）
 *   - thumb_media（缩略图 CDN 引用）
 *   - mid_size, hd_size（密文大小）, thumb_size, thumb_height, thumb_width
 *   必须下载 CDN 才能获得：实际像素内容。
 *
 * VIDEO(2):
 *   - media.encrypt_query_param / media.full_url（CDN 下载链接）
 *   - media.aes_key（AES 解密密钥）
 *   - video_size（密文大小）, play_length（播放时长 ms）, video_md5
 *   - thumb_media（缩略图 CDN 引用）, thumb_size, thumb_height, thumb_width
 *   必须下载 CDN 才能获得：实际视频内容。
 *
 * FILE(3):
 *   - media.encrypt_query_param / media.full_url（CDN 下载链接）
 *   - media.aes_key（AES 解密密钥）
 *   - file_name（文件名）, md5（明文 MD5）, len（文件大小）
 *   必须下载 CDN 才能获得：实际文件内容。
 *
 * VOICE(4):
 *   - media.encrypt_query_param / media.full_url（CDN 下载链接）
 *   - media.aes_key（AES 解密密钥）
 *   - text（语音转文字结果 —— ⚠️ 无需下载即随消息送达，见 VoiceItem.text）
 *   - encode_type（编码类型）, sample_rate（采样率）, playtime（时长 ms）
 *   必须下载 CDN 才能获得：原始 SILK 音频数据（如需分析音质、音色、语调等）。
 */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

// ─── 媒体消息类型 ──────────────────────────────────────────────────────

/** CDN 媒体信息 */
export interface CDNMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
  file_size?: number;
  /** 缩略图，encrypt_type=1 时使用 */
  thumb_media?: CDNMedia;
}

/** 文本消息项 */
export interface TextItem {
  text: string;
}

/** 图片消息项 */
export interface ImageItem {
  media: CDNMedia;
  hd_size?: number;
  mid_size?: number;
  thumb_media?: CDNMedia;
}

/** 语音消息项（SILK V3 格式） */
export interface VoiceItem {
  media: CDNMedia;
  voice_format: number;
  voice_duration: number;
}

/** 文件消息项 */
export interface FileItem {
  media: CDNMedia;
  file_name: string;
  file_size: string;
}

/** 视频消息项 */
export interface VideoItem {
  media: CDNMedia;
  video_format: number;
  video_duration: number;
  thumb_media?: CDNMedia;
}

/** 消息项——联合类型 */
export type MessageItem = {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
};

// ─── 消息 ──────────────────────────────────────────────────────────────

/** iLink WeixinMessage（收发统一结构） */
export interface WeixinMessage {
  to_user_id: string;
  from_user_id?: string;
  client_id: string;
  msg_id?: string;
  message_type: number; // MessageType
  message_state: number; // MessageState
  context_token?: string;
  item_list: MessageItem[];
  created_time?: number;
}

/** getUpdates 返回的单条消息（服务端推送格式） */
export interface MessageItem_ {
  msg_id: string;
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state: number;
  context_token?: string;
  item_list: MessageItem[];
  created_time?: number;
}

// ─── getUpdates ────────────────────────────────────────────────────────

export interface GetUpdatesReq {
  get_updates_buf: string;
  base_info: BaseInfo;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  get_updates_buf: string;
  longpolling_timeout_ms: number;
  msgs?: MessageItem_[];
}

// ─── sendMessage ───────────────────────────────────────────────────────

export interface SendMessageReq {
  msg: WeixinMessage;
  base_info: BaseInfo;
}

export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

// ─── getUploadUrl ──────────────────────────────────────────────────────

export interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskey: string;
  no_need_thumb: boolean;
  base_info: BaseInfo;
}

export interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_full_url?: string;
  upload_param?: string;
  filekey: string;
}

// ─── getConfig ─────────────────────────────────────────────────────────

export interface GetConfigResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  channel_version: string;
  functions?: Record<string, boolean>;
}

// ─── sendTyping ────────────────────────────────────────────────────────

export interface SendTypingReq {
  to_user_id: string;
  typing_status: number; // 1=开始输入, 2=停止输入
  base_info: BaseInfo;
}

export interface SendTypingResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** 输入状态 */
export const TypingStatus = {
  START: 1,
  STOP: 2
} as const;
