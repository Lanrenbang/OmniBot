import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { defineChannel, defineWrangler } from "../../framework/define-channel";

// Re-export Agent/DO classes for wrangler discovery
export { WeChatBotAgent } from "./bot-agent";
export { WeChatQRCodeAgent } from "./qr-agent";

export default defineChannel({
  id: "wechat",
  name: "微信 (iLink)",
  description: "基于 iLink 协议的微信个人版 Bot",
  wrangler: defineWrangler({
    durable_objects: {
      bindings: [
        { name: "WECHAT_BOT_AGENT", class_name: "WeChatBotAgent" },
        { name: "WECHAT_QR_CODE_AGENT", class_name: "WeChatQRCodeAgent" }
      ]
    },
    migrations: [
      {
        tag: "v1-wechat",
        new_sqlite_classes: ["WeChatBotAgent", "WeChatQRCodeAgent"]
      }
    ],
    vars: {
      ILINK_CHANNEL_VERSION: "2.1.6"
    }
  }),

  // Route: serve the QR scan page at /wechat/qr
  // QR fetch/status/verify-code are handled by routeAgentRequest → WeChatQRCodeAgent.onRequest()
  // Frontend API calls:
  //   POST /agents/wechat-qr-code-agent/default/qr/fetch
  //   GET  /agents/wechat-qr-code-agent/default/qr/status?qrcode=xxx
  //   POST /agents/wechat-qr-code-agent/default/qr/verify-code
  routes: (app) =>
    app.get("/wechat/qr", async ({ request }) => {
      const assetUrl = new URL("/index.html", request.url);
      const htmlResponse = await env.ASSETS.fetch(assetUrl);
      return new HTMLRewriter()
        .on("div#version-badge", {
          element(e) {
            e.setInnerContent(`iLink 版本：${env.ILINK_CHANNEL_VERSION || "2.1.6"}`);
          }
        })
        .transform(htmlResponse);
    }),

  async init(env) {
    return {
      available: !!env.WECHAT_BOT_AGENT && !!env.WECHAT_QR_CODE_AGENT
    };
  },

  async sendMessage(env, msg) {
    // rawPlatformUserId 来自 Router（从 NormalizedMessage 直传或 IdentityMapper.reverse 产出）
    // WeChatBotAgent 内部通过 rawPlatformUserId 查 context_tokens 表获取账号凭证和 context_token
    const stub = await getAgentByName(env.WECHAT_BOT_AGENT, "default");
    const response = await stub.sendMessage({
      rawPlatformUserId: msg.rawPlatformUserId,
      text: msg.text,
      contextToken: msg.contextToken
    });
    return { success: response.ok, raw: response };
  }
});
