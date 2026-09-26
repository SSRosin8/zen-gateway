import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeApp, makeConfig } from "../integration/helpers/adminFixture.ts";

/*
 * `docs/usage.md` 的管理 API 表是端点清单的唯一维护处。判据从装配好的 app 的路由表取
 * （纪律 #12：不用被检查的清单证明自己完整），双向比对：漏写与写了不存在的都失败。
 */

const USAGE_MD = fileURLToPath(new URL("../../docs/usage.md", import.meta.url));

function documented(): Set<string> {
  const text = readFileSync(USAGE_MD, "utf8");
  const section = text.slice(text.indexOf("## 管理 API"), text.indexOf("## 诊断和故障排查"));
  const out = new Set<string>();
  for (const m of section.matchAll(/^\| `(GET|POST|PATCH|PUT|DELETE) (\/api\/[^`?\s]*)[^`]*` \|/gm)) {
    out.add(`${m[1]} ${m[2]}`);
  }
  return out;
}

function registered(): Set<string> {
  const { app } = makeApp(makeConfig());
  return new Set(
    app.routes
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/"))
      .map((r) => `${r.method} ${r.path}`),
  );
}

describe("管理 API 文档与路由一致", () => {
  it("usage.md 的端点表恰好列出全部已注册的管理路由", () => {
    const docs = documented();
    const routes = registered();
    // 输入集非空：正则或章节标题改坏时不能在零条上通过。
    expect(docs.size).toBeGreaterThan(10);
    expect(routes.size).toBeGreaterThan(10);
    expect([...routes].filter((r) => !docs.has(r)), "路由存在但文档没写").toEqual([]);
    expect([...docs].filter((r) => !routes.has(r)), "文档写了但路由不存在").toEqual([]);
  });
});
