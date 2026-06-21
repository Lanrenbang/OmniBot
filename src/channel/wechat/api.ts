import { env } from "cloudflare:workers";

const ILINK_APP_ID = "bot";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const uint32 = new DataView(buf.buffer).getUint32(0, false);
  return btoa(String(uint32));
}

export function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

export function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildClientVersion(env.ILINK_CHANNEL_VERSION ?? "2.1.6"))
  };
}

export function withUin(base: Record<string, string>, uin: string): Record<string, string> {
  return { ...base, "X-WECHAT-UIN": uin };
}

export function authHeaders(token: string, uin: string): Record<string, string> {
  return {
    ...commonHeaders(),
    "Content-Type": "application/json",
    "X-WECHAT-UIN": uin,
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`
  };
}
