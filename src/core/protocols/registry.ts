import type { ProtocolId } from "../../shared/schema.ts";
import type { ProtocolSurface } from "./types.ts";

/**
 * 协议面注册表。
 *
 * 目标:新增一个面 = 加一个文件 + 注册一行,**不动**
 * 路由装配、鉴权、调度、重试、统计、UI。因此路由层只能通过本注册表
 * 发现有哪些面、各自监听哪些路径 —— 任何地方出现 `if (id === "chat")`
 * 这类分支,抽象就已经漏了。
 *
 * ## 为什么注册时就要做冲突检查
 *
 * 两个面若声明了同一个 `clientPaths` 条目,请求会被先注册者接走,
 * 而这**在测试里通常看不出来**:两个面的最小请求可能都能成功,
 * 只是其中一个悄悄走错了上游路径。等发现时症状是「某些模型偶尔报错」。
 * 所以路径冲突必须在启动期抛错,而不是留到运行期按注册顺序静默裁决。
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
      // 没有路径的面永远收不到请求 —— 那是个静默失效的注册。
      throw new ProtocolRegistryError(`协议面 ${surface.id} 未声明任何 clientPaths`);
    }

    /*
     * 面**内部**的重复路径也要拒。
     *
     * 只查 `#byPath`（别的面已占用的路径）的话,
     * `clientPaths: ["/x", "/x"]` 会被静默接受。本类的契约是"路径冲突必须在
     * 启动期抛错,而不是留到运行期静默裁决",而这正是它静默接受的一种冲突。
     */
    const seen = new Set<string>();

    for (const path of surface.clientPaths) {
      if (!path.startsWith("/")) {
        throw new ProtocolRegistryError(`协议面 ${surface.id} 的路径 ${path} 必须以 / 开头`);
      }

      /*
       * 拒绝永远匹配不到真实请求路径的形态。
       *
       * `?`/`#` 之后的部分不属于路径（Hono 匹配的是 pathname），空白字符
       * 同理不会出现在规范化后的请求路径里。注册这样的路径 = 注册一个
       * **静默失效的面**,与空 `clientPaths` 是同一类错误,所以同样拒掉。
       *
       * 这还有一层意义:`app.ts` 从 `registry.paths()` 推导
       * 鉴权中间件的挂载点。一条匹配不到的路径会同时让守卫与处理器都挂空,
       * 二者虽然仍然一致（不构成漏洞）,但"整个面无声消失"这种故障
       * 极难归因,不该被允许注册。
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
        // `//` 不是合法的请求路径形态,且不同 HTTP 栈对它的归一化不一致。
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

  /** 按客户端路径查找。路由层用它分派,因此不做前缀匹配 —— 精确匹配才可预测。 */
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
