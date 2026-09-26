import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";

const execFileAsync = promisify(execFile);
// 只在经 `npm test` 注入守卫时有意义；直接 `vitest run` 不注入，跳过而不是误报。
const guarded = (process.env.NODE_OPTIONS ?? "").includes("offlineGuard.mjs");

function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once("connect", () => { s.destroy(); resolve("connected"); });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
  });
}

describe.runIf(guarded)("测试离线守卫", () => {
  it("拒绝非回环地址", async () => {
    expect(await tryConnect("203.0.113.9", 443)).toBe("ZG_OFFLINE_GUARD");
    expect(await tryConnect("upstream.invalid", 443)).toBe("ZG_OFFLINE_GUARD");
  });

  it("放行回环与本机网卡地址（连不上是端口没人监听，不是守卫）", async () => {
    expect(await tryConnect("127.0.0.1", 1)).toBe("ECONNREFUSED");
  });

  it("子进程同样受约束", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      "require('net').connect({host:'203.0.113.9',port:443}).on('error',e=>console.log(e.code))",
    ]);
    expect(stdout.trim()).toBe("ZG_OFFLINE_GUARD");
  });
});
