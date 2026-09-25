import { describe, expect, it } from "vitest";
import { PAGES, PAGE_LABEL, parseHash, toHash } from "../../src/admin/lib/router.ts";

/*
 * URL 是视图状态的**唯一来源**。
 *
 * 这是**新增能力，不是继承** —— 旧项目没有深链接，页面状态存在内存里，
 * 刷新即丢。所以这组测试钉的是「往返之后视图不变」这条性质。
 */

describe("hash 解析与序列化", () => {
  it("空 hash 回落到 overview", () => {
    expect(parseHash("")).toMatchObject({ page: "overview", q: "", page_: 1 });
    expect(parseHash("#")).toMatchObject({ page: "overview" });
  });

  it("未知页面回落到 overview 而不是空白页", () => {
    /*
     * URL 是用户可编辑的，所以打错是常态。回落到第一页是他能理解的结果，
     * 而一个空白页会让他以为程序坏了。
     */
    expect(parseHash("#nope").page).toBe("overview");
    expect(parseHash("#../etc/passwd").page).toBe("overview");
  });

  it("六个页面都能解析", () => {
    for (const page of PAGES) {
      expect(parseHash(`#${page}`).page).toBe(page);
    }
  });

  it("解析全部视图状态", () => {
    const view = parseHash("#proxy?tab=isolation&q=hk&status=ready&sort=latency&page=2");
    expect(view).toEqual({
      page: "proxy",
      tab: "isolation",
      q: "hk",
      status: "ready",
      sort: "latency",
      page_: 2,
    });
  });

  it("非法页码回落到 1（URL 是用户可编辑的）", () => {
    expect(parseHash("#proxy?page=abc").page_).toBe(1);
    expect(parseHash("#proxy?page=-3").page_).toBe(1);
    expect(parseHash("#proxy?page=0").page_).toBe(1);
    expect(parseHash("#proxy?page=1.5").page_).toBe(1);
  });

  it("序列化**只写非默认值**", () => {
    /*
     * 否则 `#overview?tab=&q=&page=1` 这种噪音会出现在每一个链接里，
     * 而用户要复制分享的正是这个字符串。
     */
    expect(toHash(parseHash("#overview"))).toBe("#overview");
    expect(toHash(parseHash("#proxy?page=1"))).toBe("#proxy");
    expect(toHash(parseHash("#proxy?q="))).toBe("#proxy");
  });

  it("往返无损 —— 刷新与分享还原同一视图", () => {
    const cases = [
      "#overview",
      "#proxy?tab=isolation",
      "#workers?q=w1&status=ready",
      "#models?q=free&page=3",
      "#usage",
      "#gateway",
    ];
    for (const hash of cases) {
      // 这条性质是深链接的全部意义:解析再序列化必须回到原样。
      expect(toHash(parseHash(hash))).toBe(hash);
    }
  });

  it("每个页面都有中文标签（本项目只维护中文）", () => {
    for (const page of PAGES) {
      expect(PAGE_LABEL[page]).toBeTruthy();
      // 不能是 id 本身 —— 那说明忘了写标签。
      expect(PAGE_LABEL[page]).not.toBe(page);
    }
  });

  it("搜索词里的特殊字符能安全往返", () => {
    // 搜索节点名时会输入 emoji 与空格（实测节点名形如 `🇺🇲 AA5美国2 IPLC`）。
    const view = { ...parseHash("#proxy"), q: "🇺🇲 美国 & 日本" };
    expect(parseHash(toHash(view)).q).toBe("🇺🇲 美国 & 日本");
  });
});
