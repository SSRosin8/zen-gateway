import { WORKER_CREATE_MAX, WorkerCreateSchema, type WorkerCreate } from "../../shared/contract.ts";
import type { WorkerKind } from "../../shared/schema.ts";

/**
 * 新建 Worker 的 id / 名称建议与校验。
 *
 * 规则从 `WorkerCreateSchema` 取（纪律 #4）：客户端先按同一份 schema 校验 id，
 * 错误直接指出规则；唯一性只有前端知道全部现有 id 时才能提前查，服务端仍会再判。
 */

const ID_SCHEMA = WorkerCreateSchema.shape.id;
/** 名称上限来自契约，不手抄数字。 */
export const WORKER_NAME_MAX = WorkerCreateSchema.shape.name.unwrap().maxLength ?? 200;
export { WORKER_CREATE_MAX };

const PREFIX: Record<WorkerKind, string> = { anonymous: "anon", authenticated: "auth" };
const NAME_PREFIX: Record<WorkerKind, string> = { anonymous: "匿名", authenticated: "认证" };

/**
 * 下一个空闲序号：`anon-N` 里比现有最大 N 大 1，而不是填空洞。
 * 填空洞会让刚删掉的 `anon-2` 被一个新 Worker 复用，统计里两者的历史会混在一起。
 */
export function nextIndex(existingIds: Iterable<string>, kind: WorkerKind): number {
  const pattern = new RegExp(`^${PREFIX[kind]}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const m = pattern.exec(id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function suggestWorker(existingIds: Iterable<string>, kind: WorkerKind): { id: string; name: string } {
  const n = nextIndex(existingIds, kind);
  return { id: `${PREFIX[kind]}-${n}`, name: `${NAME_PREFIX[kind]} ${n}` };
}

export function validateWorkerId(raw: string, existingIds: ReadonlySet<string>): string | null {
  const id = raw.trim();
  const parsed = ID_SCHEMA.safeParse(id);
  if (!parsed.success) {
    return id === "" ? "ID 不能为空" : "ID 只允许字母、数字与 . _ : -，长度 1 到 128";
  }
  if (existingIds.has(id)) return `ID ${id} 已被占用`;
  return null;
}

/** 按码点截断：名称里常有 emoji 旗帜，按 UTF-16 截会切出半个代理对。 */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/**
 * 节点名里的广告尾巴（`网址:xxx`、`官网 xxx`、裸域名、`|` 之后的备注）对区分 Worker 没有帮助，
 * 还会把机场域名带进 Worker 名称；去掉后剩下为空时保留原名。
 */
export function tidyNodeName(nodeName: string): string {
  const tidy = nodeName
    .replace(/(?:网址|官网|地址|域名)\s*[:：]?\s*\S+/gu, "")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/giu, "")
    .split(/\s*[|｜]\s*/u)[0]!
    .replace(/\s+/gu, " ")
    .trim();
  return tidy === "" ? nodeName.trim() : tidy;
}

export function bulkWorkerName(nodeName: string): string {
  return clip(`匿名 · ${tidyNodeName(nodeName)}`, WORKER_NAME_MAX);
}

/**
 * 为选中的节点生成一批匿名 Worker，id 接着现有 `anon-N` 编号。
 * 返回值直接进 `workers.create`，一次请求完成：逐条 PATCH 中途失败会留下半批。
 */
export function bulkAnonymousWorkers(
  existingIds: Iterable<string>,
  nodes: ReadonlyArray<{ id: string; name: string }>,
): WorkerCreate[] {
  let n = nextIndex(existingIds, "anonymous");
  return nodes.map((node) => ({
    id: `anon-${n++}`,
    name: bulkWorkerName(node.name === "" ? node.id : node.name),
    kind: "anonymous",
    apiKey: "",
    proxyId: node.id,
    enabled: true,
  }));
}
