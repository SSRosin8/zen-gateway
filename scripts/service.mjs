#!/usr/bin/env node
/**
 * 单命令启停。
 *
 * PID 文件判活用 `process.kill(pid, 0)` + 一次 /health 探测两道:
 * 单靠 PID 存活会被 PID 复用骗到(旧进程已退出,同号被别的进程占用),
 * 单靠 /health 又无法区分「我们启的实例」和「用户手工启的实例」。
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const PID_FILE = join(DATA_DIR, "zen-gateway.pid");
const LOG_FILE = join(DATA_DIR, "zen-gateway.log");
const ENTRY = join(ROOT, "dist", "server", "server", "index.js");

const PORT = Number(process.env.ZG_PORT ?? 9876);
const BASE = `http://127.0.0.1:${PORT}`;

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeHealth(timeoutMs = 1000) {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

async function readPid() {
  try {
    const raw = await readFile(PID_FILE, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 返回 { pid, healthy } —— 并顺手清掉陈旧 PID 文件。 */
async function inspect() {
  const pid = await readPid();
  const alive = pid !== null && pidAlive(pid);
  if (pid !== null && !alive) await rm(PID_FILE, { force: true });
  const health = await probeHealth();
  return { pid: alive ? pid : null, healthy: health !== null, health };
}

async function start() {
  const state = await inspect();
  if (state.pid !== null && state.healthy) {
    console.log(`已在运行(pid ${state.pid}) → ${BASE}`);
    return 0;
  }
  if (state.healthy) {
    console.error(`端口 ${PORT} 上已有别的 zen-gateway 实例在响应,但不是本脚本启动的。`);
    console.error("先 npm stop 或手工结束该进程,避免两个实例抢同一份 data/。");
    return 1;
  }

  if (!existsSync(ENTRY)) {
    console.error(`未找到 ${ENTRY},先 npm run build`);
    return 1;
  }

  // data/ 存凭证与 runtime.db,只对当前用户开放。
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });

  const { openSync } = await import("node:fs");
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  await writeFile(PID_FILE, String(child.pid), { mode: 0o600 });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await probeHealth();
    if (health) {
      console.log(`zen-gateway 已启动(pid ${child.pid}) → ${BASE}`);
      return 0;
    }
    if (!pidAlive(child.pid)) {
      console.error(`进程已退出,日志见 ${LOG_FILE}`);
      await rm(PID_FILE, { force: true });
      return 1;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }

  console.error(`启动后 ${HEALTH_TIMEOUT_MS / 1000}s 内未通过健康检查,日志见 ${LOG_FILE}`);
  return 1;
}

async function stop() {
  const pid = await readPid();
  if (pid === null || !pidAlive(pid)) {
    await rm(PID_FILE, { force: true });
    console.log("未在运行");
    return 0;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      await rm(PID_FILE, { force: true });
      console.log(`已停止(pid ${pid})`);
      return 0;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }

  console.error(`pid ${pid} 在 ${STOP_TIMEOUT_MS / 1000}s 内未响应 SIGTERM,未强杀。`);
  console.error(`如确认可强杀:kill -9 ${pid}`);
  return 1;
}

async function status() {
  const state = await inspect();
  if (state.pid === null && !state.healthy) {
    console.log("未在运行");
    return 1;
  }
  if (state.healthy) {
    const owner = state.pid === null ? "外部启动" : `pid ${state.pid}`;
    console.log(`运行中(${owner}) · v${state.health.version} · 已运行 ${state.health.uptimeSeconds}s → ${BASE}`);
    return 0;
  }
  console.log(`进程存活(pid ${state.pid})但健康检查未通过,日志见 ${LOG_FILE}`);
  return 1;
}

const cmd = process.argv[2] ?? "status";
const actions = {
  start,
  stop,
  status,
  restart: async () => {
    await stop();
    return start();
  },
};

const action = actions[cmd];
if (!action) {
  console.error(`未知命令:${cmd}(可用:${Object.keys(actions).join(" / ")})`);
  process.exit(2);
}
process.exit(await action());
