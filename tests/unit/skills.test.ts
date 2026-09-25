import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PAGE_SIZE } from "../../src/admin/components/DataTable.tsx";

/*
 * Skill 文档的关卡（Phase 11）。
 *
 * ## 为什么 skill 也需要关卡
 *
 * 这四份文档的作用是**指导将来的改动** —— 一条过期的指导比没有指导更糟：
 * 它会让下一次改动建立在一个不成立的前提上，而读它的人没有理由怀疑它。
 *
 * 而它们恰好最容易漂：里面写满了具体数字（对比度、页长、端口）与
 * 具体符号名（`applyProbeResult`、`isUsable`、`PAGE_SIZE`）。
 * 第八轮审核的教训正是"手写的标注必然漂"，一轮之内漂了两处。
 *
 * 所以这里钉住**能自动核对的那部分**：
 *   1. frontmatter 齐全（否则 skill 根本不会被加载）；
 *   2. 引用的 npm 脚本真的存在（纪律 #7：文档里写的命令要真跑）；
 *   3. 引用的纪律编号在 `AGENTS.md` 里真的有定义（第八轮发现过引用 #11
 *      而那份文档只定义到 8）；
 *   4. 提到的源码符号真的还在（重命名后 skill 会指向一个不存在的东西）；
 *   5. 写进 skill 的几个关键常量与代码一致。
 *
 * 剩下的（那些实测的对比度数字、设计判断的理由）由 `tests/design/` 与
 * 各自的单测守着 —— 这里不重复断言它们，只保证**引用不悬空**。
 */

const SKILLS_DIR = new URL("../../.claude/skills", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;

const EXPECTED_SKILLS = ["dev-workflow", "ui-design", "protocol-surface", "debug-egress"] as const;

function skillText(name: string): string {
  return readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
}

describe("skill 文档齐全且格式正确", () => {
  it("四个 skill 都存在", () => {
    // 规划列的就是这四个。少一个意味着 Phase 11 没交付完。
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
  });

  for (const name of EXPECTED_SKILLS) {
    it(`${name} 的 frontmatter 有 name 与 description`, () => {
      /*
       * 没有 frontmatter 的 skill **不会被加载**，而那是静默的 ——
       * 文件在那儿、内容是对的，只是永远不生效。
       */
      const text = skillText(name);
      expect(text.startsWith("---\n")).toBe(true);
      const end = text.indexOf("\n---", 4);
      expect(end).toBeGreaterThan(0);
      const front = text.slice(4, end);

      expect(front).toMatch(/^name:\s*\S+/m);
      expect(front).toMatch(/^description:\s*\S+/m);
      // name 必须与目录名一致，否则调用时找不到。
      expect(front).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, "m"));
      /*
       * description 要足够长到能被"什么时候用它"判断出来。
       * 一句 "UI skill" 这种描述等于没有 —— 它不会在该触发的时候触发。
       */
      const description = /^description:\s*(.+)$/m.exec(front)?.[1] ?? "";
      expect(description.length).toBeGreaterThan(80);
    });
  }
});

describe("skill 里的引用不悬空", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  /** AGENTS.md 里真实定义了的纪律编号。 */
  const definedDisciplines = new Set(
    [...agents.matchAll(/^### (\d+)\./gm)].map((m) => Number(m[1])),
  );

  for (const name of EXPECTED_SKILLS) {
    it(`${name} 引用的 npm 脚本都存在`, () => {
      /*
       * 纪律 #7：文档里写的命令要真跑一遍。这里至少保证它**存在** ——
       * 一个 `npm run xxx` 打成错的 skill 会让读者以为自己环境坏了。
       */
      const text = skillText(name);
      const scripts = new Set(
        [...text.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]!),
      );
      for (const script of scripts) {
        expect(pkg.scripts[script], `${name} 引用了不存在的 npm run ${script}`).toBeDefined();
      }
      // `npm start` / `npm stop` 是内置形式，单独查。
      if (/npm start/.test(text)) expect(pkg.scripts.start).toBeDefined();
    });

    it(`${name} 引用的纪律编号在 AGENTS.md 里有定义`, () => {
      /*
       * 第八轮审核发现规划文档在引用「纪律 #11」，而 AGENTS.md 当时只定义到 8
       * —— 编号存在两套且已分叉。这条防止 skill 重蹈覆辙。
       */
      const text = skillText(name);
      const cited = [...text.matchAll(/纪律 #(\d+)/g)].map((m) => Number(m[1]));
      for (const n of cited) {
        expect(definedDisciplines.has(n), `${name} 引用了未定义的纪律 #${n}`).toBe(true);
      }
    });

    it(`${name} 提到的源码文件都存在`, () => {
      /*
       * skill 里会写 `core/proxy/clash/select.ts` 这类路径指路。
       * 文件被重命名后，那条指路会把人带到一个不存在的地方。
       */
      const text = skillText(name);
      const paths = new Set(
        [...text.matchAll(/`((?:src\/|scripts\/|tests\/)[\w./-]+\.(?:ts|tsx|mjs|css))`/g)].map(
          (m) => m[1]!,
        ),
      );
      for (const p of paths) {
        expect(existsSync(join(ROOT, p)), `${name} 提到的 ${p} 不存在`).toBe(true);
      }
    });
  }
});

describe("skill 里的关键常量与代码一致", () => {
  it("ui-design 写的页长与 `PAGE_SIZE` 一致", () => {
    /*
     * 这个数字与"行高 44px → 一屏约 12 行"是一套算术，而 skill 明确教读者
     * "改页长时这三个数要一起算"。它漂了的话那条教导本身就是错的。
     */
    const text = skillText("ui-design");
    expect(text).toContain(`PAGE_SIZE = ${PAGE_SIZE}`);
  });

  it("ui-design 写的行高与 token 一致", () => {
    const tokens = readFileSync(join(ROOT, "src/admin/styles/tokens.css"), "utf8");
    const rowHeight = /--spacing-row:\s*(\d+)px/.exec(tokens)?.[1];
    const textBase = /--text-base:\s*(\d+)px/.exec(tokens)?.[1];
    expect(rowHeight).toBeDefined();
    expect(textBase).toBeDefined();

    const text = skillText("ui-design");
    expect(text).toContain(`${rowHeight}px`);
    expect(text).toContain(`${textBase}px`);
  });

  it("debug-egress 写的 CA 症状是 502，不是空列表", () => {
    /*
     * 那条记录错过一次，而错的版本（"200 加空列表"）在三份文档里互相印证了
     * 一整个阶段，并成了 Phase 8 一整层诊断的设计依据（纪律 #11）。
     * 这条钉住它不再复活。
     */
    const text = skillText("debug-egress");
    expect(text).toContain("502");
    // 要么不提那个说法，要么明确标注它是**另一种**情况。
    if (text.includes("空列表")) {
      expect(text).toMatch(/另一种情况|不是[""]?200/);
    }
  });

  it("protocol-surface 列的七条不变量确实是七条", () => {
    const text = skillText("protocol-surface");
    const numbered = [...text.matchAll(/^\d+\. \*\*/gm)];
    expect(numbered.length).toBe(7);
  });
});
