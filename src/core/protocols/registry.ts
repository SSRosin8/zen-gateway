import type { ProtocolId } from "../../shared/schema.ts";
import type { ProtocolSurface } from "./types.ts";

/**
 * 协议面注册表。新增一个面 = 加一个文件 + 注册一行；路由层只能经此发现面与路径，
 * 出现 `if (id === "chat")` 这类分支即抽象泄漏。
 * 路径冲突在启动期抛错：否则先注册者静默接走请求，另一个面悄悄走错上游路径。
 */
export class ProtocolRegistryError extends Error {
  override readonly name = "ProtocolRegistryError";
}

export class ProtocolRegistry {
  #byId = new Map<ProtocolId, ProtocolSurface>();
  #byPath = new Map<string, ProtocolSurface>();

  /** 注册一个面。路径或 id 冲突立即抛错。 */
  register(surface: ProtocolSurface): this {
    if (this.#byId.has(surface.id)) {
      throw new ProtocolRegistryError(`协议面 ${surface.id} 已注册`);
    }
    if (surface.clientPaths.length === 0) {
      // 没有路径的面永远收不到请求。
      throw new ProtocolRegistryError(`协议面 ${surface.id} 未声明任何 clientPaths`);
    }

    // 面内部的重复路径同样是冲突。
    const seen = new Set<string>();

    for (const path of surface.clientPaths) {
      if (!path.startsWith("/")) {
        throw new ProtocolRegistryError(`协议面 ${surface.id} 的路径 ${path} 必须以 / 开头`);
      }

      /*
       * 拒绝永远匹配不到请求 pathname 的形态（含 ?/#/空白）：否则整个面连同
       * `app.ts` 据 `registry.paths()` 挂的鉴权守卫一起无声挂空，极难归因。
       */
      if (/[?#]/.test(path)) {
        throw new ProtocolRegistryError(
          `协议面 ${surface.id} 的路径 ${path} 含 ? 或 #,永远匹配不到请求路径`,
        );
      }
      if (/\s/.test(path)) {
        throw new ProtocolRegistryError(`协议面 ${surface.id} 的路径 ${path} 含空白字符`);
      }
      if (path.includes("//")) {
        // 不同 HTTP 栈对 `//` 的归一化不一致。
        throw new ProtocolRegistryError(`协议面 ${surface.id} 的路径 ${path} 含连续斜杠`);
      }

      if (seen.has(path)) {
        throw new ProtocolRegistryError(`协议面 ${surface.id} 自身重复声明了路径 ${path}`);
      }
      seen.add(path);

      const existing = this.#byPath.get(path);
      if (existing) {
        throw new ProtocolRegistryError(
          `路径 ${path} 已被协议面 ${existing.id} 占用,与 ${surface.id} 冲突`,
        );
      }
    }

    this.#byId.set(surface.id, surface);
    for (const path of surface.clientPaths) this.#byPath.set(path, surface);
    return this;
  }

  get(id: ProtocolId): ProtocolSurface | null {
    return this.#byId.get(id) ?? null;
  }

  /** 按客户端路径精确查找（不做前缀匹配，才可预测）。 */
  byPath(path: string): ProtocolSurface | null {
    return this.#byPath.get(path) ?? null;
  }

  /** 所有已注册路径,供路由装配时批量挂载。 */
  paths(): string[] {
    return [...this.#byPath.keys()];
  }

  ids(): ProtocolId[] {
    return [...this.#byId.keys()];
  }

  get size(): number {
    return this.#byId.size;
  }
}
