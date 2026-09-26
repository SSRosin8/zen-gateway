import { createHash } from "node:crypto";

/**
 * 口令的稳定指纹,供**缓存键**使用。
 *
 * 不能用明文(键会进诊断输出),也不能用长度 —— 等长口令会撞键,
 * 于是用户改掉一个「长度恰好相同的错口令」后仍会复用旧的缓存对象,
 * 鉴权永久失败且无从察觉。取 sha256 前 12 位:碰撞概率可忽略,
 * 且不可逆推原值。
 *
 * ## 为什么单独一个文件
 *
 * 这条规则有**两个**消费者:`dispatcher.ts` 的代理口令与 `egress.ts` 的
 * Controller secret。两处各写一遍就会出现同一个问题两种做法(例如一处写成
 * `apiSecret.length`,而另一处的注释正把它当反例)。
 * 抽出来是为了让\"缓存键怎么含凭证\"只有一个真相(纪律 #4):
 * 下一个需要它的地方 import 它,而不是照着邻居再写一遍。
 *
 * 不放进 `src/shared/`:那里必须浏览器可移植(被 admin 的 Vite 构建打包),
 * 而这里要用 `node:crypto`。
 */
export function credentialFingerprint(secret: string): string {
  // 空与非空要能区分:「secret 没配」和「secret 配错了」是两种故障。
  if (secret === "") return "empty";
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}
