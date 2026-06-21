/**
 * channel-manager.ts
 * Channel 管理系统——自动化 wrangler.jsonc 的 channel 绑定管理和 src/channel/index.ts 的自动生成。
 *
 * bun run channel:add <name>       — 注册 channel（合并 wrangler 配置 + 更新 channel/index.ts）
 * bun run channel:remove <name>    — 注销 channel（移除 wrangler 条目 + 更新 channel/index.ts）
 * bun run channel:sync             — 全量重建 wrangler.jsonc channel 字段（扫描现有 channel/）
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { parse as parseJSONC, modify as modifyJSONC, applyEdits, type ModificationOptions } from "jsonc-parser";

// ─── 类型定义 ───────────────────────────────────────────────────────────

interface ChannelWrangler {
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
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
  kv_namespaces?: Array<{ binding: string; id: string }>;
  vars?: Record<string, string | number | boolean>;
}

interface ChannelModule {
  default: { id: string; wrangler?: ChannelWrangler };
}

// ─── 常量 ───────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..");
const CHANNEL_DIR = join(ROOT, "src/channel");
const CHANNEL_INDEX_PATH = join(CHANNEL_DIR, "index.ts");
const WRANGLER_PATH = join(ROOT, "wrangler.jsonc");

const JSONC_OPTS: ModificationOptions = {
  formattingOptions: {
    insertSpaces: true,
    tabSize: 2,
    eol: "\n"
  }
};

// ─── JSONC 读写 ─────────────────────────────────────────────────────────

function readRawWrangler(): string {
  return readFileSync(WRANGLER_PATH, "utf-8");
}

function parseWrangler(): any {
  return parseJSONC(readRawWrangler());
}

function modifyWrangler(text: string, path: (string | number)[], value: any): string {
  const edits = modifyJSONC(text, path, value, JSONC_OPTS);
  return applyEdits(text, edits);
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────

function mergeArray<T>(target: T[], source: T[], key: keyof T): T[] {
  const seen = new Set(target.map((item) => String(item[key])));
  for (const item of source) {
    if (!seen.has(String(item[key]))) {
      target.push(item);
      seen.add(String(item[key]));
    }
  }
  return target;
}

function removeArray<T>(target: T[], source: T[], key: keyof T): T[] {
  const removeKeys = new Set(source.map((item) => String(item[key])));
  return target.filter((item) => !removeKeys.has(String(item[key])));
}

function checkMigrationConflict(existingMigrations: any[], newMigrations: any[], channelName: string): void {
  for (const newMig of newMigrations) {
    const conflict = existingMigrations.find((m: any) => m.tag === newMig.tag);
    if (conflict) {
      console.error(
        `❌ Migration tag "${newMig.tag}" 冲突！\n` +
          `   channel "${channelName}" 使用的 migration tag 与现有配置重复。\n` +
          `   请为 channel "${channelName}" 使用独特的前缀，如 "${channelName}-v1"。\n` +
          `   如需强制覆盖，请手动编辑 wrangler.jsonc 后重试。`
      );
      process.exit(1);
    }
  }
}

function generateNextMigrationTag(existingMigrations: any[], channelName: string): string {
  let maxNum = 0;
  for (const m of existingMigrations) {
    const match = m.tag?.match(/v(\d+)/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `v${maxNum + 1}-remove-${channelName}`;
}

/**
 * 加载 channel 的 wrangler 配置。
 *
 * 读取策略（按优先级）：
 *   1. wrangler.json（推荐）— 脚本环境友好，无运行时依赖
 *   2. index.ts 的 defineWrangler()（备用）— 需要解析 TypeScript
 *
 * 方案 1 优先，因为 index.ts 中可能引用 cloudflare:workers 等仅在
 * Workers 运行时可用的模块，导致脚本环境的动态 import 失败。
 */
async function loadChannelWrangler(name: string): Promise<ChannelWrangler | null> {
  const channelDir = join(CHANNEL_DIR, name);
  if (!existsSync(channelDir)) return null;

  // 优先读取 wrangler.json 文件
  const jsonPath = join(channelDir, "wrangler.json");
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch {
      return null;
    }
  }

  // 备用：尝试动态 import（可能在脚本环境中因 cloudflare:workers 等模块失败）
  const indexPath = join(channelDir, "index.ts");
  if (!existsSync(indexPath)) return null;
  try {
    const mod: ChannelModule = await import(indexPath);
    return mod.default.wrangler ?? null;
  } catch {
    return null;
  }
}

function scanChannels(): string[] {
  if (!existsSync(CHANNEL_DIR)) return [];
  return readdirSync(CHANNEL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CHANNEL_DIR, d.name, "index.ts")))
    .map((d) => d.name);
}

function toKebabCase(pascal: string): string {
  // Handle consecutive uppercase (e.g. "QRCode" → "QR-Code" → "qr-code")
  return pascal
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * 生成 src/channel/index.ts（自动导入所有 channel 的 barrel 文件）
 */
async function generateChannelIndex(): Promise<void> {
  const channelNames = scanChannels();

  if (!existsSync(CHANNEL_DIR)) {
    // CHANNEL_DIR 已存在，不处理
  }

  const imports = channelNames.map((name) => `import ${name} from "./${name}/index";`).join("\n");

  const channelsExport =
    channelNames.length > 0
      ? `export const channels = [\n  ${channelNames.join(",\n  ")},\n];`
      : "export const channels: any[] = [];";

  // Agent/DO 导出
  //
  // ⚠️ 不使用动态 import()（会因 cloudflare:workers 等运行时模块无法在脚本环境解析而失败）。
  // 改为直接从 channel 的 index.ts 源码中扫描 `export { ClassName } from "./path"` 语句。
  // 每个 channel 应在其 index.ts 中显式 re-export 所有 Agent/DO 类。
  //
  // 例如 wechat/index.ts 中应有：
  //   export { WeChatBotAgent } from "./bot-agent";
  //   export { WeChatQRCodeAgent } from "./qr-agent";
  const agentExports: string[] = [];
  const agentExportRegex = /export\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["']/g;
  for (const name of channelNames) {
    const indexPath = join(CHANNEL_DIR, name, "index.ts");
    if (!existsSync(indexPath)) continue;

    const source = readFileSync(indexPath, "utf-8");
    let match: RegExpExecArray | null;
    while ((match = agentExportRegex.exec(source)) !== null) {
      const identifiers = match[1]!.split(",").map((s: string) => s.trim());
      const importPath = match[2]!;
      // Only include exports that look like Agent/DO classes (PascalCase)
      const normalizedPath = importPath.startsWith("./") ? importPath.slice(2) : importPath;
      for (const id of identifiers) {
        if (/^[A-Z]/.test(id)) {
          agentExports.push(`export { ${id} } from "./${name}/${normalizedPath}";`);
        }
      }
    }
  }

  const agentExportBlock =
    agentExports.length > 0
      ? `\n// ─── Agent/DO 类导出（供 wrangler 发现 DO） ──────────\n${agentExports.join("\n")}\n`
      : "";

  const content = `// ⚠️ 此文件由 channel-manager 自动生成，请勿手动编辑
// 运行 bun run channel:sync 重新生成
// channel 注册 + Agent/DO 导出均由脚本管理

${imports}

${channelsExport}${agentExportBlock}
`;

  writeFileSync(CHANNEL_INDEX_PATH, content, "utf-8");
  console.log(
    `✅ src/channel/index.ts 已生成（${channelNames.length} 个 channel，${agentExports.length} 个 Agent 导出）`
  );
}

function regenerateTypes() {
  try {
    execSync("bun run types", { cwd: ROOT, stdio: "inherit" });
    console.log("✅ 类型定义已更新");
  } catch {
    console.warn("⚠️ 类型定义更新失败，请手动执行 bun run types");
  }
}

// ─── addChannel ─────────────────────────────────────────────────────────

async function addChannel(name: string) {
  const w = await loadChannelWrangler(name);
  if (!w) {
    console.error(`❌ channel "${name}" 未找到或未包含 wrangler 配置`);
    process.exit(1);
  }

  const config = parseWrangler();
  let text = readRawWrangler();

  if (w.migrations && Array.isArray(w.migrations) && config.migrations) {
    checkMigrationConflict(config.migrations, w.migrations, name);
  }

  if (w.durable_objects?.bindings) {
    const existing = config.durable_objects?.bindings ?? [];
    const merged = mergeArray([...existing], w.durable_objects.bindings, "name");
    text = modifyWrangler(text, ["durable_objects", "bindings"], merged);
  }

  if (w.migrations) {
    const existing = config.migrations ?? [];
    const merged = mergeArray([...existing], w.migrations, "tag");
    text = modifyWrangler(text, ["migrations"], merged);
  }

  if (w.d1_databases) {
    const existing = config.d1_databases ?? [];
    const merged = mergeArray([...existing], w.d1_databases, "binding");
    text = modifyWrangler(text, ["d1_databases"], merged);
  }

  if (w.kv_namespaces) {
    const existing = config.kv_namespaces ?? [];
    const merged = mergeArray([...existing], w.kv_namespaces, "binding");
    text = modifyWrangler(text, ["kv_namespaces"], merged);
  }

  if (w.vars) {
    const existing = config.vars ?? {};
    const merged = { ...existing, ...w.vars };
    text = modifyWrangler(text, ["vars"], merged);
  }

  writeFileSync(WRANGLER_PATH, text, "utf-8");
  console.log(`✅ channel "${name}" wrangler 配置已合并`);

  await generateChannelIndex();
  regenerateTypes();
}

// ─── removeChannel ──────────────────────────────────────────────────────

async function removeChannel(name: string) {
  const w = await loadChannelWrangler(name);
  if (!w) {
    console.error(`❌ channel "${name}" 未找到或未包含 wrangler 配置`);
    process.exit(1);
  }

  const config = parseWrangler();
  let text = readRawWrangler();

  let removedBindings: Array<{ name: string; class_name: string }> = [];
  if (w.durable_objects?.bindings && config.durable_objects?.bindings) {
    const remaining = removeArray(config.durable_objects.bindings, w.durable_objects.bindings, "name");
    removedBindings = config.durable_objects.bindings.filter(
      (b: any) => !remaining.find((r: any) => r.name === b.name)
    );

    if (remaining.length > 0) {
      text = modifyWrangler(text, ["durable_objects", "bindings"], remaining);
    } else {
      text = modifyWrangler(text, ["durable_objects"], undefined);
    }
  }

  const deletedClassNames = removedBindings.map((b) => b.class_name);
  if (deletedClassNames.length > 0) {
    const tag = generateNextMigrationTag(config.migrations ?? [], name);
    const deletedEntry = { tag, deleted_classes: deletedClassNames };
    const existing = config.migrations ?? [];
    const merged = [...existing, deletedEntry];
    text = modifyWrangler(text, ["migrations"], merged);

    console.warn(
      `\n⚠️  正在为 channel "${name}" 生成 DO 删除迁移\n` +
        `  Migration tag: ${tag}\n` +
        `  被删除的 class: ${deletedClassNames.join(", ")}\n` +
        `  部署后将永久删除上述 class 的所有 DO 实例及其持久化数据！\n`
    );
  }

  if (w.d1_databases && config.d1_databases) {
    const remaining = removeArray(config.d1_databases, w.d1_databases, "binding");
    if (remaining.length > 0) {
      text = modifyWrangler(text, ["d1_databases"], remaining);
    } else {
      text = modifyWrangler(text, ["d1_databases"], undefined);
    }
  }

  if (w.kv_namespaces && config.kv_namespaces) {
    const remaining = removeArray(config.kv_namespaces, w.kv_namespaces, "binding");
    if (remaining.length > 0) {
      text = modifyWrangler(text, ["kv_namespaces"], remaining);
    } else {
      text = modifyWrangler(text, ["kv_namespaces"], undefined);
    }
  }

  if (w.vars && config.vars) {
    const remaining = { ...config.vars };
    for (const key of Object.keys(w.vars)) {
      delete remaining[key];
    }
    if (Object.keys(remaining).length > 0) {
      text = modifyWrangler(text, ["vars"], remaining);
    } else {
      text = modifyWrangler(text, ["vars"], undefined);
    }
  }

  writeFileSync(WRANGLER_PATH, text, "utf-8");
  console.log(`✅ channel "${name}" wrangler 配置已移除`);

  await generateChannelIndex();
  regenerateTypes();
}

// ─── syncWrangler ───────────────────────────────────────────────────────

// Framework-level bindings that are manually maintained and should NOT
// be removed by channel:sync (e.g. IDENTITY_MAPPER, framework core DOs)
const FRAMEWORK_DO_BINDINGS: Array<{ name: string; class_name: string }> = [
  { name: "IDENTITY_MAPPER", class_name: "IdentityMapper" }
];

const FRAMEWORK_MIGRATIONS: Array<{
  tag: string;
  new_sqlite_classes?: string[];
}> = [{ tag: "v1-identity-mapper", new_sqlite_classes: ["IdentityMapper"] }];

async function syncWrangler() {
  const channels = scanChannels();
  let text = readRawWrangler();

  const allBindings: Array<{ name: string; class_name: string }> = [];
  const allMigrations: Array<{
    tag: string;
    new_sqlite_classes?: string[];
    new_classes?: string[];
    deleted_classes?: string[];
  }> = [];
  const allD1: Array<{
    binding: string;
    database_name: string;
    database_id: string;
  }> = [];
  const allKV: Array<{ binding: string; id: string }> = [];
  const allVars: Record<string, any> = {};

  // Start with framework-level bindings, then merge channel bindings on top
  mergeArray(allBindings, FRAMEWORK_DO_BINDINGS, "name");
  mergeArray(allMigrations, FRAMEWORK_MIGRATIONS, "tag");

  for (const name of channels) {
    const w = await loadChannelWrangler(name);
    if (!w) continue;

    if (w.durable_objects?.bindings) {
      mergeArray(allBindings, w.durable_objects.bindings, "name");
    }
    if (w.migrations) {
      mergeArray(allMigrations, w.migrations, "tag");
    }
    if (w.d1_databases) {
      mergeArray(allD1, w.d1_databases, "binding");
    }
    if (w.kv_namespaces) {
      mergeArray(allKV, w.kv_namespaces, "binding");
    }
    if (w.vars) {
      Object.assign(allVars, w.vars);
    }
  }

  if (allBindings.length > 0) {
    text = modifyWrangler(text, ["durable_objects", "bindings"], allBindings);
  } else {
    text = modifyWrangler(text, ["durable_objects"], undefined);
  }

  if (allMigrations.length > 0) {
    text = modifyWrangler(text, ["migrations"], allMigrations);
  } else {
    text = modifyWrangler(text, ["migrations"], undefined);
  }

  if (allD1.length > 0) {
    text = modifyWrangler(text, ["d1_databases"], allD1);
  } else {
    text = modifyWrangler(text, ["d1_databases"], undefined);
  }

  if (allKV.length > 0) {
    text = modifyWrangler(text, ["kv_namespaces"], allKV);
  } else {
    text = modifyWrangler(text, ["kv_namespaces"], undefined);
  }

  if (Object.keys(allVars).length > 0) {
    text = modifyWrangler(text, ["vars"], allVars);
  } else {
    text = modifyWrangler(text, ["vars"], undefined);
  }

  writeFileSync(WRANGLER_PATH, text, "utf-8");
  console.log(`✅ wrangler.jsonc 全量重建完成（${channels.length} 个 channel）`);

  await generateChannelIndex();
  regenerateTypes();
}

// ─── 主命令分发 ─────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];
  const name = process.argv[3];

  switch (command) {
    case "add":
      if (!name) {
        console.error("Usage: channel:add <name>");
        process.exit(1);
      }
      await addChannel(name);
      break;
    case "remove":
      if (!name) {
        console.error("Usage: channel:remove <name>");
        process.exit(1);
      }
      await removeChannel(name);
      break;
    case "sync":
      await syncWrangler();
      break;
    default:
      console.log("Commands: add <name>, remove <name>, sync");
  }
}

main().catch(console.error);
