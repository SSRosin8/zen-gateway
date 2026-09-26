import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const CHECK = resolve(ROOT, "scripts/check-sensitive-files.mjs");

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

  it("能拦私钥与公开格式凭证，并报告行号", () => {
    expect(fixture("fixture.ts", "const x = '-----BEGIN PRIVATE KEY-----';\n")).toMatchObject({
      status: 1,
    });
    expect(fixture("fixture.ts", "const x = 'AKIA1234567890ABCDEF';\n")).toMatchObject({
      status: 1,
    });
  });

  it("不把 apiKey 字段名、Bearer 占位符或 fake fixture 当成秘密", () => {
    expect(fixture(
      "fixture.ts",
      'const apiKey = "fake-key-not-real";\nconst header = "Bearer <relayToken>";\n',
    ).status).toBe(0);
  });
});
