import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error -- 纯 JS 脚本没有类型声明，这里只调用它的纯函数。
import { inspectText } from "../../scripts/check-sensitive-files.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const CHECK = resolve(ROOT, "scripts/check-sensitive-files.mjs");

/*
 * 会命中的样例一律用 `j()` 拼接构造：源码里不出现完整字面量，运行时才拼出扫描器
 * 要看的那一行。本文件在 SELF_FILES 里不走仓库扫描，最后一条 it 直接自检。
 */
const j = (...parts: string[]): string => parts.join("");

function fixture(path: string, text: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [CHECK, "--fixture-json"], {
      cwd: ROOT,
      input: JSON.stringify({ path, text }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { status: e.status ?? 1, output: e.stderr ?? "" };
  }
}

/** 断言命中且报告了指定类别与行号。 */
function expectHit(text: string, kind: string, path = "fixture.ts"): void {
  const r = fixture(path, `const ok = 1;\n${text}\n`);
  expect(r.status, text).toBe(1);
  expect(r.output).toContain(`${kind}：${path}:2`);
}

function expectClean(text: string, path = "fixture.ts"): void {
  const r = fixture(path, `${text}\n`);
  expect(r.status, `${text} → ${r.output}`).toBe(0);
}

describe("本地敏感文件关卡", () => {
  it("只拦高置信敏感路径，不拦普通源码与虚构 fixture", () => {
    expect(fixture("src/core/proxy/dispatcher.ts", "const ok = true;").status).toBe(0);
    expect(fixture("data/runtime.db", "not inspected").status).toBe(1);
    expect(fixture("config.backup", "not inspected").status).toBe(1);
    expect(fixture(".env.local", "not inspected").status).toBe(1);
    expect(fixture(".envrc.local", "not inspected").status).toBe(1);
    expect(fixture("opencode.jsonc", "not inspected").status).toBe(1);
    expect(fixture("data/runtime.db-wal", "not inspected").status).toBe(1);
    expect(fixture("ssh/id_ed25519", "not inspected").status).toBe(1);
    expect(fixture("backup.tar.gz", "not inspected").status).toBe(1);
    expect(fixture("keys/client.pem", "not inspected").status).toBe(1);
  });

  it("能拦私钥与公开格式凭证，并报告类别与行号", () => {
    const kind = "高置信凭证格式";
    expectHit(j("'-----BEGIN ", "PRIVATE KEY-----'"), kind);
    expectHit(j("'AK", "IA1234567890ABCDEF'"), kind);
    expectHit(j("'oc_", "sk_live_value_that_must_be_detected'"), kind);
    expectHit(j("'github", "_pat_", "11AAAAAAA0aaaaaaaaaaaa_bbbbbbbbbbbbbbbb'"), kind);
    expectHit(j("'xo", "xb-", "1234567890-abcdefghij'"), kind);
    expectHit(j("'ey", "JhbGciOiJIUzI1NiJ9.ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl'"), kind);
    expectHit(j("'sk-", "ant-", "api03-abcdefghijklmnopqrstuvwxyz'"), kind);
  });

  it("不把 apiKey 字段名、Bearer 占位符或 fake fixture 当成秘密", () => {
    expectClean('const apiKey = "fake-key-not-real";\nconst header = "Bearer <relayToken>";');
    // 短 token 与带虚构标记的长 token 都不报。
    expectClean('const h = "Bearer LEAKED-TOKEN-999";');
    expectClean('const h = "Bearer fake-key-good-egress-not-real-0123456789";');
    // 普通 JWT 前缀字样（不含第二段）不报。
    expectClean('const note = "eyJ is base64 for {";');
  });

  it("能拦长 Bearer 字面量", () => {
    expectHit(j('"Bear', 'er ', "Zq8Xk2mN4pR7sT1vW3yB5dF6gH9jL0cA"), "Bearer 凭证字面量");
  });

  it("个人主目录路径：真实名字报告，通用占位名放行", () => {
    expectHit(j("const p = '/ho", "me/zhangsan/work';"), "个人主目录路径");
    expectHit(j("const p = '/Us", "ers/lisi/Library';"), "个人主目录路径");
    expectClean("const p = '/home/someone/.config';");
    expectClean("const p = '/Users/username/x';");
  });

  it("邮箱：私人邮箱报告，noreply 与保留域放行", () => {
    expectHit(j("author: zhangsan", "@", "gmail.com"), "非占位邮箱");
    expectHit(j("contact ops", "@", "corp-internal.cn"), "非占位邮箱");
    expectClean("Co-Authored-By: Claude <noreply@anthropic.com>");
    expectClean("12345+someone@users.noreply.github.com");
    expectClean("socks5://user:pw@proxy.invalid:1080");
    expectClean("mail admin@example.com or admin@mail.example.org");
  });

  it("IPv4：公网地址报告，文档段、回环与规则示例放行", () => {
    expectHit(j("egress = '4", "5.76.1", "2.34'"), "非保留 IPv4 地址");
    // 私网地址在源码与文档里不带 CIDR 时也报（多半是本机网络信息）。
    expectHit(j("dns answered 1", "72.20.", "3.4"), "非保留 IPv4 地址", "docs/usage.md");
    expectClean("203.0.113.9 198.51.100.1 192.0.2.10 127.0.0.1 0.0.0.0");
    expectClean("IPCIDR,10.0.0.0/8,DIRECT and 172.16.0.0/12", "docs/usage.md");
    expectClean(j("dnsA: ['10.", "20.30.40']"), "tests/integration/doctor.test.ts");
    // 测试目录不整段放行：未登记的私网地址同样要报。
    expectHit(j("host: '10.", "44.55.66'"), "非保留 IPv4 地址", "tests/integration/any.test.ts");
    // 解析器负例（越界、前导零）不是地址。
    expectClean("'256.1.1.1' '010.1.1.1' '1.2.3.04'");
    // 按文件放行只对那个文件生效。
    expectClean(j("'128.", "0.0.1'"), "tests/unit/middleware.test.ts");
    expectHit(j("'128.", "0.0.1'"), "非保留 IPv4 地址", "tests/unit/other.test.ts");
  });

  it("机场节点名：国旗 + 线路标记 + 真实域名才报", () => {
    const flag = "\u{1F1ED}\u{1F1F0}";
    expectHit(j(flag, " 香港 IP", "LC 01 官网:real-airport.com"), "疑似真实节点名");
    expectClean(j(flag, " 示例节点 IPLC VIP2 网址:example.invalid"));
    expectClean(j(flag, " 香港 IPLC 专线"));
    expectClean(j("expect(r.nodes[0]!.name).toBe('", flag, " 香港  IPLC 专线');"));
  });

  it("只豁免上游重验使用的精确虚构 oc_sk_ key", () => {
    const fake = j("oc_", "sk_0000_obviously_fake_not_a_real_key");
    const live = j("oc_", "sk_live_value_that_must_be_detected");
    expectClean(`const x = '${fake}';`);
    expect(fixture("fixture.ts", `const x = '${fake}'; const y = '${live}';\n`).status).toBe(1);
  });

  it("本文件自身不含会被扫描命中的字面量", () => {
    const self = readFileSync(resolve(ROOT, "tests/unit/sensitiveFiles.test.ts"), "utf8");
    expect(inspectText("tests/unit/sensitiveFiles.test.ts", self)).toEqual([]);
  });
});
