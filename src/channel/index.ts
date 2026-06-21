// ⚠️ 此文件由 channel-manager 自动生成，请勿手动编辑
// 运行 bun run channel:sync 重新生成
// channel 注册 + Agent/DO 导出均由脚本管理

import wechat from "./wechat/index";

export const channels = [
  wechat,
];
// ─── Agent/DO 类导出（供 wrangler 发现 DO） ──────────
export { WeChatBotAgent } from "./wechat/bot-agent";
export { WeChatQRCodeAgent } from "./wechat/qr-agent";

