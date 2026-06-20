import { defineChannel } from "../../framework/define-channel";

export default defineChannel({
  id: "wechat",
  name: "微信 (iLink)",
  description: "基于 iLink 协议的微信个人版 Bot",
  routes: (app) => app.get("/wechat", () => "hello world"),
});
