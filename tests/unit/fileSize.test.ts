import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 单文件行数上限。文件集取自 git（已跟踪 + 未忽略的新文件），不用手写清单（纪律 #12）。
const ROOT = new URL("../..", import.meta.url).pathname;
const SOURCE_LIMIT = 800;
const TEST_LIMIT = 1000;

function trackedFiles(): string[] {
  const args = ["ls-files", "-z", "-co", "--exclude-standard", "--deduplicate", "--", "src", "scripts", "tests"];
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  // 工作区里已删除但索引仍在的文件不算。
  return out.split("\0").filter((f) => /\.(ts|tsx|mjs|css)$/.test(f) && existsSync(join(ROOT, f)));
}

function limitFor(file: string): number {
  return file.startsWith("tests/") ? TEST_LIMIT : SOURCE_LIMIT;
}

function lineCount(file: string): number {
  const text = readFileSync(join(ROOT, file), "utf8");
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

describe("单文件行数上限", () => {
  it(`源码 ≤ ${SOURCE_LIMIT} 行，测试 ≤ ${TEST_LIMIT} 行`, () => {
    const files = trackedFiles();
    // 输入集非空：git 调用或过滤条件改坏时不能在零个文件上通过。
    expect(files.length).toBeGreaterThan(150);
    expect(files.some((f) => f.startsWith("tests/"))).toBe(true);
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);

    const offenders: string[] = [];
    let checked = 0;
    for (const file of files) {
      const limit = limitFor(file);
      const lines = lineCount(file);
      if (lines > limit) offenders.push(`  - ${file}: ${lines} 行（上限 ${limit}）`);
      // 计数在判定之后，`continue` 不能绕过检查仍计数。
      checked += 1;
    }

    expect(
      offenders,
      `以下文件超过行数上限，请按职责拆分：\n${offenders.join("\n")}`,
    ).toEqual([]);
    expect(checked).toBe(files.length);
  });

  it("源码与测试各用自己的上限", () => {
    // 现有文件都不在 801–1000 行之间，缺这条时把源码误用测试上限不会被发现。
    expect(limitFor("src/server/routes/relay.ts")).toBe(SOURCE_LIMIT);
    expect(limitFor("scripts/doctor.mjs")).toBe(SOURCE_LIMIT);
    expect(limitFor("tests/integration/relay.test.ts")).toBe(TEST_LIMIT);
  });
});
