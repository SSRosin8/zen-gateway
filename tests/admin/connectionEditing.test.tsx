import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as adminApi from "../../src/admin/lib/api.ts";
import { ProxyPage } from "../../src/admin/pages/ProxyPage.tsx";
import { GatewayPage } from "../../src/admin/pages/GatewayPage.tsx";
import { attentionItems } from "../../src/admin/pages/OverviewPage.tsx";
import { suggestProxyId, validateProxyForm } from "../../src/admin/components/ProxyEditor.tsx";
import { parseHash } from "../../src/admin/lib/router.ts";
import { ProxyListSchema, type ProxyList, type ProxyView } from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * 后台编辑手工代理的连接信息与监听端口：只有手工直连代理给出「编辑连接」，
 * 端口改动写盘后提示重启，而不是假装已经生效。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

// 页面挂载时会轮询批量探测进度；这里让它挂起，不影响被测交互。
function quietFetch() {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
}

function proxy(over: Partial<ProxyView> = {}): ProxyView {
  return {
    id: "p1",
    name: "节点一",
    type: "anytls",
    host: "127.0.0.1",
    port: 7897,
    enabled: true,
    source: "controller",
    bridgeId: "b1",
    clashNodeName: "节点一",
    direct: false,
    bridgeable: true,
    egressIp: null,
    username: null,
    password: { present: false, fingerprint: null },
    usedBy: [],
    resolvable: true,
    unresolvableReason: null,
    ...over,
  };
}

const manual = (over: Partial<ProxyView> = {}) =>
  proxy({
    id: "manual-1",
    name: "本机 HTTP",
    type: "socks5",
    host: "203.0.113.9",
    port: 1080,
    source: "manual",
    bridgeId: null,
    clashNodeName: null,
    direct: true,
    bridgeable: false,
    username: "u",
    password: { present: true, fingerprint: "abcd1234" },
    egressIp: "198.51.100.7",
    ...over,
  });

function proxyList(proxies: ProxyView[]): ProxyList {
  return ProxyListSchema.parse({
    proxies,
    clash: { enabled: true, selectionMode: "auto", activeBridgeId: null, bridges: [] },
    isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: false },
    subscriptions: [],
  });
}

describe("出口页：手工代理", () => {
  it("只有手工直连代理的菜单里有「编辑连接」", async () => {
    quietFetch();
    const user = userEvent.setup();
    render(<ProxyPage data={proxyList([proxy(), manual()])} view={parseHash("#proxy")} navigate={() => {}} />);
    await user.click(screen.getByRole("button", { name: "节点一 的更多操作" }));
    expect(screen.queryByRole("menuitem", { name: "编辑连接" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "本机 HTTP 的更多操作" }));
    expect(screen.getByRole("menuitem", { name: "编辑连接" })).toBeInTheDocument();
  });

  it("编辑回填当前值；只改端口时口令保持不动", async () => {
    quietFetch();
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<ProxyPage data={proxyList([manual()])} view={parseHash("#proxy")} navigate={() => {}} refresh={() => {}} />);
    await user.click(screen.getByRole("button", { name: "本机 HTTP 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑连接" }));
    const form = screen.getByRole("form", { name: "编辑代理 manual-1" });
    expect(within(form).getByLabelText("主机")).toHaveValue("203.0.113.9");
    expect(within(form).getByLabelText("用户名（可选）")).toHaveValue("u");
    const port = within(form).getByLabelText("端口");
    await user.clear(port);
    await user.type(port, "1081");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const body = patch.mock.calls[0]![0].proxies!.update!["manual-1"]!;
    expect(body).toMatchObject({ type: "socks5", host: "203.0.113.9", port: 1081, username: "u" });
    expect(body).not.toHaveProperty("password");
    await waitFor(() => expect(screen.getByText("已保存，回显出口需重新探测")).toBeInTheDocument());
  });

  it("保存失败时表单保持打开并显示原因", async () => {
    quietFetch();
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockRejectedValue(new Error("代理 manual-1 的字段不合法:host"));
    render(<ProxyPage data={proxyList([manual()])} view={parseHash("#proxy")} navigate={() => {}} />);
    await user.click(screen.getByRole("button", { name: "本机 HTTP 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "编辑连接" }));
    const form = screen.getByRole("form", { name: "编辑代理 manual-1" });
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(within(form).getByText(/字段不合法/)).toBeInTheDocument());
  });

  it("新增：建议 id，本地先挡住非法端口，不发请求", async () => {
    quietFetch();
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<ProxyPage data={proxyList([manual()])} view={parseHash("#proxy")} navigate={() => {}} />);
    await user.click(screen.getByRole("button", { name: "添加手工代理" }));
    const form = screen.getByRole("form", { name: "新增代理" });
    expect(within(form).getByLabelText("ID")).toHaveValue("manual-2");
    await user.type(within(form).getByLabelText("端口"), "0");
    await user.click(within(form).getByRole("button", { name: "新增代理" }));
    expect(within(form).getByText("端口必须是 1 到 65535 的整数")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();

    await user.clear(within(form).getByLabelText("端口"));
    await user.type(within(form).getByLabelText("端口"), "8080");
    await user.click(within(form).getByRole("button", { name: "新增代理" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![0].proxies!.create![0]).toMatchObject({ id: "manual-2", type: "http", host: "127.0.0.1", port: 8080 });
  });

  it("id 建议取最大序号 + 1；校验沿用存储 schema", () => {
    expect(suggestProxyId(["manual-1", "manual-7", "other"])).toBe("manual-8");
    expect(validateProxyForm({ id: "__direct__", host: "h", port: "1" }, new Set())).toMatch(/ID 不合法/);
    expect(validateProxyForm({ id: "a", host: "bad host", port: "1" }, new Set())).toMatch(/主机不合法/);
    expect(validateProxyForm({ id: "a", host: "proxy.invalid", port: "1" }, new Set(["a"]))).toMatch(/已存在/);
    expect(validateProxyForm({ id: "a", host: "proxy.invalid", port: "1" }, new Set())).toBeNull();
  });
});

describe("监听端口", () => {
  it("保存只写配置，未重启时网关页与概览都提示", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    const { rerender } = render(<GatewayPage data={fakeOverview()} />);
    const input = screen.getByLabelText("配置的端口");
    await user.clear(input);
    await user.type(input, "20555");
    await user.click(screen.getByRole("button", { name: "保存端口" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ gateway: { port: 20555 } }));

    const pending = fakeOverview();
    pending.gateway.configuredPort = 20555;
    rerender(<GatewayPage data={pending} />);
    expect(screen.getByText("配置已改为 20555，重启后生效")).toBeInTheDocument();
    const item = attentionItems(pending, { status: "loading" }, null).find((i) => i.id === "port-restart");
    expect(item?.text).toContain("npm run restart");
  });

  it("端口由 ZG_PORT 指定时表单只读，也不提示重启", () => {
    const data = fakeOverview();
    data.gateway.portFromEnv = true;
    data.gateway.configuredPort = 20555;
    render(<GatewayPage data={data} />);
    expect(screen.getByLabelText("配置的端口")).toBeDisabled();
    expect(screen.getByText(/由环境变量 ZG_PORT 指定/)).toBeInTheDocument();
    expect(attentionItems(data, { status: "loading" }, null).some((i) => i.id === "port-restart")).toBe(false);
  });

  it("特权端口在本地拒绝", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<GatewayPage data={fakeOverview()} />);
    const input = screen.getByLabelText("配置的端口");
    await user.clear(input);
    await user.type(input, "80");
    await user.click(screen.getByRole("button", { name: "保存端口" }));
    expect(screen.getByText("端口必须是 1024 到 65535 的整数")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });
});
