import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_LABEL } from "../../src/admin/lib/router.ts";

/*
 * 给用户看的指引（「到 X 页…」）里出现的页名必须是侧栏上现有的页。页面改名或合并后，
 * 旧名字散落在提示与错误信息里最难发现：读的人照着找不到那一页。
 * 只扫字符串字面量，不扫注释；判据来自 `PAGE_LABEL`，而不是另列一份名单。
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** 去掉注释后剩下的代码（含 JSX 文本与字符串）。只处理 `//` 行注释与块注释，足以区分说明与界面文字。 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("界面指引里的页名", () => {
  const files = [...sourceFiles("src/admin"), ...sourceFiles("src/server")];
  // 「其他页」是泛指，不是页名。
  const known = new Set([...Object.values(PAGE_LABEL), "其他"]);

  it("扫描范围非空", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("「在/到/去 X 页」里的 X 都是现有页面", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const file of files) {
      const code = withoutComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/[在到去或]([\p{Script=Han}A-Za-z]{1,6}?)页/gu)) {
        seen += 1;
        if (!known.has(m[1]!)) bad.push(`${file}: ${m[0]}`);
      }
    }
    // 判据的输入集要非空：至少有这几处指引。
    expect(seen).toBeGreaterThan(3);
    expect(bad).toEqual([]);
  });
});
