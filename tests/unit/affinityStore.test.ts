import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/store/db/open.ts";
import { AffinityStore } from "../../src/store/db/affinityStore.ts";
import { AffinityMap, digestOf } from "../../src/core/routing/affinity.ts";

let root: string;
let file: string;
let db: DatabaseSync;
let store: AffinityStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-aff-"));
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  file = join(root, "data", "runtime.db");
  db = openDb(file);
  store = new AffinityStore(db);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const TTL = 3_600_000;
const T0 = 1_790_000_000_000;
const always = (): boolean => true;

const h = (s: string): string => digestOf(s);

describe("落盘与恢复", () => {
  /*
   * 这一条就是整个特性的动机：重启后粘滞不该归零。
   *
   * 用两个独立的 `AffinityMap` 模拟重启 —— 第二个只通过 `restore()` 拿到
   * 第一个写下的东西，不共享任何内存。
   */
  it("重启后会话绑定仍然命中", () => {
    const before = new AffinityMap(store);
    before.bindSession(h("s1"), "w1", T0, TTL);

    const after = new AffinityMap(store);
    after.restore(store.loadSessions(T0 + 1), store.loadBlobs(T0 + 1));

    expect(after.lookupSession(h("s1"), T0 + 1, TTL, always)).toBe("w1");
  });

  it("重启后推理指纹仍然命中", () => {
    const before = new AffinityMap(store);
    before.learnBlobs([h("b1"), h("b2")], "w2", T0, TTL);

    const after = new AffinityMap(store);
    after.restore(store.loadSessions(T0 + 1), store.loadBlobs(T0 + 1));

    expect(after.findBlobWorker([h("b1"), h("b2")], T0 + 1, TTL, always)).toBe("w2");
  });

  it("重启后 TTL 继续从原始绑定时刻起算,不被刷新", () => {
    const before = new AffinityMap(store);
    before.bindSession(h("s1"), "w1", T0, TTL);

    const after = new AffinityMap(store);
    after.restore(store.loadSessions(T0 + 1), store.loadBlobs(T0 + 1));

    // 恰好在 TTL 内 → 命中。
    expect(after.lookupSession(h("s1"), T0 + TTL, TTL, always)).toBe("w1");

    const again = new AffinityMap(store);
    again.restore(store.loadSessions(T0 + 1), store.loadBlobs(T0 + 1));
    // 越过 TTL → 不命中。若 restore 把 at 重置成"现在"，这里会错误地命中。
    expect(again.lookupSession(h("s1"), T0 + TTL + 1, TTL, always)).toBeNull();
  });

  it("已过期的行不会被装回内存", () => {
    const before = new AffinityMap(store);
    before.bindSession(h("s1"), "w1", T0, TTL);

    // 读取时刻已越过 expires_at。
    const sessions = store.loadSessions(T0 + TTL + 1);
    expect(sessions).toHaveLength(0);
  });

  it("解绑会从库里删掉,重启不复活", () => {
    const map = new AffinityMap(store);
    map.bindSession(h("s1"), "w1", T0, TTL);
    map.unbindSession(h("s1"));

    expect(store.loadSessions(T0 + 1)).toHaveLength(0);
  });

  it("遗忘指纹会从库里删掉,重启不复活", () => {
    const map = new AffinityMap(store);
    map.learnBlobs([h("b1")], "w1", T0, TTL);
    map.forgetBlobs([h("b1")]);

    expect(store.loadBlobs(T0 + 1)).toHaveLength(0);
  });

  it("重新绑定到另一个 Worker 时库里也更新", () => {
    const map = new AffinityMap(store);
    map.bindSession(h("s1"), "w1", T0, TTL);
    map.bindSession(h("s1"), "w2", T0 + 10, TTL);

    const rows = store.loadSessions(T0 + 11);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workerId).toBe("w2");
  });
});

describe("装载顺序 = FIFO 淘汰顺序", () => {
  /*
   * `Map` 按插入顺序迭代，而 FIFO 淘汰淘的是最老的。若装载乱序，
   * 重启后「最老的那个」就不再是真的最老 —— 一个只在重启后出现、
   * 且完全不报错的行为偏差。所以 `loadSessions` 必须按 bound_at 升序。
   */
  it("loadSessions 按 bound_at 升序返回", () => {
    const map = new AffinityMap(store);
    // 刻意乱序写入。
    map.bindSession(h("mid"), "w", T0 + 50, TTL);
    map.bindSession(h("old"), "w", T0 + 10, TTL);
    map.bindSession(h("new"), "w", T0 + 90, TTL);

    expect(store.loadSessions(T0).map((r) => r.at)).toEqual([T0 + 10, T0 + 50, T0 + 90]);
  });

  it("loadBlobs 按 learned_at 升序返回", () => {
    const map = new AffinityMap(store);
    map.learnBlobs([h("b-mid")], "w", T0 + 50, TTL);
    map.learnBlobs([h("b-old")], "w", T0 + 10, TTL);

    expect(store.loadBlobs(T0).map((r) => r.at)).toEqual([T0 + 10, T0 + 50]);
  });
});

describe("内存淘汰要镜像到库 —— 否则被淘汰的条目重启后复活", () => {
  /*
   * `evict()` 的规则（先清过期、再 FIFO）是承重的，防「灌满表挤掉别人的
   * 活跃绑定」。若库不跟随淘汰，那些条目会在重启时回到内存并再次挤占容量 ——
   * 等于把那条防护在重启后撤销。
   *
   * 这里用会话表验（上限 10000），只需证明"被淘汰的键确实从库里消失"。
   */
  /*
   * 真的把会话表灌满来验 FIFO 淘汰。上限是 10000，所以这条会写 10001 条 ——
   * 慢一点（约几百毫秒）但它盖的是**只在容量满时才走的那条路径**，
   * 而那条路径正是防护所在。用 prune 代替它是不同的代码路径，
   * 会得到一条名字与内容不符的测试。
   */
  it("被 FIFO 淘汰的会话不在库里(真的灌满容量)", () => {
    const map = new AffinityMap(store);
    const CAP = 10_000;

    // 全部都在 TTL 内 → 第一轮清过期无所得，必然走到第二轮 FIFO。
    for (let i = 0; i <= CAP; i += 1) {
      map.bindSession(h(`s${i}`), "w", T0 + i, TTL);
    }

    // 内存被夹在上限内。
    expect(map.sizes().sessions).toBe(CAP);
    // 最老的那条（s0）被淘汰 —— 库里也必须没有它，
    // 否则重启会把它装回来并再次挤占容量。
    const hashes = new Set(store.loadSessions(T0).map((r) => r.hash));
    expect(hashes.has(h("s0"))).toBe(false);
    expect(hashes.has(h(`s${CAP}`))).toBe(true);
    expect(hashes.size).toBe(CAP);
  });

  it("prune 清掉的会话不在库里", () => {
    const map = new AffinityMap(store);
    map.bindSession(h("s1"), "w-gone", T0, TTL);
    map.bindSession(h("s2"), "w-live", T0, TTL);

    // w-gone 已从配置删除 → prune 应把它从内存与库里都清掉。
    map.prune(T0 + 1, TTL, (id) => id === "w-live");

    const rows = store.loadSessions(T0 + 1);
    expect(rows.map((r) => r.workerId)).toEqual(["w-live"]);
  });

  it("prune 清掉的指纹也不在库里", () => {
    const map = new AffinityMap(store);
    map.learnBlobs([h("b1")], "w-gone", T0, TTL);
    map.learnBlobs([h("b2")], "w-live", T0, TTL);

    map.prune(T0 + 1, TTL, (id) => id === "w-live");

    expect(store.loadBlobs(T0 + 1).map((r) => r.workerId)).toEqual(["w-live"]);
  });

  it("读到指向已删除 Worker 的绑定时,库里那行也被删掉", () => {
    const map = new AffinityMap(store);
    map.bindSession(h("s1"), "w-gone", T0, TTL);

    // lookupSession 就地删除失效条目 —— 库要跟着删，
    // 否则每次重启它都会复活一次。
    expect(map.lookupSession(h("s1"), T0 + 1, TTL, () => false)).toBeNull();
    expect(store.loadSessions(T0 + 1)).toHaveLength(0);
  });
});

describe("pruneExpired", () => {
  it("只删过期的,留下活着的", () => {
    const map = new AffinityMap(store);
    map.bindSession(h("old"), "w", T0, TTL);
    map.bindSession(h("fresh"), "w", T0 + TTL, TTL);
    map.learnBlobs([h("b-old")], "w", T0, TTL);

    const removed = store.pruneExpired(T0 + TTL + 1);
    expect(removed).toBe(2); // old 会话 + b-old 指纹

    const rows = store.loadSessions(T0 + TTL + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBe(h("fresh"));
  });
});

describe("schema 的 CHECK 是结构约束,不是约定", () => {
  /*
   * 两张表都 `CHECK(length=64 AND NOT GLOB '*[^0-9a-f]*')`，把「只存 sha256
   * 摘要」从注释变成结构约束。这里验它真的拦得住 —— 否则那句注释是假的。
   *
   * 写入失败会被 `#safe` 吞掉，所以断言的是「库里没有这一行」加
   * 「writeFailures 计了数」，而不是 expect(...).toThrow()。
   */
  it("原始文本进不去,且失败被计数", () => {
    const before = store.writeFailures().count;
    // 64 个 CJK 字符：长度看起来对，但字符集不对。
    store.putSession("一".repeat(64), "w1", T0, TTL);

    expect(store.loadSessions(T0)).toHaveLength(0);
    expect(store.writeFailures().count).toBe(before + 1);
  });

  it("长度不对的也进不去", () => {
    store.putBlobs(["abc"], "w1", T0, TTL);
    expect(store.loadBlobs(T0)).toHaveLength(0);
    expect(store.writeFailures().count).toBeGreaterThan(0);
  });

  it("合法的十六进制摘要能进去", () => {
    store.putSession(h("ok"), "w1", T0, TTL);
    expect(store.loadSessions(T0)).toHaveLength(1);
    expect(store.writeFailures().count).toBe(0);
  });
});

describe("写入失败不影响内存行为", () => {
  it("库关掉后绑定仍在内存生效,且不抛", () => {
    const map = new AffinityMap(store);
    db.close();

    expect(() => map.bindSession(h("s1"), "w1", T0, TTL)).not.toThrow();
    // 内存那份必须照常工作 —— 持久化只是可用性改善。
    expect(map.lookupSession(h("s1"), T0 + 1, TTL, always)).toBe("w1");
    expect(store.writeFailures().count).toBeGreaterThan(0);

    db = openDb(file);
  });
});

describe("不传 sink 时是纯内存", () => {
  it("不落盘,也不报错", () => {
    const map = new AffinityMap();
    map.bindSession(h("s1"), "w1", T0, TTL);
    expect(map.lookupSession(h("s1"), T0 + 1, TTL, always)).toBe("w1");
    // 库里什么都没有 —— 既有的全部单测走的正是这条路。
    expect(store.loadSessions(T0)).toHaveLength(0);
  });
});
