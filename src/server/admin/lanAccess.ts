import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isPrivateAddress } from "../middleware/loopbackOnly.ts";

/**
 * 局域网访问管理后台的口令与会话。
 *
 * 网关端口只监听 127.0.0.1；局域网设备经后台页面端口（`server/adminSite.ts`，设了口令时
 * 监听 0.0.0.0）进来，那里按真实对端打上局域网标记。局域网请求要先用口令登录换一个会话 cookie。口令只存 scrypt 哈希；改口令或清空后旧会话一律失效
 * （会话记着签发时的哈希）。
 *
 * 会话在进程内存里：网关重启后需要重新登录，这比把会话写盘更简单也更安全。
 */

const SCRYPT = { N: 16_384, r: 8, p: 1, keyLen: 32 } as const;

export function hashLanPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyLanPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const want = Buffer.from(expected, "base64url");
  let got: Buffer;
  try {
    got = scryptSync(password, Buffer.from(salt, "base64url"), want.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 会话 cookie 名。`HttpOnly` + `SameSite=Strict`：前端脚本读不到，跨站请求不带。 */
export const LAN_COOKIE = "zg_lan";

/** 会话有效期。 */
export const LAN_SESSION_MS = 12 * 3_600_000;

/** 连续失败这么多次后锁定；锁定时长从 1 分钟起倍增，上限 15 分钟。 */
const MAX_FAILURES = 5;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 15 * 60_000;

export type LoginOutcome =
  | { kind: "ok"; token: string }
  | { kind: "disabled" }
  | { kind: "bad_password" }
  | { kind: "locked"; retryAfterMs: number };

export class LanAccess {
  readonly #hashOf: () => string | null;
  readonly #now: () => number;
  readonly #sessions = new Map<string, { hash: string; expiresAt: number }>();
  #failures = 0;
  #lockedUntil = 0;
  #lockMs = LOCK_BASE_MS;

  constructor(hashOf: () => string | null, now: () => number = Date.now) {
    this.#hashOf = hashOf;
    this.#now = now;
  }

  enabled(): boolean {
    return this.#hashOf() !== null;
  }

  /**
   * 锁定是全局的而不是按来源：经 Vite 转发后所有局域网请求的对端都是回环，按来源限流无从区分；
   * 单用户工具里全局锁定的代价只是本人多等一会儿。
   */
  login(password: string): LoginOutcome {
    const hash = this.#hashOf();
    if (hash === null) return { kind: "disabled" };
    const now = this.#now();
    if (now < this.#lockedUntil) return { kind: "locked", retryAfterMs: this.#lockedUntil - now };

    if (!verifyLanPassword(password, hash)) {
      this.#failures += 1;
      if (this.#failures >= MAX_FAILURES) {
        this.#lockedUntil = now + this.#lockMs;
        this.#lockMs = Math.min(this.#lockMs * 2, LOCK_MAX_MS);
        this.#failures = 0;
        return { kind: "locked", retryAfterMs: this.#lockedUntil - now };
      }
      return { kind: "bad_password" };
    }

    this.#failures = 0;
    this.#lockMs = LOCK_BASE_MS;
    this.#prune(now);
    const token = randomBytes(32).toString("base64url");
    this.#sessions.set(token, { hash, expiresAt: now + LAN_SESSION_MS });
    return { kind: "ok", token };
  }

  /** 会话有效：存在、未过期、且签发时的口令哈希仍是当前哈希。 */
  valid(token: string | undefined): boolean {
    if (token === undefined || token === "") return false;
    const session = this.#sessions.get(token);
    if (session === undefined) return false;
    if (session.expiresAt <= this.#now() || session.hash !== this.#hashOf()) {
      this.#sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token !== undefined) this.#sessions.delete(token);
  }

  #prune(now: number): void {
    const hash = this.#hashOf();
    for (const [token, s] of this.#sessions) {
      if (s.expiresAt <= now || s.hash !== hash) this.#sessions.delete(token);
    }
  }
}

/** 本机的局域网 IPv4 地址，只列闸门会接受的私网段，供界面拼出可访问的地址。 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && isPrivateAddress(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}
