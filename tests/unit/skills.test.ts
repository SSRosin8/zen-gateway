import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { PAGE_SIZE } from "../../src/admin/components/DataTable.tsx";

/*
 * Skill 文档的关卡。
 *
 * ## 为什么 skill 也需要关卡
 *
 * 这四份文档的作用是**指导将来的改动** —— 一条过期的指导比没有指导更糟：
 * 它会让下一次改动建立在一个不成立的前提上，而读它的人没有理由怀疑它。
 *
 * 而它们恰好最容易漂：里面写满了具体数字（对比度、页长、端口）与
 * 具体符号名（`applyProbeResult`、`isUsable`、`PAGE_SIZE`）。
 * 手写的标注必然漂，这类引用尤其如此。
 *
 * 所以这里钉住**能自动核对的那部分**：
 *   1. frontmatter 齐全（否则 skill 根本不会被加载）；
 *   2. 引用的 npm 脚本真的存在（纪律 #7：文档里写的命令要真跑）；
 *   3. 引用的纪律编号在 `AGENTS.md` 里真的有定义（编号曾出现两套并分叉，
 *      引用过只存在于另一套里的编号）；
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

/**
 * 仓库里全部源码文件的路径（相对 ROOT）。
 *
 * 供两条关卡用：裸文件名按 basename 解析、符号名在拼起来的正文里查。
 * 两者刻意共用一次遍历 —— 分别遍历会让"扫了哪些目录"存两份（纪律 #4）。
 */
const SCAN_DIRS = ["src", "scripts", "tests"] as const;

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSources(rel));
    else if (/\.(ts|tsx|mjs|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const sourceFiles = SCAN_DIRS.flatMap(walkSources);
/** 文件名解析用全部目录 —— skill 里会提 `service.test.ts` 这类测试文件。 */
const basenames = new Set(sourceFiles.map((f) => basename(f)));

/**
 * 符号查找的正文 —— **只看 `src/` 与 `scripts/`，且排除本文件**。
 *
 * 两条排除各有理由：
 *
 * - 不看 `tests/`：一个只存在于测试里的名字不算"产品代码里有这个符号"，
 *   而 skill 是指路用的。
 * - 排除本文件：这里的注释举了 `applyProbeResultGONE` 当反例，于是关卡会把
 *   **自己的注释**当成符号来源 —— 那个变异因此存活过一次。
 *   `exportsReferenced.test.ts` 用 `SELF` 排除自己，同一个理由。
 */
const SELF = "tests/unit/skills.test.ts";
const sourceHaystack = ["src", "scripts"]
  .flatMap(walkSources)
  .filter((f) => f !== SELF)
  .map((f) => readFileSync(join(ROOT, f), "utf8"))
  .join("\n");

/** 四个 skill 引用过的全部纪律编号 —— 供整组的元断言用。 */
const citedAcrossSkills: number[] = [];

describe("skill 文档齐全且格式正确", () => {
  it("四个 skill 都存在", () => {
    // 固定就是这四个：少一个是 skill 被误删，多一个是新增后没登记到 EXPECTED_SKILLS。
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
      /*
       * 字符类要含**连字符**：`[a-z:]+` 会把
       * `npm run build-nonexistent` 截成 `build`（存在）→ 静默通过。
       * 末尾的 `\b` 防止把更长的名字截短后误判成存在的前缀。
       */
      const scripts = new Set(
        [...text.matchAll(/npm run ([a-z][a-z:-]*)\b/g)].map((m) => m[1]!),
      );
      for (const script of scripts) {
        expect(pkg.scripts[script], `${name} 引用了不存在的 npm run ${script}`).toBeDefined();
      }
      // `npm start` / `npm stop` 是内置形式，单独查。
      if (/npm start/.test(text)) expect(pkg.scripts.start).toBeDefined();
    });

    it(`${name} 引用的纪律编号在 AGENTS.md 里有定义`, () => {
      /*
       * 防止 skill 引用 AGENTS.md 里不存在的纪律编号（编号曾出现两套并分叉，
       * 文档引用了只存在于另一套里的编号）。
       */
      const text = skillText(name);
      /*
       * 先抓「纪律 #...」整段再从里面抽全部编号：
       * `/纪律 #(\d+)/g` 对 `纪律 #8/#4` 只拿到 8 —— 而
       * `dev-workflow/SKILL.md` 正在用这个写法，只抽首个编号会让 `#4`
       * 这类后续编号逃过检查。
       */
      const cited = [...text.matchAll(/纪律 #\d+(?:\s*[/、]\s*#\d+)*/g)].flatMap((m) =>
        [...m[0].matchAll(/#(\d+)/g)].map((x) => Number(x[1])),
      );
      // 逐个 skill 不要求必须引用纪律（ui-design / protocol-surface 讲的是别的）。
      // 整组的"确实抓到了引用"那条元断言在本 describe 之后单独一条。
      citedAcrossSkills.push(...cited);
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
      /*
       * **裸文件名也要检查**。若正则要求 `src/`/`scripts/`/
       * `tests/` 前缀，四个 skill 里带前缀的引用只占极少数，
       * 其余都是 `` `clash/select.ts` ``、`` `pipe.ts` ``、`` `retry.ts` ``
       * 这类裸名 —— 全部在视野外，改坏它们全绿。那是「输入集为空」的形态。
       *
       * 裸名按 basename 在仓库里解析：唯一命中就算存在，命中多个也算
       * （skill 里写裸名本就是"读者自己找得到"的意思），零命中才算失实。
       */
      const refs = new Set(
        [...text.matchAll(/`([\w./-]+\.(?:ts|tsx|mjs|css))`/g)].map((m) => m[1]!),
      );

      // 关卡自己不能是空的：正则改坏、围栏语法变了都会让下面在零个引用上通过。
      expect(refs.size, `${name} 一个源码文件都没提到？正则可能改坏了`).toBeGreaterThan(0);

      const missing: string[] = [];
      let checked = 0;
      for (const ref of refs) {
        const ok = ref.includes("/") && existsSync(join(ROOT, ref)) ? true : basenames.has(basename(ref));
        if (!ok) missing.push(ref);
        // 算在判定之后 —— 放在循环开头的话 `continue` 也能让计数对上而检查没做。
        checked += 1;
      }

      expect(checked).toBe(refs.size);
      expect(missing, `${name} 提到的这些文件在仓库里找不到`).toEqual([]);
    });

    it(`${name} 提到的源码符号都存在`, () => {
      /*
       * 本文件头声称「提到的源码符号真的还在（重命名后 skill 会指向一个
       * 不存在的东西）」，这条 it 就是它的实现 —— 只有路径检查时，
       * 把 skill 里的 `applyProbeResult` 改成 `applyProbeResultGONE` 会全绿。
       * 那是「注释声称的覆盖 > 实际覆盖」，即给自己写假的强保证。
       *
       * 判据：反引号里形如标识符的词（含 `Xxx.yyy()` 的两段形式），
       * 在 `src/` + `scripts/` 的源码里必须出现过。刻意只认**看起来像符号**
       * 的（驼峰、或全大写下划线），不认普通英文单词与中文 —— 否则会把
       * 散文里的词也当符号查。
       */
      const text = skillText(name);
      const candidates = new Set<string>();
      for (const m of text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\(\))?`/g)) {
        const raw = m[1]!;
        // 取最后一段：`ModelCatalog.status` → 查 `status` 也能命中定义处。
        const parts = raw.split(".");
        for (const part of parts) {
          const looksLikeSymbol = /[a-z][A-Z]/.test(part) || /^[A-Z][a-z]/.test(part) || /^[A-Z0-9_]{4,}$/.test(part);
          if (looksLikeSymbol && part.length >= 4) candidates.add(part);
        }
      }

      // 关卡自己不能是空的。
      expect(candidates.size, `${name} 一个符号都没提到？正则可能改坏了`).toBeGreaterThan(3);

      const missing: string[] = [];
      let checked = 0;
      for (const sym of candidates) {
        if (!sourceHaystack.includes(sym)) missing.push(sym);
        checked += 1;
      }

      expect(checked).toBe(candidates.size);
      expect(missing, `${name} 提到的这些符号在源码里找不到`).toEqual([]);
    });
  }

  it("**整组确实抓到了纪律引用** —— 否则上面那条在空集上通过", () => {
    /*
     * 逐个 skill 不要求必须引用纪律：`ui-design` 与 `protocol-surface`
     * 讲的是设计与协议面，本来就一条都不引（实测 0 / 0，而 `dev-workflow` 5、
     * `debug-egress` 1）。所以元断言只能落在整组上。
     *
     * 这条防的是纪律正则改坏：那时四个 skill 全部抓到 0 条，
     * 「引用的编号都有定义」会在空集上静默通过。
     */
    expect(citedAcrossSkills.length).toBeGreaterThan(3);
    // 顺带钉住那个多编号写法真的被展开了（`纪律 #8/#4` 要抓到两个）。
    expect(citedAcrossSkills).toContain(4);
    expect(citedAcrossSkills).toContain(8);
  });
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
     * 很久，并成了一整层诊断的设计依据（纪律 #11）。
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
