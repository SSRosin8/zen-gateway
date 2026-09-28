import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * 真正监听端口的测试必须向系统要端口（`helpers/freePort.ts` 或 `listen(0)`）。
 * 过去各文件手写固定端口段，段重叠或上一轮遗留进程占着端口时用例随机失败。
 * 判据：把固定数字交给 `ZG_PORT`、`listen(` 或 `useScriptSandbox(` 的写法。文件集取自 git（纪律 #12）。
 */

const ROOT = new URL("../..", import.meta.url).pathname;
const FORBIDDEN = [
  /ZG_PORT:\s*"\d+"/,
  /\.listen\(\s*[1-9]\d*/,
  /useScriptSandbox\(\s*\d/,
  /let nextPort\s*=\s*\d/,
];

function testFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", "tests"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(join(ROOT, f)));
}

describe("测试端口由系统分配", () => {
  it("没有测试把固定端口号交给监听方", () => {
    const files = testFiles().filter((f) => f !== "tests/unit/testPorts.test.ts");
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    let listeners = 0;
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      if (/\.listen\(|freePort\(/.test(text)) listeners += 1;
      for (const pattern of FORBIDDEN) if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
    }
    // 判据真的碰到了监听端口的文件，而不是在零个输入上通过。
    expect(listeners).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
