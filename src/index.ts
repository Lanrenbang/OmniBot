import { WorkerEntrypoint } from "cloudflare:workers";
import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { routeAgentRequest } from "agents";
import { env } from "cloudflare:workers";
import { channelManager } from "./framework/channel-manager";
import { channels } from "./channel";

// 间接 re-export src/channel/index.ts 中的 Agent/DO 类，供 wrangler DO 发现
// 已验证（见 references/framework-plan/08-self-binding-test.md）：export * 间接链可被 wrangler 正确识别
export * from "./channel";

// ═══════════════════════════════════════════════════════════════════════
// Named Entrypoints（自我服务绑定 RPC 端点）
// DO/Agent 通过 wrangler.jsonc 中的 services 绑定调用这些方法，
// 替代原先的 HTTP 自投递方案。
// ═══════════════════════════════════════════════════════════════════════

export class RouterEntrypoint extends WorkerEntrypoint {
  async routeMessage(msg: any): Promise<void> {
    console.log(`[Router] routeMessage: ${JSON.stringify(msg)}`);
  }

  async scheduleNotification(
    convId: string,
    when: Date,
    payload: any,
  ): Promise<void> {
    console.log(`[Router] 安排通知: ${convId} @ ${when.toISOString()}`);
  }

  async broadcastEvent(channel: string, event: any): Promise<void> {
    console.log(`[Router] 广播事件: ${channel}`);
  }
}

export class AdminEntrypoint extends WorkerEntrypoint {
  async getStats(): Promise<{ channels: number; messages: number }> {
    return { channels: 0, messages: 0 };
  }

  async reloadChannel(name: string): Promise<boolean> {
    console.log(`[Admin] 重载 channel: ${name}`);
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Elysia HTTP 路由（外部请求入口）
// ═══════════════════════════════════════════════════════════════════════

// 使用 CloudflareAdapter + .compile() 是 Elysia 在 CF Workers 上的必要条件
const app = new Elysia({ adapter: CloudflareAdapter }).onError(
  ({ code, error }) => {
    console.error(`[Elysia] ${code}: ${error}`);
    return new Response("Internal Error", { status: 500 });
  },
);

// ⚠️ 必须在 .compile() 之前注册所有频道路由！
//    Elysia 的 AoT 编译（.compile()）会冻结路由表，之后 app.use() 不会生效。
//    installRoutes 在模块加载时同步执行（此时 env 还未就绪），只注册路由结构。
channelManager.installRoutes(app);

// AoT 编译——编译后路由表已冻结，返回 fetch 可用的 app 实例
app.compile();

// 首次请求时延迟初始化（env 已可用）
let initPromise: Promise<void> | null = null;
async function ensureInit(env: Env) {
  if (!initPromise) {
    initPromise = channelManager.initChannels(env);
  }
  return initPromise;
}

// 默认入口——外部 HTTP 请求 + 内部 Agent 路由
// 继承 WorkerEntrypoint 使 Main Worker 可通过自我服务绑定暴露 RPC 方法
export default class MainWorker extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    // 1. Agent 路由优先（WebSocket 连接、DO 内部 RPC 等）
    const agentResponse = await routeAgentRequest(request, this.env);
    if (agentResponse) return agentResponse;

    // 2. 首次请求时延迟初始化 channel（env 检测）
    await ensureInit(this.env);

    // 3. 回退到 Elysia 路由
    return app.fetch(request);
  }
}
