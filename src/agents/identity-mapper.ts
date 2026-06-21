/**
 * IdentityMapper Agent
 *
 * 身份映射系统——仅做 ID 替换。
 *
 * 职责边界：
 *   Inbound:  Channel Agent → resolve(platform, platformUserId) → internalUserId
 *   Outbound: Router → reverse(internalId) → { platform, platformUserId }
 *
 * IdentityMapper 不负责与身份 ID 无关的任何事情。
 * context_token、账号凭证等由各 Channel Agent 自行管理。
 */

import { Agent, callable } from "agents";

interface IdentityState {
  version: number;
}

interface UserMapping {
  internal_id: string;
  platform: string;
  platform_user_id: string;
  platform_chat_id: string | null;
  name: string | null;
  linked_ids: string; // JSON array
  created_at: number;
  last_active_at: number;
}

export class IdentityMapper extends Agent<Env, IdentityState> {
  initialState = { version: 1 };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS user_mappings (
      internal_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      platform_chat_id TEXT,
      name TEXT,
      linked_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    )`;
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_user
      ON user_mappings(platform, platform_user_id)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_internal
      ON user_mappings(internal_id)`;
  }

  /**
   * 解析平台用户 ID 为内部统一 ID
   * 如果不存在则自动创建新映射
   */
  @callable()
  async resolve(params: {
    platform: string;
    platformUserId: string;
    platformChatId?: string;
    name?: string;
  }): Promise<string> {
    const [existing] = this.sql<Pick<UserMapping, "internal_id" | "name">>`
      SELECT internal_id, name FROM user_mappings
      WHERE platform = ${params.platform} AND platform_user_id = ${params.platformUserId}
    `;

    if (existing) {
      // 更新最近活跃时间
      this.sql`UPDATE user_mappings SET last_active_at = ${Date.now()} WHERE internal_id = ${existing.internal_id}`;
      return existing.internal_id;
    }

    // 新建映射
    const internalId = crypto.randomUUID();
    this.sql`
      INSERT INTO user_mappings (internal_id, platform, platform_user_id, platform_chat_id, name, created_at, last_active_at)
      VALUES (${internalId}, ${params.platform}, ${params.platformUserId}, ${params.platformChatId ?? null}, ${params.name ?? null}, ${Date.now()}, ${Date.now()})
    `;
    return internalId;
  }

  /**
   * 关联两个平台的同一用户
   * 例如：用户同时绑定了微信和飞书
   */
  @callable()
  async link(internalIdA: string, internalIdB: string): Promise<void> {
    const [a] = this.sql<Pick<UserMapping, "linked_ids">>`
      SELECT linked_ids FROM user_mappings WHERE internal_id = ${internalIdA}
    `;
    const [b] = this.sql<Pick<UserMapping, "linked_ids">>`
      SELECT linked_ids FROM user_mappings WHERE internal_id = ${internalIdB}
    `;

    if (!a || !b) throw new Error("用户 ID 不存在");

    const linksA = new Set(JSON.parse(a.linked_ids));
    const linksB = new Set(JSON.parse(b.linked_ids));

    linksA.add(internalIdB);
    linksB.add(internalIdA);

    this.sql`UPDATE user_mappings SET linked_ids = ${JSON.stringify([...linksA])} WHERE internal_id = ${internalIdA}`;
    this.sql`UPDATE user_mappings SET linked_ids = ${JSON.stringify([...linksB])} WHERE internal_id = ${internalIdB}`;
  }

  /**
   * 出站：内部统一 ID → 平台用户 ID
   * 返回第一个匹配的平台映射
   */
  @callable()
  async reverse(internalId: string): Promise<{
    platform: string;
    platformUserId: string;
  }> {
    const [direct] = this.sql<Pick<UserMapping, "platform" | "platform_user_id">>`
      SELECT platform, platform_user_id FROM user_mappings WHERE internal_id = ${internalId}
    `;

    if (!direct) throw new Error("用户 ID 不存在");
    return { platform: direct.platform, platformUserId: direct.platform_user_id };
  }

  /**
   * 通过内部 ID 查询在所有平台上的映射
   */
  @callable()
  async getPlatformIds(internalId: string): Promise<UserMapping[]> {
    // 查询所有关联 ID
    const [direct] = this.sql<UserMapping>`
      SELECT * FROM user_mappings WHERE internal_id = ${internalId}
    `;

    if (!direct) return [];

    const linkedIds = JSON.parse(direct.linked_ids) as string[];
    if (linkedIds.length === 0) return [direct];

    // 查询所有关联平台的映射
    const placeholders = linkedIds.map(() => "?").join(",");
    const all = this.sql
      .exec<UserMapping>(`SELECT * FROM user_mappings WHERE internal_id IN (${placeholders})`, ...linkedIds)
      .toArray();

    return [direct, ...all];
  }
}
