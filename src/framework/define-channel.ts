/**
 * defineChannel / defineWrangler 辅助函数
 *
 * 提供类型安全的 Channel 定义和 Wrangler 配置构建辅助。
 */

import type { IMChannel, ChannelWranglerConfig } from "./types";

export function defineChannel(config: IMChannel): IMChannel {
  return config;
}

/** wrangler 字段的类型安全构建辅助 */
export function defineWrangler(
  config: ChannelWranglerConfig,
): ChannelWranglerConfig {
  return config;
}
