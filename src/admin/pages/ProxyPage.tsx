import type { BatchProgressView, ProxyList, ProxyView } from "../../shared/contract.ts";
import { isActive } from "../../shared/batchProbe.ts";
import { useEffect, useState } from "react";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Mono, PageHeader, Panel, PrimaryButton, SecondaryButton, Truncate } from "../components/Panel.tsx";
import { BulkBar, DataTable, RowNoteView, SEGMENTED_TRACK, TableFilters, segmentClass, type Column } from "../components/DataTable.tsx";
import { RowMenu } from "../components/RowMenu.tsx";
import { BatchProbeBar } from "../components/BatchProbeBar.tsx";
import { useRowNotes } from "../lib/rowNotes.ts";
import { FIELD } from "../lib/styles.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { parseHash, toHash, type ViewState } from "../lib/router.ts";
import { useBatchProbe } from "../lib/api.ts";
import { probeEgress } from "../lib/consoleApi.ts";
import { SubscriptionTab } from "../components/SubscriptionTab.tsx";
import { ClashSection } from "../components/ClashSection.tsx";

export { subscriptionStatus } from "../components/SubscriptionTab.tsx";

/**
 * 出口页（原代理池）。
 *
 * 标签：**节点**（分页、多选批量、行内探测与撤销、批量探测逐行显示状态）、**订阅**、**Clash**。
 * 回显 IP 并入节点的状态列；找共用出口用 Worker 页的「共用出口」筛选（共用是 Worker 的问题）。
 */

function proxyTone(p: ProxyView): "success" | "warn" | "error" | "neutral" {
  if (!p.enabled) return "neutral";
  if (!p.resolvable) return "error";
  // 能用但没实测过回显出口 —— 那不是错误，只是还不知道。
  if (p.egressIp === null) return "warn";
  return "success";
}

/**
 * 「配置真的有问题」—— 启用了却解析不出出口。
 *
 * **不能直接用 `!resolvable`**:`resolveProxy` 对**已停用**的代理返回的也是一个
 * 失败（`{kind:"disabled"}`）,而停用是用户的正常操作,不是配置错误。
 * 于是 `!resolvable` 计数会把「我故意关掉的三个节点」报成
 * 「3 个配置有问题」并标红，而真正坏掉的是 0 个。指标与筛选都用这个判据。
 */
function isBroken(p: ProxyView): boolean {
  return p.enabled && !p.resolvable;
}

function proxyStatus(p: ProxyView): { tone: StatusTone; icon: string; label: string } {
  /*
   * ## 停用与不可解析要**一起**说，不是二选一
   *
   * `resolveProxy` 对「已停用」返回的正是一个失败（`{ kind: "disabled" }`）。
   * 先判 `!enabled` 就 return「已停用」的话，最常见的那条不可解析路径
   * 永远显示不出原因。
   *
   * 所以停用时也把服务端给的原因带上 —— 它对「停用」这种自明的情况是冗余的，
   * 但对「引用了不存在的内核」「Clash 没开」这些就是**唯一**的线索，
   * 而那些同样会让 `resolvable` 为 false。措辞统一来自
   * `describeResolveFailure`，与转发失败时用户看到的是同一句话。
   */
  if (!p.enabled) {
    return { tone: "neutral", icon: "○", label: p.unresolvableReason ?? "已停用" };
  }
  if (!p.resolvable) {
    return { tone: "error", icon: "✕", label: p.unresolvableReason ?? "无法解析出口" };
  }
  if (p.egressIp === null) return { tone: "warn", icon: "?", label: "未探测出口" };
  return { tone: "success", icon: "✓", label: "可用" };
}

/** 被 Worker 引用的节点不能删：Worker 会静默退回直连，破坏出口隔离。 */
export function deleteBlockedReason(p: ProxyView): string | null {
  return p.usedBy.length === 0 ? null : `被 ${p.usedBy.join("、")} 引用，先改绑这些 Worker`;
}

export function ProxyPage({
  data,
  view,
  navigate,
  refresh,
}: {
  data: ProxyList;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
  refresh?: (() => void) | undefined;
}) {
  const batch = useBatchProbe();
  const tab = view.tab ?? "list";
  const rows = useRowNotes(refresh);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<readonly ProxyView[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 正在单独探测的节点。一次只探一个：探测要切 selector，服务端也会拒绝并发。 */
  const [probing, setProbing] = useState<readonly string[]>([]);
  /** 上一批结束后又单独探测过的节点：它们的结果比那一批新，不再显示批测状态。 */
  const [probedSinceBatch, setProbedSinceBatch] = useState<ReadonlySet<string>>(new Set());
  const batchActive = isActive(batch.progress);
  // 新一批开始后，它的结果又比单独探测新了。
  useEffect(() => {
    if (batchActive) setProbedSinceBatch(new Set());
  }, [batchActive]);
  const batchNode = new Map(batch.progress.nodes.map((n) => [n.proxyId, n] as const));
  /*
   * 批测进行中显示每个节点的进度；结束后只留失败与跳过的原因（常规状态里看不到），
   * 且结束后单独探测过的节点以新结果为准。开始新一批时重新计。
   */
  const batchNodeFor = (id: string) => {
    const state = batch.progress.state;
    if (state === "idle") return undefined;
    const node = batchNode.get(id);
    if (state !== "done") return node;
    if (probedSinceBatch.has(id)) return undefined;
    return node?.state === "failed" || node?.state === "skipped" ? node : undefined;
  };
  const nameOf = (id: string) => {
    const p = data.proxies.find((x) => x.id === id);
    return p === undefined ? id : p.name || p.id;
  };

  const probeMany = async (ids: readonly string[]) => {
    setProbing(ids);
    setProbedSinceBatch((prev) => new Set([...prev, ...ids]));
    for (const id of ids) rows.clear(id);
    let index = 0;
    try {
      // 逐个发：每个节点的结果到一个显示一个，与概览的逐个探测同一手法。
      for (; index < ids.length; index++) {
        const id = ids[index]!;
        const r = (await probeEgress([id])).results[0];
        rows.set(
          [id],
          r === undefined || r.ok
            ? { tone: "success", text: r?.ok ? `回显 ${r.egressIp} · ${r.latencyMs}ms` : "已更新" }
            : { tone: "error", text: `${r.failureKind}：${r.reason}` },
        );
        refresh?.();
      }
    } catch (err) {
      // 只标出错的那一个；前面已探到的结果保留，后面的没探。
      rows.set([ids[index]!], { tone: "error", text: err instanceof Error ? err.message : String(err) });
      const rest = ids.slice(index + 1);
      if (rest.length > 0) rows.set(rest, { tone: "error", text: "未探测：前一个节点探测出错后停止" });
    } finally {
      setProbing([]);
    }
  };

  const setEnabled = (list: readonly ProxyView[], enabled: boolean) => {
    const ids = list.map((p) => p.id);
    const patch = (on: boolean) => ({ proxies: { update: Object.fromEntries(list.map((p) => [p.id, { enabled: on }])) } });
    // 撤销恢复每个节点原来的状态，而不是统一取反。
    const undo = { proxies: { update: Object.fromEntries(list.map((p) => [p.id, { enabled: p.enabled }])) } };
    void rows.apply(ids, patch(enabled), enabled ? "已启用" : "已停用", undo);
  };

  const q = view.q.trim().toLowerCase();
  const filtered = data.proxies.filter((p) => {
    if (q !== "") {
      const haystack = `${p.id} ${p.name} ${p.type} ${p.egressIp ?? ""} ${p.clashNodeName ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (view.status === "enabled" && !p.enabled) return false;
    if (view.status === "disabled" && p.enabled) return false;
    if (view.status === "probed" && p.egressIp === null) return false;
    if (view.status === "unprobed" && p.egressIp !== null) return false;
    // 「配置有问题」筛选同样排除仅停用的 —— 见 `isBroken`。
    if (view.status === "broken" && !isBroken(p)) return false;
    return true;
  });
  const chosen = data.proxies.filter((p) => selected.has(p.id));

  const columns: ReadonlyArray<Column<ProxyView>> = [
    {
      key: "name",
      header: "节点",
      render: (p) => (p.name !== "" ? <Truncate text={p.name} maxWidth="22rem" /> : <Mono>{p.id}</Mono>),
    },
    {
      key: "kind",
      header: "类型",
      render: (p) => (
        <span className="text-text-muted">
          {p.direct ? "直连" : "桥接"} · {p.type}
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      /*
       * 一列回答「这个节点现在怎样」：行内反馈 > 本批探测进度 > 常规状态。
       * 回显 IP 并进这一列（可用时显示 IP），不再单独占一列。
       */
      render: (p) => {
        const note = rows.noteOf(p.id);
        if (note !== undefined) return <RowNoteView note={note} busy={rows.busy} onUndo={() => void rows.runUndo(p.id)} />;
        if (probing.includes(p.id)) return <StatusIndicator tone="info" icon="◴" label="探测中…" />;
        const b = batchNodeFor(p.id);
        if (b !== undefined && b.state !== "ok") return <BatchNodeCell node={b} />;
        const s = proxyStatus(p);
        return (
          <span className="inline-flex items-baseline gap-2">
            <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />
            {p.egressIp !== null && p.enabled && p.resolvable && <Mono>{p.egressIp}</Mono>}
            {b?.state === "ok" && <span className="text-label-13 text-text-muted">{b.latencyMs}ms</span>}
          </span>
        );
      },
    },
    {
      key: "port",
      header: "本地端口",
      numeric: true,
      // 高风险字段：桥接时是 Clash 的混合端口，与内核实际 `mixed-port` 不一致会让桥接静默失败。
      render: (p) => <Mono>{p.port}</Mono>,
    },
    {
      key: "usedBy",
      header: "被引用",
      render: (p) =>
        p.usedBy.length === 0 ? <span className="text-text-muted">未引用</span> : <Truncate text={p.usedBy.join("、")} maxWidth="14rem" />,
    },
    {
      key: "actions",
      header: "操作",
      render: (p) => (
        <span className="flex gap-2">
          <SecondaryButton
            compact
            /* 批量探测进行中也禁用：两者会互相切 selector，服务端同样会拒绝。 */
            disabled={probing.length > 0 || batchActive}
            onClick={() => void probeMany([p.id])}
          >
            探测
          </SecondaryButton>
          <SecondaryButton compact disabled={rows.busy} onClick={() => setEnabled([p], !p.enabled)}>
            {p.enabled ? "停用" : "启用"}
          </SecondaryButton>
          <RowMenu
            label={`${p.name || p.id} 的更多操作`}
            items={[
              { label: "改名", onSelect: () => setRenaming(p.id) },
              {
                label: "删除",
                danger: true,
                disabledReason: deleteBlockedReason(p),
                onSelect: () => setPendingDelete([p]),
              },
            ]}
          />
        </span>
      ),
    },
  ];

  const blockedDelete = chosen.filter((p) => deleteBlockedReason(p) !== null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="出口"
        status={`${data.proxies.length} 个节点 · ${data.proxies.filter((p) => p.enabled).length} 个启用 · ${data.proxies.filter((p) => p.egressIp !== null).length} 个已实测${
          data.proxies.some(isBroken) ? ` · ${data.proxies.filter(isBroken).length} 个配置有问题` : ""
        }`}
      />

      <div className={SEGMENTED_TRACK} role="tablist" aria-label="出口视图">
        {TABS.map((t) => (
          <TabLink
            key={t.id}
            id={t.id}
            active={tab === t.id}
            onSelect={() => navigate({ tab: t.id })}
            label={t.id === "subscriptions" && data.subscriptions.length > 0 ? `${t.label}（${data.subscriptions.length}）` : t.label}
          />
        ))}
      </div>

      <div role="tabpanel" id={`proxy-panel-${tab}`} aria-labelledby={`proxy-tab-${tab}`}>
        {tab === "subscriptions" ? (
          <SubscriptionTab data={data} refresh={refresh} />
        ) : tab === "clash" ? (
          <ClashSection clash={data.clash} refresh={() => refresh?.()} />
        ) : (
          <Panel title={`节点（${filtered.length}/${data.proxies.length}）`} action={<BatchProbeBar control={batch} />}>
            <BulkBar count={chosen.length} onClear={() => setSelected(new Set())}>
              <SecondaryButton compact disabled={probing.length > 0 || batchActive} onClick={() => void probeMany(chosen.map((p) => p.id))}>
                探测
              </SecondaryButton>
              <SecondaryButton compact disabled={rows.busy} onClick={() => setEnabled(chosen, true)}>
                启用
              </SecondaryButton>
              <SecondaryButton compact disabled={rows.busy} onClick={() => setEnabled(chosen, false)}>
                停用
              </SecondaryButton>
              <span title={blockedDelete.length > 0 ? `${blockedDelete.length} 个被 Worker 引用，不能删` : undefined}>
                <SecondaryButton compact danger disabled={rows.busy || blockedDelete.length > 0} onClick={() => setPendingDelete(chosen)}>
                  删除
                </SecondaryButton>
              </span>
            </BulkBar>
            <TableFilters
              q={view.q}
              onQ={(next) => navigate({ q: next, page_: 1 })}
              status={view.status}
              onStatus={(next) => navigate({ status: next, page_: 1 })}
              statuses={[
                { value: "enabled", label: "已启用" },
                { value: "disabled", label: "已停用" },
                { value: "probed", label: "已实测" },
                { value: "unprobed", label: "未探测" },
                { value: "broken", label: "配置有问题" },
              ]}
              placeholder="搜索节点名 / id / 出口 IP…"
            />
            <DataTable
              label="代理节点"
              rows={filtered}
              total={data.proxies.length}
              columns={columns}
              rowKey={(p) => p.id}
              rowTone={(p) => (rows.noteOf(p.id)?.tone === "error" ? "error" : proxyTone(p))}
              selection={{ selected, onChange: setSelected, rowLabel: nameOf }}
              page={view.page_}
              onPageChange={(next) => navigate({ page_: next })}
              expandedRowKey={renaming}
              renderExpanded={(p) => (
                <RenameForm
                  initial={p.name}
                  onCancel={() => setRenaming(null)}
                  onSave={async (name) => {
                    const ok = await rows.apply([p.id], { proxies: { update: { [p.id]: { name } } } }, "已改名", {
                      proxies: { update: { [p.id]: { name: p.name || p.id } } },
                    });
                    if (ok) setRenaming(null);
                  }}
                />
              )}
              empty={
                data.proxies.length === 0 ? (
                  <>
                    <p className="text-heading-16 font-medium">还没有代理</p>
                    <p className="mt-1 text-text-muted">从本机 Clash 导入节点，或添加订阅。</p>
                    <div className="mt-3 flex justify-center gap-2">
                      <SecondaryButton onClick={() => navigate({ tab: "clash" })}>导入 Clash 节点</SecondaryButton>
                      <SecondaryButton onClick={() => navigate({ tab: "subscriptions" })}>添加订阅</SecondaryButton>
                    </div>
                  </>
                ) : (
                  <p className="text-text-muted">没有匹配的节点 —— 换个搜索词或清掉筛选。</p>
                )
              }
            />
          </Panel>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete.length > 0}
        title="删除代理节点"
        confirmLabel="确认删除"
        destructive
        onCancel={() => setPendingDelete([])}
        onConfirm={() => {
          const list = pendingDelete;
          setPendingDelete([]);
          setSelected(new Set());
          void rows.apply(list.map((p) => p.id), { proxies: { delete: list.map((p) => p.id) } }, "已删除");
        }}
      >
        <p>
          将删除 {pendingDelete.length === 1 ? <Mono>{pendingDelete[0]!.name || pendingDelete[0]!.id}</Mono> : `${pendingDelete.length} 个节点`}。
        </p>
        <p>删除会丢掉节点的连接信息，无法在后台撤销；来自订阅或 Clash 的节点在下次刷新、导入时会重新出现。只想暂时不用时选「停用」。</p>
      </ConfirmDialog>
    </div>
  );
}

/** 批测中一个节点的行内状态（成功的那一行照常显示 IP，见状态列）。 */
function BatchNodeCell({ node }: { node: BatchProgressView["nodes"][number] }) {
  switch (node.state) {
    case "queued":
      return <StatusIndicator tone="neutral" icon="○" label="排队中" />;
    case "probing":
      return <StatusIndicator tone="info" icon="◴" label="探测中…" />;
    case "failed":
    case "skipped":
      return (
        <span className="inline-flex items-baseline gap-2">
          <StatusIndicator tone={node.state === "failed" ? "error" : "warn"} icon={node.state === "failed" ? "✕" : "!"} label={node.state === "failed" ? "探测失败" : "已跳过"} />
          <Truncate text={node.reason} maxWidth="16rem" className="text-label-13 text-text-muted" />
        </span>
      );
    case "ok":
      return <StatusIndicator tone="success" icon="✓" label="可用" />;
  }
}

function RenameForm({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  return (
    <form
      aria-label="改名"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        void onSave(name.trim()).finally(() => setSaving(false));
      }}
    >
      <input aria-label="节点名称" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} className={`${FIELD} w-80 max-w-full`} />
      <PrimaryButton type="submit" disabled={saving || name.trim() === ""}>
        保存
      </PrimaryButton>
      <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
    </form>
  );
}

const TABS = [
  { id: "list", label: "节点" },
  { id: "subscriptions", label: "订阅" },
  { id: "clash", label: "Clash" },
] as const;

/**
 * 页内标签。
 *
 * 语义上是 tablist/tab，元素是真实的 `<a href>`：标签状态在 hash 里，中键与
 * 「在新标签页打开」照样可用。点击时调用 `navigate` 而不是只改 href，
 * 让切换标签同时清掉上一个标签的页码（`navigate` 保留同页的其他状态）。
 */
function TabLink({
  id,
  active,
  onSelect,
  label,
}: {
  id: string;
  active: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <a
      role="tab"
      id={`proxy-tab-${id}`}
      href={toHash({ ...parseHash(""), page: "proxy", tab: id })}
      aria-selected={active}
      aria-controls={`proxy-panel-${id}`}
      onClick={(event) => {
        // 修饰键点击交给浏览器（新标签页等）。
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onSelect();
      }}
      className={segmentClass(active)}
    >
      {label}
    </a>
  );
}
