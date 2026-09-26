import { describe, expect, it } from "vitest";
import {
  MAX_NODES,
  classifyNode,
  parseShareLink,
  parseSubscription,
} from "../../src/core/proxy/subscription/parse.ts";
import { importSubscriptionNodes, subscriptionProxyId } from "../../src/core/proxy/subscription/import.ts";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../src/shared/schema.ts";

/*
 * 订阅解析。
 *
 * 订阅体是本项目**最不可控**的输入：格式由第三方服务商决定，随时会变，
 * 而且同一个 URL 换个 UA 就换格式。所以解析必须是纯函数 —— 能拿一段文本
 * 反复喂，而不需要网络。
 *
 * **fixture 全部虚构**（`example.invalid` / 文档保留网段），但刻意保留了
 * 真实订阅里那些结构性麻烦形态：emoji flag、CJK、连续空格、节点名里的冒号
 * 与井号、多个节点共用同一个 host:port。那些正是解析器会栽的地方。
 */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/* ================================================================== *
 * Clash YAML
 * ================================================================== */

describe("Clash YAML", () => {
  it("解出节点，并把分组跳过", () => {
    const yaml = `
mixed-port: 7897
external-controller: 127.0.0.1:9097
proxies:
  - { name: "🇺🇸 美国 01", type: anytls, server: a.example.invalid, port: 443, password: pw1 }
  - { name: "🇯🇵 日本  02", type: vless, server: b.example.invalid, port: 8443, uuid: uuid-2 }
  - { name: "直连出口", type: socks5, server: 198.51.100.7, port: 1080 }
  - { name: "♻️ 自动选择", type: url-test, proxies: ["🇺🇸 美国 01"] }
  - { name: "🔀 手动切换", type: select, proxies: ["🇺🇸 美国 01"] }
proxy-groups:
  - { name: Proxy, type: select, proxies: ["🇺🇸 美国 01", "🇯🇵 日本  02"] }
  - { name: Auto, type: url-test, proxies: ["🇺🇸 美国 01"] }
`;
    const r = parseSubscription(yaml);
    expect(r.format).toBe("clash");
    expect(r.nodes.map((n) => n.name)).toEqual(["🇺🇸 美国 01", "🇯🇵 日本  02", "直连出口"]);
    // 两个分组被跳过 —— 它们混在 `proxies:` 里是实测存在的形态。
    expect(r.skipped).toBe(2);
  });

  it("**带 server 字段的分组也必须跳过** —— 否则它会被当成节点导入", () => {
    /*
     * fixture 里的分组条目必须带 `server` 字段。否则
     * "跳过分组"这条判断被"缺 host 的条目丢掉"顺带满足了 ——
     * 把 `isGroupType` 整条去掉，测试**依然全绿**（四分类里的
     * 「条件被另一层顺带满足」）。
     *
     * 而这不是假想：实测存在被中间层重新打包过的订阅，把分组和节点混在
     * `proxies:` 里，且分组条目带着 `server`（那是打包器填进去的占位）。
     * 那种分组一旦被导入，它"能连"（Clash 会按策略转发），于是
     * **出口隔离静默失效** —— 两个 Worker 绑到同一个分组会走同一个出口，
     * 而界面上它们是两个不同的代理。
     */
    const yaml = `
proxies:
  - { name: 真节点, type: vless, server: a.example.invalid, port: 443 }
  - { name: 🔀 分组, type: select, server: 127.0.0.1, port: 7890, proxies: [真节点] }
  - { name: ♻️ 自动, type: url-test, server: 127.0.0.1, port: 7890, proxies: [真节点] }
  - { name: 直连策略, type: direct, server: 127.0.0.1, port: 7890 }
  - { name: 拒绝策略, type: reject, server: 127.0.0.1, port: 7890 }
`;
    const r = parseSubscription(yaml);
    expect(r.nodes.map((n) => n.name)).toEqual(["真节点"]);
    expect(r.skipped).toBe(4);
  });

  it("`proxy-groups` 里只收 select —— url-test 切不了", () => {
    const yaml = `
proxies:
  - { name: n1, type: http, server: a.example.invalid, port: 8080 }
proxy-groups:
  - { name: Proxy, type: select, proxies: [n1] }
  - { name: Auto, type: url-test, proxies: [n1] }
`;
    /*
     * 只有 `select` 能被 Controller 的 `PUT /proxies/{name}` 切换。
     * 把 `url-test` 也收进来会让 setup 选中一个"切了不生效"的分组 ——
     * GLOBAL 就是这种坑（rule 模式下 GLOBAL 不参与选路）。
     */
    expect(parseSubscription(yaml).hints?.selectorGroups).toEqual(["Proxy"]);
  });

  it("端口提示三个都收，但只是提示", () => {
    const yaml = `
mixed-port: 7897
port: 7890
socks-port: 7891
external-controller: "127.0.0.1:9097"
proxies:
  - { name: n1, type: http, server: a.example.invalid, port: 8080 }
`;
    const h = parseSubscription(yaml).hints;
    expect(h).toMatchObject({ mixedPort: 7897, httpPort: 7890, socksPort: 7891 });
    // 没有 scheme 时补 http:// —— `external-controller` 常写成裸 host:port。
    expect(h?.externalController).toBe("http://127.0.0.1:9097");
  });

  it("多个节点共用同一个 host:port 时不折叠", () => {
    /*
     * 机场普遍让十几个节点共用一个入口（靠 SNI/路径区分）。
     * 按 host:port 去重会把它们折成一个 —— 这是选 `name` 做身份的理由。
     */
    const yaml = `
proxies:
  - { name: 香港 01, type: vless, server: edge.example.invalid, port: 443 }
  - { name: 香港 02, type: vless, server: edge.example.invalid, port: 443 }
  - { name: 香港 03, type: vless, server: edge.example.invalid, port: 443 }
`;
    expect(parseSubscription(yaml).nodes).toHaveLength(3);
  });

  it("缺 server 或端口越界的条目被丢弃并计数", () => {
    const yaml = `
proxies:
  - { name: 没有服务器, type: http, port: 8080 }
  - { name: 端口为零, type: http, server: a.example.invalid, port: 0 }
  - { name: 端口过大, type: http, server: a.example.invalid, port: 70000 }
  - { name: 好的, type: http, server: a.example.invalid, port: 8080 }
`;
    const r = parseSubscription(yaml);
    expect(r.nodes.map((n) => n.name)).toEqual(["好的"]);
    expect(r.skipped).toBe(3);
  });

  it("`hy2` 归一成 hysteria2", () => {
    const yaml = `proxies:\n  - { name: h, type: hy2, server: a.example.invalid, port: 443 }\n`;
    expect(parseSubscription(yaml).nodes[0]!.type).toBe("hysteria2");
  });

  it("节点数超上限时截断，不是拒绝整份", () => {
    const items = Array.from(
      { length: MAX_NODES + 50 },
      (_, i) => `  - { name: n${i}, type: http, server: a.example.invalid, port: 8080 }`,
    ).join("\n");
    const r = parseSubscription(`proxies:\n${items}\n`);
    // 截断而不是返回 0 —— 拿到 2000 个可用节点远好于"因为太多所以一个都没有"。
    expect(r.nodes).toHaveLength(MAX_NODES);
  });

  it("YAML 锚点炸弹不会把内存吃光", () => {
    // billion laughs：锚点层层引用，展开后指数级膨胀。
    const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
proxies:
  - { name: n1, type: http, server: a.example.invalid, port: 8080 }
`;
    // 要么解析失败（别名超限），要么正常解出 —— 两者都可接受，不可接受的是挂住。
    const r = parseSubscription(bomb);
    expect(["clash", "empty", "uri-list"]).toContain(r.format);
  });
});

/* ================================================================== *
 * SIP008
 * ================================================================== */

describe("SIP008", () => {
  it("从 servers 数组解出 ss 节点", () => {
    const json = JSON.stringify({
      version: 1,
      servers: [
        {
          id: "x",
          remarks: "SG 节点",
          server: "sg.example.invalid",
          server_port: 8388,
          method: "aes-256-gcm",
          password: "pw",
        },
        { server: "no-port.example.invalid" },
      ],
    });
    const r = parseSubscription(json);
    expect(r.format).toBe("sip008");
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]).toMatchObject({
      name: "SG 节点",
      type: "ss",
      host: "sg.example.invalid",
      port: 8388,
      password: "pw",
    });
    expect(r.skipped).toBe(1);
  });

  it("没有 remarks 时名字兜底成 scheme://host:port", () => {
    const json = JSON.stringify({ servers: [{ server: "a.example.invalid", server_port: 1234 }] });
    expect(parseSubscription(json).nodes[0]!.name).toBe("ss://a.example.invalid:1234");
  });
});

/* ================================================================== *
 * 分享链
 * ================================================================== */

describe("分享链", () => {
  it("ss:// 两种写法都认", () => {
    // 形态一：整体 base64。
    const whole = `ss://${b64("aes-256-gcm:pass1@a.example.invalid:8388")}#节点一`;
    // 形态二：仅 userinfo base64。
    const partial = `ss://${b64("aes-256-gcm:pass2")}@b.example.invalid:8389#节点二`;
    const r = parseSubscription(`${whole}\n${partial}`);
    expect(r.format).toBe("uri-list");
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toMatchObject({ host: "a.example.invalid", port: 8388, password: "pass1" });
    expect(r.nodes[1]).toMatchObject({ host: "b.example.invalid", port: 8389, password: "pass2" });
  });

  it("vmess:// 解 base64 JSON", () => {
    const payload = b64(JSON.stringify({ ps: "VM 节点", add: "v.example.invalid", port: 443, id: "uuid-x" }));
    const n = parseShareLink(`vmess://${payload}`);
    expect(n).toMatchObject({ name: "VM 节点", type: "vmess", host: "v.example.invalid", port: 443 });
  });

  it("ssr:// 解六段结构与 base64 备注", () => {
    const inner = `r.example.invalid:9000:auth_aes128_md5:aes-256-cfb:plain:${b64("ssr-pass")}/?remarks=${b64("SSR 节点")}`;
    const n = parseShareLink(`ssr://${b64(inner)}`);
    expect(n).toMatchObject({ type: "ssr", host: "r.example.invalid", port: 9000, password: "ssr-pass" });
    expect(n?.name).toBe("SSR 节点");
  });

  it("http/socks 走 WHATWG URL，含默认端口与凭证", () => {
    expect(parseShareLink("https://user:pw@p.example.invalid/#HTTPS 代理")).toMatchObject({
      type: "https",
      host: "p.example.invalid",
      port: 443,
      username: "user",
      password: "pw",
      name: "HTTPS 代理",
    });
    // socks5h 归一成 socks5；socks 默认端口 1080。
    expect(parseShareLink("socks5h://s.example.invalid")).toMatchObject({ type: "socks5", port: 1080 });
    expect(parseShareLink("socks4a://s.example.invalid:1081")).toMatchObject({ type: "socks4", port: 1081 });
  });

  it("IPv6 的方括号被去掉 —— 配置里存裸地址", () => {
    expect(parseShareLink("http://[2001:db8::1]:8080")).toMatchObject({
      host: "2001:db8::1",
      port: 8080,
    });
    // 隧道协议走自己的端点解析，同样要认方括号形态。
    expect(parseShareLink("trojan://pw@[2001:db8::2]:443#v6")).toMatchObject({
      host: "2001:db8::2",
      port: 443,
    });
  });

  it("节点名里有空格时不被切断", () => {
    /*
     * 按 `\s+` 切会把这一行劈成三段，三段都解析失败 —— 那个节点静默消失。
     * 所以必须按**行**切。
     */
    const r = parseSubscription("trojan://pw@t.example.invalid:443#🇭🇰 香港  IPLC 专线");
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.name).toBe("🇭🇰 香港  IPLC 专线");
  });

  it("不认识的 scheme 返回 null，不硬塞成 http", () => {
    /*
     * 猜错协议会造出一个"连得上但走错路"的代理 —— 那种失败比"没导入"
     * 难查得多（它会静默地把流量走到别的出口，而出口隔离据此分组）。
     */
    expect(parseShareLink("quic-unknown://a.example.invalid:443")).toBeNull();
    expect(parseShareLink("ftp://a.example.invalid")).toBeNull();
  });

  it("注释行与空行被跳过", () => {
    const r = parseSubscription(
      ["# 这是注释", "// 也是注释", "", "http://a.example.invalid:8080", "   "].join("\n"),
    );
    expect(r.nodes).toHaveLength(1);
  });
});

/* ================================================================== *
 * Base64 外壳
 * ================================================================== */

describe("多层 Base64", () => {
  it("单层与双层都解开", () => {
    const list = "http://a.example.invalid:8080\nhttp://b.example.invalid:8081";
    expect(parseSubscription(b64(list)).nodes).toHaveLength(2);
    // 双层 —— 实测存在（被中间层重新打包过的订阅）。
    expect(parseSubscription(b64(b64(list))).nodes).toHaveLength(2);
  });

  it("Base64 包着 Clash YAML 也认", () => {
    const yaml = `proxies:\n  - { name: n1, type: http, server: a.example.invalid, port: 8080 }\n`;
    const r = parseSubscription(b64(yaml));
    expect(r.format).toBe("clash");
    expect(r.nodes).toHaveLength(1);
  });

  it("深度有上限 —— 一段自我解码的文本不会让它转不出来", () => {
    /*
     * 没有上限时，一段恰好长得像 base64 的文本可以无限解下去。
     * 这条断言的价值不在返回值，而在**它会返回**。
     */
    let text = "http://a.example.invalid:8080";
    for (let i = 0; i < 6; i += 1) text = b64(text);
    const r = parseSubscription(text);
    // 6 层 > 上限 3 层，所以解不到最里面 —— 结果是 empty 而不是挂住。
    expect(r.format).toBe("empty");
  });

  it("二进制不会被当成解码成功", () => {
    /*
     * 不能只用纯 0x00-0x08：那串解出来
     * **也不含任何 `://`**，于是"不是 base64"这条判断被"解出来也没有链接"
     * 顺带满足了 —— 把控制字符检查去掉，测试依然全绿。
     *
     * 现在构造一段**解开后既含控制字符、又含一条看起来合法的链接**的输入：
     * 少了那条检查，它会被当成解码成功并导入一个节点，而那个节点的
     * 名字里带着二进制垃圾。
     */
    const nasty = `http://a.example.invalid:8080#\u0001\u0002\u0003名字`;
    const encoded = Buffer.from(nasty, "utf8").toString("base64");
    const r = parseSubscription(encoded);
    expect(r.nodes).toEqual([]);
    expect(r.format).toBe("empty");

    // 纯二进制同样不认。
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]).toString("base64");
    expect(parseSubscription(binary).format).toBe("empty");
  });
});

/* ================================================================== *
 * 空与坏输入：绝不抛
 * ================================================================== */

describe("坏输入只得到空结果，不抛错", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["空串", ""],
    ["只有空白", "   \n\t  "],
    ["HTML 页面（token 过期时机场常返回这个）", "<html><body>402 Payment Required</body></html>"],
    ["坏 YAML", "proxies:\n  - { name: 未闭合"],
    ["JSON 数组（顶层不是对象）", "[1,2,3]"],
    ["proxies 不是数组", "proxies: 7"],
    ["BOM 开头的空内容", "\uFEFF"],
    ["纯 emoji", "🇺🇸🇯🇵🇭🇰"],
  ];

  for (const [name, body] of cases) {
    it(name, () => {
      const r = parseSubscription(body);
      expect(r.nodes).toEqual([]);
      expect(r.format).toBe("empty");
    });
  }
});

/* ================================================================== *
 * 能力分类
 * ================================================================== */

describe("classifyNode", () => {
  it("direct 从 isDirectCapable 推导 —— 不另写一份清单", () => {
    expect(classifyNode("http")).toEqual({ direct: true, bridgeable: true });
    expect(classifyNode("socks5")).toEqual({ direct: true, bridgeable: true });
    expect(classifyNode("HTTPS")).toEqual({ direct: true, bridgeable: true });
  });

  it("只能桥接的协议 direct 为 false，但 bridgeable 恒为 true", () => {
    /*
     * bridgeable 恒 true 是刻意的：Clash 支持的协议远多于本项目能直连的四种，
     * 而"内核认不认这个协议"只有内核知道。判断错的代价不对称 ——
     * 标成不可桥接会让一个能用的节点被永久排除且无从发现。
     */
    for (const t of ["vless", "hysteria2", "anytls", "tuic", "某种未来协议"]) {
      expect(classifyNode(t)).toEqual({ direct: false, bridgeable: true });
    }
  });
});

/* ================================================================== *
 * 导入合并
 * ================================================================== */

function baseConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    version: CONFIG_VERSION,
    gateway: { relayToken: "sub-test-relay-token-x", port: 19991 },
    subscriptions: [{ id: "s1", name: "订阅一", url: "https://sub.example.invalid/link" }],
    ...overrides,
  });
}

const node = (name: string, over: Partial<{ host: string; port: number; type: string }> = {}) => ({
  name,
  type: over.type ?? "vless",
  host: over.host ?? "a.example.invalid",
  port: over.port ?? 443,
});

describe("导入合并", () => {
  it("首次导入全部新增", () => {
    const r = importSubscriptionNodes(baseConfig(), "s1", [node("n1"), node("n2")]);
    expect(r.summary).toMatchObject({ added: 2, updated: 0, removed: 0, total: 2 });
    expect(r.config.proxies).toHaveLength(2);
    expect(r.config.proxies[0]!.source).toBe("subscription");
    expect(r.config.proxies[0]!.subscriptionId).toBe("s1");
  });

  it("**幂等**：同一批节点导两次，id 不变、不产生重复", () => {
    /*
     * 这条是整个模块最要紧的性质。id 随机的话：Worker 的 proxyId 会指向
     * 不存在的代理（schema 的引用完整性直接拒绝整份配置，网关起不来），
     * 而已实测的 egressIp 全部丢失（出口隔离报告归零）。
     */
    const first = importSubscriptionNodes(baseConfig(), "s1", [node("n1"), node("n2")]);
    const second = importSubscriptionNodes(first.config, "s1", [node("n1"), node("n2")]);

    expect(second.config.proxies).toHaveLength(2);
    expect(second.summary).toMatchObject({ added: 0, updated: 2, removed: 0 });
    expect(second.config.proxies.map((p) => p.id)).toEqual(first.config.proxies.map((p) => p.id));
  });

  it("刷新保留 `enabled` 与实测 `egressIp`", () => {
    const first = importSubscriptionNodes(baseConfig(), "s1", [node("n1")]);
    // 用户停用了它，而且我们实测过它的出口。
    const edited: Config = {
      ...first.config,
      proxies: first.config.proxies.map((p) => ({ ...p, enabled: false, egressIp: "198.51.100.9" })),
    };

    // 机场把这个节点换了端口。
    const second = importSubscriptionNodes(edited, "s1", [node("n1", { port: 8443 })]);
    const p = second.config.proxies[0]!;

    // 连接信息更新了。
    expect(p.port).toBe(8443);
    // 而用户的编辑与实测事实都保留 —— 一次刷新不该丢掉这两样。
    expect(p.enabled).toBe(false);
    expect(p.egressIp).toBe("198.51.100.9");
  });

  it("这次不再出现的节点被移除", () => {
    const first = importSubscriptionNodes(baseConfig(), "s1", [node("n1"), node("n2")]);
    const second = importSubscriptionNodes(first.config, "s1", [node("n1")]);
    expect(second.summary).toMatchObject({ added: 0, updated: 1, removed: 1 });
    expect(second.config.proxies).toHaveLength(1);
  });

  it("**仍被 Worker 绑着的过期节点保留并报出来**", () => {
    /*
     * 静默删掉会让配置过不了引用完整性校验 —— 网关起不来，而用户只是
     * 点了一下"刷新订阅"。静默保留而不说，用户会奇怪它为什么还在。
     */
    const first = importSubscriptionNodes(baseConfig(), "s1", [node("n1"), node("n2")]);
    const boundId = first.config.proxies[1]!.id;
    const withWorker: Config = {
      ...first.config,
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "sub-test-key", enabled: true, proxyId: boundId },
      ],
    };

    const second = importSubscriptionNodes(withWorker, "s1", [node("n1")]);
    expect(second.summary.removed).toBe(0);
    expect(second.summary.keptBecauseInUse).toEqual([boundId]);
    // 而且合并结果仍能过 schema —— 引用完整性是它最容易被破坏的地方。
    expect(() => ConfigSchema.parse(second.config)).not.toThrow();
  });

  it("不碰别的来源与别的订阅", () => {
    const cfg = baseConfig({
      subscriptions: [
        { id: "s1", name: "一", url: "https://a.example.invalid/x", enabled: true, lastFetchedAt: null, lastErrorKind: null, lastImportCount: 0, lastFormat: null },
        { id: "s2", name: "二", url: "https://b.example.invalid/x", enabled: true, lastFetchedAt: null, lastErrorKind: null, lastImportCount: 0, lastFormat: null },
      ],
      proxies: [
        {
          id: "manual_1", name: "手工的", type: "socks5", host: "127.0.0.1", port: 1080,
          enabled: true, source: "manual", direct: true, bridgeable: false, egressIp: null,
        },
        {
          // 只能桥接且 Clash 未启用 → 必须是停用的，否则 schema 会拒
          // （那条 superRefine 是对的，见 import.ts 的文件头）。
          id: "sub_other", name: "别的订阅的", type: "vless", host: "c.example.invalid", port: 443,
          enabled: false, source: "subscription", subscriptionId: "s2",
          direct: false, bridgeable: true, egressIp: null,
        },
      ],
    });

    const r = importSubscriptionNodes(cfg, "s1", [node("n1")]);
    expect(r.summary).toMatchObject({ added: 1, removed: 0 });
    // 手工的与 s2 的都还在。
    expect(r.config.proxies.map((p) => p.id)).toContain("manual_1");
    expect(r.config.proxies.map((p) => p.id)).toContain("sub_other");
  });

  it("id 由「订阅 id + 节点名」派生 —— 同名节点在不同订阅里是两条记录", () => {
    expect(subscriptionProxyId("s1", "香港 01")).not.toBe(subscriptionProxyId("s2", "香港 01"));
    // 同一订阅同一名字必须稳定。
    expect(subscriptionProxyId("s1", "香港 01")).toBe(subscriptionProxyId("s1", "香港 01"));
    // 前缀区分来源 —— 与 setup.mjs 的 `controller_` 刻意不同。
    expect(subscriptionProxyId("s1", "x").startsWith("sub_")).toBe(true);
  });

  it("一份订阅里同名节点重复出现时后者胜", () => {
    const r = importSubscriptionNodes(baseConfig(), "s1", [
      node("dup", { port: 1111 }),
      node("dup", { port: 2222 }),
    ]);
    expect(r.config.proxies).toHaveLength(1);
    expect(r.config.proxies[0]!.port).toBe(2222);
  });

  it("Clash 未启用时，只能桥接的新节点导入成**停用**并报出来", () => {
    /*
     * `ConfigSchema` 有一条 superRefine：**已启用**且只能桥接的代理，
     * 在 `clash.enabled` 为 false 时是配置矛盾。那条规则是对的。
     * 而订阅里绝大多数节点恰好都是只能桥接的（vless/hysteria2/anytls），
     * 于是"Clash 没开时导入订阅"会造出一份**存不下去**的配置 ——
     * `applyConfig` 在 saveConfig 那步被拒，而用户只是点了一下"刷新订阅"。
     */
    const cfg = baseConfig();
    expect(cfg.clash.enabled).toBe(false);

    const r = importSubscriptionNodes(cfg, "s1", [
      node("只能桥的", { type: "hysteria2" }),
      node("能直连的", { type: "socks5" }),
    ]);

    // 关键：结果能存下去。
    expect(() => ConfigSchema.parse(r.config)).not.toThrow();

    const bridgeOnly = r.config.proxies.find((p) => p.name === "只能桥的")!;
    const directOne = r.config.proxies.find((p) => p.name === "能直连的")!;
    expect(bridgeOnly.enabled).toBe(false);
    // 能直连的不受影响 —— 它不需要 Clash。
    expect(directOne.enabled).toBe(true);

    // 而且要报出来，否则用户会奇怪"为什么导进来的节点全是灰的"。
    expect(r.summary.disabledNeedBridge).toBe(1);
  });

  it("Clash 启用时同样的节点导入成启用", () => {
    const cfg = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "sub-test-relay-token-x", port: 19991 },
      clash: {
        enabled: true,
        activeBridgeId: "b1",
        selectionMode: "manual",
        bridges: [{ id: "b1", name: "内核", apiBase: "http://127.0.0.1:9097", localProxyPort: 7897, selectorGroup: "Proxy" }],
      },
    });
    const r = importSubscriptionNodes(cfg, "s1", [node("只能桥的", { type: "hysteria2" })]);
    expect(r.config.proxies[0]!.enabled).toBe(true);
    expect(r.summary.disabledNeedBridge).toBe(0);
  });

  it("刷新不会把用户启用过的桥接节点改回停用", () => {
    /*
     * `enabled` 是用户的编辑 —— 只在**新增**时才受 Clash 状态影响。
     * 否则"开了 Clash、启用了节点、又刷新一次订阅"会把它打回停用。
     */
    const withClash = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "sub-test-relay-token-x", port: 19991 },
      clash: {
        enabled: true,
        activeBridgeId: "b1",
        selectionMode: "manual",
        bridges: [{ id: "b1", name: "内核", apiBase: "http://127.0.0.1:9097", localProxyPort: 7897, selectorGroup: "Proxy" }],
      },
    });
    const first = importSubscriptionNodes(withClash, "s1", [node("n", { type: "hysteria2" })]);
    expect(first.config.proxies[0]!.enabled).toBe(true);

    const second = importSubscriptionNodes(first.config, "s1", [node("n", { type: "hysteria2" })]);
    expect(second.config.proxies[0]!.enabled).toBe(true);
    expect(second.summary.disabledNeedBridge).toBe(0);
  });

  it("导入结果始终能过 schema（含 direct/bridgeable 的 refine）", () => {
    const r = importSubscriptionNodes(baseConfig(), "s1", [
      node("直连的", { type: "socks5" }),
      node("只能桥的", { type: "hysteria2" }),
      node("未来协议的", { type: "某种未来协议" }),
    ]);
    // refine 要求"既不能直连也不能桥接的代理"被拒 —— bridgeable 恒 true 保证不会。
    expect(() => ConfigSchema.parse(r.config)).not.toThrow();
  });
});
