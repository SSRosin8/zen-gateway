import { createHash } from "node:crypto";

/**
 * 口令的稳定指纹,供缓存键使用(纪律 #4 的唯一来源)。
 *
 * 不用明文(键会进诊断输出),也不用长度(等长的新口令会复用旧缓存对象,鉴权永久失败)。
 * 取 sha256 前 12 位。消费者:`dispatcher.ts` 的代理口令与 `egress.ts` 的 Controller secret。
 * 不放 `src/shared/`:那里须浏览器可移植,这里要用 `node:crypto`。
 */
export function credentialFingerprint(secret: string): string {
  // 空与非空要能区分:「secret 没配」和「secret 配错了」是两种故障。
  if (secret === "") return "empty";
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}
