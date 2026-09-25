import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * 导出成员必须有引用 —— 登记了三轮、一直没建的那道关卡（缺口 #12）。
 *
 * ## 为什么必须是关卡而不是注释
 *
 * 此前的做法是**在源码里手写标注**「本方法当前没有生产调用点」。
 * 第八轮审核把全仓数了一遍，结论不是"数字变了"，而是**这种方式本身不成立**：
 *
 * - 一轮之内漂了两处：`catalog.status()` 与 `free.surfacesFor()` 都已经被
 *   Phase 9 接上，而标注还在说没有调用点 —— 其中一处还与 `contract.ts` 里
 *   "它此前没有生产读者"直接矛盾（同一事实两份副本）；
 * - 反方向也错：文档写"六个"，实际约三十个。
 *
 * "有没有读者"这件事的唯一真相只能是**调用点本身**（纪律 #4）。
 *
 * ## 这道关卡守的是什么
 *
 * **不是**"每个导出都必须有生产调用点" —— 那会逼人给用不上的东西硬造调用方，
 * 或者给它补一条假装它被用着的测试（那正是第八轮明确反对的）。
 *
 * 守的是**「完全没有任何引用」**：既没有生产调用点，也没有测试引用，
 * 而且不在白名单里。那种成员是真正的死代码 —— 它连"留着等下一阶段用"
 * 这个理由都没有，因为没人碰过它。
 *
 * 白名单里每一条都要写**为什么**留着。白名单本身就是那份"手写标注"，
 * 但它有两个关键不同：它在**一处**，而且关卡会在它过期时（成员被删掉、
 * 或终于有了引用）逼你更新它。
 */

const ROOT = new URL("../..", import.meta.url).pathname;

/** 扫描范围：三层核心代码。`admin/`（前端）由 tsc 的 noUnusedLocals 侧面覆盖。 */
const SCAN_DIRS = ["src/core", "src/store", "src/shared", "src/server"];

/**
 * 允许"零引用"的导出成员，以及**为什么**。
 *
 * 形如 `文件相对路径:成员名`。加进来之前先问：它真的该留着吗？
 */
const ALLOWED_UNREFERENCED: ReadonlyMap<string, string> = new Map([
  /*
   * **目前是空的** —— 那是件好事，不是忘了填。
   *
   * 建关卡时唯一的候选是 `chat.ts` 的 `looksLikeChatBody`（第八轮确认全仓
   * 零引用）。第一反应是把它加进白名单，但真去读它之后结论是**删掉**：
   * 它声称的职责（形状早退）已经由 `relay.ts` 第 2 步实际承担，
   * 而一个"看起来该用却没人用"的校验函数是个陷阱 —— 下一个人会以为
   * 请求体形状已经被它挡过一道。
   *
   * 这条经验值得留着：白名单的第一个候选往往其实该删。加进来之前先问
   * 「它声称的职责是不是已经有人在做了」。
   */
]);

type ExportedMember = { file: string; name: string; line: number };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/**
 * 找出一个文件里的导出成员。
 *
 * 刻意只认**顶层的 `export function` / `export const` / `export class`** ——
 * 不认 `export type`（类型没有运行期引用，`import type` 也常被省略）、
 * 不认 `export {}` 再导出（那是转出，真相在原始定义处）。
 * 宁可少认几个，也不要造一堆假阳性把关卡变成噪音。
 */
function exportsOf(file: string): ExportedMember[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const out: ExportedMember[] = [];
  text.split("\n").forEach((line, i) => {
    const m = /^export (?:async )?(?:function|const|class) ([A-Za-z_$][\w$]*)/.exec(line);
    if (m?.[1] !== undefined) out.push({ file, name: m[1], line: i + 1 });
  });
  return out;
}

/**
 * 全仓可能引用一个成员的文件（含 scripts/ 与 tests/）。
 *
 * **排除本文件自己** —— 白名单里写着成员名，于是它会把自己算成一个引用，
 * 让"仍然零引用"那条断言永远失败。这是写关卡时最容易踩的一种自指：
 * 关卡的输入集包含了关卡本身。
 */
const SELF = "tests/unit/exportsReferenced.test.ts";

function allSourceFiles(): string[] {
  return [...walk("src"), ...walk("tests"), ...walk("scripts")].filter((f) => f !== SELF);
}

describe("导出成员都有引用（缺口 #12 的关卡）", () => {
  const files = SCAN_DIRS.flatMap(walk);
  const members = files.flatMap(exportsOf);
  const haystack = allSourceFiles().map((f) => ({ file: f, text: readFileSync(join(ROOT, f), "utf8") }));

  it("扫到的导出成员数量合理 —— 关卡自己不能是空的", () => {
    /*
     * 这条防的是关卡失效：正则改坏、目录名写错、walk 抛了被吞掉，
     * 都会让下面那条断言在**零个成员**上通过（纪律 #1 的「输入集为空」）。
     */
    expect(members.length).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(20);
  });

  it("**没有零引用的导出成员**（白名单外）", () => {
    const orphans: string[] = [];
    /*
     * 数一数真的检查了多少个 —— 防的是"循环被跳过"那种失效。
     *
     * 变异测试逼出来的，而且逼了两次：
     *
     * 1. 把循环体第一行换成 `continue` → `orphans` 恒为空数组，断言照样绿。
     *    而"成员数量合理"那条只证明**扫到了**成员，不证明**检查过**它们
     *    —— 那是纪律 #1「输入集为空」的近亲：这里是"被检查的集合"为空。
     * 2. 第一版把 `checked += 1` 放在循环开头，于是
     *    `checked += 1; continue;` **仍然全绿** —— 计数对了而检查没做。
     *    所以它必须放在算完 `referenced` **之后**。
     */
    let checked = 0;

    for (const m of members) {
      if (ALLOWED_UNREFERENCED.has(`${m.file}:${m.name}`)) continue;

      /*
       * 「有引用」= 在**定义那一行之外**的任何地方出现过这个名字。
       *
       * ## 为什么是"定义行之外"而不是"定义文件之外"
       *
       * 第一版用的是后者，跑出来 31 个"零引用"，而其中绝大多数是**假阳性**：
       * `PortSchema`、`GatewaySchema`、`SubscriptionSchema` 这些都在
       * `schema.ts` **同一个文件里**被用来拼顶层的 `ConfigSchema` ——
       * 它们被引用得很充分，只是没跨文件。
       *
       * 那 31 个里真正的死代码只有一个（`looksLikeChatBody`），
       * 也就是第一版的信噪比是 1:30 —— 那种关卡会被人直接关掉。
       *
       * 用文本匹配而不是解析 AST：这道关卡要回答的是"有没有人提到它"，
       * 用 grep 的精度就够。宁可漏报（同名变量造成的假引用），
       * 也不要引入一个 TS 编译器 API 的依赖 —— 那会让关卡本身变成
       * 一块需要维护的代码。同名漏报只让关卡少抓一个，
       * 而假阳性会让整条关卡被关掉。
       */
      const pattern = new RegExp(`\\b${m.name}\\b`);
      const referenced = haystack.some((h) =>
        h.text
          .split("\n")
          .some((line, i) => !(h.file === m.file && i + 1 === m.line) && pattern.test(line)),
      );
      /*
       * 计数放在**算完 `referenced` 之后** —— 那是"真的查过"的唯一证据。
       *
       * 放在循环开头不行：`checked += 1; if (true) continue;` 会让计数正确
       * 而检查全被跳过（实测这个变异体在计数放开头时依然全绿）。
       * 计数必须与被计的那件事**在同一个执行点**上。
       */
      checked += 1;
      if (!referenced) orphans.push(`${m.file}:${m.line} ${m.name}`);
    }

    expect(
      orphans,
      `以下导出成员全仓零引用（既无生产调用点也无测试引用）。\n` +
        `要么删掉，要么加进 ALLOWED_UNREFERENCED 并写明为什么留着：\n` +
        orphans.map((o) => `  - ${o}`).join("\n"),
    ).toEqual([]);

    // 真的逐个查过 —— 见上面 `checked` 的说明。
    expect(checked).toBeGreaterThan(100);
    expect(checked).toBe(members.length - ALLOWED_UNREFERENCED.size);
  });

  it("白名单里的条目都还存在，且**仍然**零引用", () => {
    /*
     * 白名单也会过期，而过期的白名单比没有白名单更糟 ——
     * 它会静默放过一个已经变成死代码的成员（原成员被删、名字被复用），
     * 或者留着一条对"已经有读者了"的成员的豁免，让人以为它还没接上。
     *
     * 这正是第八轮那个教训的正面应用：手写标注必然漂，所以要有东西
     * 在它漂的时候喊一声。
     */
    for (const [key, why] of ALLOWED_UNREFERENCED) {
      const [file, name] = key.split(":");
      expect(why.length, `${key} 的豁免理由太短 —— 要写清为什么留着`).toBeGreaterThan(30);

      const found = members.find((m) => m.file === file && m.name === name);
      expect(found, `白名单条目 ${key} 已不存在（成员被删或改名？）—— 把它从白名单里去掉`).toBeDefined();

      const pattern = new RegExp(`\\b${name}\\b`);
      const referenced = haystack.some((h) =>
        h.text
          .split("\n")
          .some((line, i) => !(h.file === file && i + 1 === found!.line) && pattern.test(line)),
      );
      expect(
        referenced,
        `${key} 现在**已经有引用**了 —— 把它从 ALLOWED_UNREFERENCED 里删掉`,
      ).toBe(false);
    }
  });
});

/*
 * ## 为什么不顺手断言"每个导出都有**生产**调用点"
 *
 * 那是缺口 #12 原文的措辞，但它做不到而且不该做：
 *
 * - 约三十个成员只有测试引用（`Scheduler.snapshot`/`counts`/`prune`、
 *   `ClashController` 的四个查询方法、`registry.get`/`ids`/`size` 等）。
 *   它们中有些是**刻意**保留的诊断出口，有些确实是过度设计 ——
 *   但那是个逐个判断的设计问题，不是一条断言能表达的。
 * - 逼它们变绿只有两条路：硬造一个调用方（改产品行为去迁就关卡），
 *   或补一条假装它被用着的测试（第八轮明确反对的空壳）。
 *
 * 所以关卡守的是**"连一次引用都没有"**这个客观事实，
 * 而"有测试引用但没有生产读者"留给人判断 —— 那份判断记在
 * `docs/architecture.md` 的缺口清单里，且现在不再声称一个会漂的数字。
 */
