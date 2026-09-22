import { describe, expect, it } from "vitest";
import { isIP } from "node:net";
import { canonicalizeIp, isIpAddress } from "../../src/shared/ip.ts";

/*
 * 这组测试拿 `node:net.isIP` 当**权威基准**做对照。
 *
 * 由来:`src/shared/ip.ts` 不能 import `node:net` —— 它被 schema.ts 依赖,
 * 而 schema 会被管理后台的浏览器包打进去。于是校验必须用可移植实现,
 * 而可移植实现很容易写错:第一版手写的 IPv6 分支在 20 万次结构化模糊测试下
 * 跑出 2653 处分歧,全是放得太宽(`":::"`、`"1:::2"`、`"abcd::ffff:"`、
 * `"1::0:"`、`"0:::1"`)。一个被劫持的回显服务返回 `"::"` 就能变成一条
 * 「出口 IP」记录,而垃圾值各自成组会让隔离报告**误报已隔离**。
 *
 * 测试跑在 Node 里,所以这里可以用 isIP 当答案 —— 生产代码不行。
 */

/** 手写版曾经放过或错拒的形态,逐个钉住。 */
const REGRESSION_CASES = [
  // 手写版放过的:尾随/连续冒号
  ":",
  "::",
  ":::",
  "0:0",
  "ab:cd",
  "abcde::1",
  "12345:12345:1:1:1:1",
  "1:::2",
  "abcd::ffff:",
  "1::0:",
  "0:::1",
  "1::2::3",
  "12345::",
  "g::1",
  // 手写版错拒的:IPv4-mapped 与 zone id
  "::ffff:1.2.3.4",
  "fe80::1%eth0",
  "::ffff:0:1.2.3.4",
  "64:ff9b::1.2.3.4",
  "0:0:0:0:0:ffff:1.2.3.4",
  // 常规合法形态
  "1.2.3.4",
  "0.0.0.0",
  "255.255.255.255",
  "2001:db8::1",
  "2001:0db8:0000:0000:0000:0000:0000:0001",
  "2001:db8:0:0:0:0:0:1",
  "2001:DB8::1",
  "::1",
  "1::",
  "1::2",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:1.2.3.4",
  "::1.2.3.4",
  "fff::",
  // 常规非法形态
  "",
  "1.2.3",
  "1.2.3.4.5",
  "256.1.1.1",
  "010.1.1.1",
  "1.2.3.04",
  "1:2:3:4:5:6:7:8:9",
  "1:2:3:4:5:6:7",
  "::1:2:3:4:5:6:7:8",
  "1.2.3.4::",
  // 空白与非 ASCII 数字
  " 1.2.3.4",
  "1.2.3.4 ",
  "1.2.3.4\n",
  "١.٢.٣.٤",
  // zone id 规则
  "%eth0",
  "fe80::1%",
  "fe80::1%0",
  "fe80::1%a%b",
  "fe80::1%e t",
  "fe80::1%.",
  "fe80::1%-x",
  // 其他垃圾
  "<html>err</html>",
  "not-an-ip",
  "192.0.2.1:8080",
  "192.0.2.0/24",
  "example.invalid",
] as const;

describe("isIpAddress 与 node:net.isIP 一致", () => {
  it.each(REGRESSION_CASES)("%j", (value) => {
    expect(isIpAddress(value)).toBe(isIP(value) !== 0);
  });

  it("超长输入被拒", () => {
    expect(isIpAddress("1".repeat(100))).toBe(false);
  });
});

describe("模糊对照 node:net.isIP", () => {
  /** 可复现的伪随机数发生器 —— 失败时能重跑同一组输入。 */
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it("随机字符串 20000 条无分歧", () => {
    const rand = makeRandom(0xc0ffee);
    const alphabet = "0123456789abcdefABCDEF:.%gxz ";
    const mismatches: string[] = [];

    for (let i = 0; i < 20_000; i += 1) {
      const len = 1 + Math.floor(rand() * 22);
      let s = "";
      for (let j = 0; j < len; j += 1) s += alphabet[Math.floor(rand() * alphabet.length)];
      if (isIpAddress(s) !== (isIP(s) !== 0)) mismatches.push(s);
    }

    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("按真实组件拼装的地址 20000 条无分歧", () => {
    // 结构化模糊比纯随机更容易命中边界 —— 手写版的 2653 处分歧就是这样找到的。
    const rand = makeRandom(0xbadf00d);
    const groups = ["0", "1", "ffff", "abcd", "12345", "", "g"];
    const mismatches: string[] = [];

    for (let i = 0; i < 20_000; i += 1) {
      const n = 1 + Math.floor(rand() * 9);
      const parts = Array.from({ length: n }, () => groups[Math.floor(rand() * groups.length)]!);
      let s = parts.join(":");
      if (rand() < 0.3) s = s.replace(":", "::");
      if (rand() < 0.15) s += ".1.2.3.4".slice(0, 8);
      if (rand() < 0.1) s += "%eth0";
      if (isIpAddress(s) !== (isIP(s) !== 0)) mismatches.push(s);
    }

    expect(mismatches.slice(0, 10)).toEqual([]);
  });
});

describe("canonicalizeIp", () => {
  it("同一 IPv6 地址的不同写法归一到同一字符串", () => {
    /*
     * 这是隔离判定的前提:四个回显服务各自格式化 IPv6 的方式不同,而探测会
     * 在它们之间自由回退。不规范化就会把同一地址分成两组 → 误报已隔离。
     */
    const forms = ["2001:db8:0:0:0:0:0:1", "2001:DB8::1", "2001:0db8::0001", "2001:db8::1"];
    const canonical = forms.map(canonicalizeIp);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe("2001:db8::1");
  });

  it("IPv4 只有一种写法,原样返回", () => {
    expect(canonicalizeIp("192.0.2.1")).toBe("192.0.2.1");
  });

  it("IPv4-mapped 归一到十六进制形态", () => {
    expect(canonicalizeIp("::ffff:1.2.3.4")).toBe("::ffff:102:304");
  });

  it("保留 zone id", () => {
    // 不同网卡上的同一链路本地地址是不同出口,不能归一掉。
    expect(canonicalizeIp("fe80::1%eth0")).toBe("fe80::1%eth0");
    expect(canonicalizeIp("fe80::1%eth0")).not.toBe(canonicalizeIp("fe80::1%wlan0"));
  });

  it("非法输入不抛错", () => {
    expect(() => canonicalizeIp("<html>")).not.toThrow();
    expect(() => canonicalizeIp("")).not.toThrow();
  });
});
