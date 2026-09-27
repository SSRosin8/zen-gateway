import { useEffect, useRef, useState } from "react";
import type { ConfigPatch, Overview, ProxyList, StatsView, WorkerView } from "../../shared/contract.ts";
import { FormStatus, Mono, PageHeader, Panel, PrimaryButton, SecondaryButton, Strong, Truncate, errorMessage, type FormMessage } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { BulkBar, DataTable, RowNoteView, TableFilters, type Column } from "../components/DataTable.tsx";
import { RowMenu } from "../components/RowMenu.tsx";
import { WorkerEditor } from "../components/WorkerEditor.tsx";
import { WorkerDetail } from "../components/WorkerDetail.tsx";
import { BulkImportDialog, bulkCandidates } from "../components/BulkImportDialog.tsx";
import { EgressCell, probeTargets, workerKindLabel, workerStatus } from "../lib/workerView.tsx";
import type { ViewState } from "../lib/router.ts";
import { patchConfig, type FetchState, type ProbeRun } from "../lib/api.ts";
import { UNDO_WINDOW_MS, useRowNotes } from "../lib/rowNotes.ts";
import { copyText } from "../lib/clipboard.ts";

/**
 * Worker 页 —— 日常的主工作台。
 *
 * - **列表**：可筛选、多选批量（启用 / 停用 / 删除），行内编辑，操作结果与撤销留在对应行。
 * - 回显出口一列标出共用；「共用出口」筛选只留下这些 Worker（出口隔离是 Worker 的问题，所以在这里，不在出口页）。
 * - 「探测在用出口」逐个进行，状态归 App（离开本页不中断，侧栏显示进度）。
 * - 详情侧栏（`?detail=<id>`）聚合配置、运行态、用量与出口，可分享、可后退。
 *
 * 删除匿名 Worker 可以撤销（它没有凭证，能完整重建）；删除认证 Worker 丢掉的 key 后台
 * 拿不回来，所以那一种先确认。
 */
export function WorkersPage({
  data,
  view,
  navigate,
  refresh,
  proxies,
  probe,
  stats = null,
}: {
  data: Overview;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
  refresh?: () => void;
  /** 出口下拉框的数据源；拿不到时编辑器退回文本输入。 */
  proxies?: FetchState<ProxyList>;
  /** 出口探测（状态归 App）。不传时本页不提供探测（测试用）。 */
  probe?: ProbeRun;
  /** 详情侧栏里的用量；拿不到时侧栏不显示用量。 */
  stats?: StatsView | null;
}) {
  const [editor, setEditor] = useState<"new" | string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorMessage, setEditorMessage] = useState<FormMessage>(null);
  const [listMessage, setListMessage] = useState<FormMessage>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<readonly WorkerView[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const rows = useRowNotes(refresh);
  const deletion = useUndoableDelete(setListMessage, refresh);
  // 列表上方只有一条消息：新的结果替换上一条，上一次删除的「撤销」也随之收起。
  const say = (m: FormMessage) => {
    deletion.dismiss();
    setListMessage(m);
  };

  const existingIds = data.workers.map((w) => w.id);
  const candidateCount = proxies?.status === "ready" ? bulkCandidates(proxies.data.proxies).length : null;
  const sharedIds = new Set(data.isolation.sharedGroups.flatMap((g) => g.workerIds));
  const targets = probeTargets(data.workers);

  const saveEditor = async (patch: ConfigPatch, success: string, key: string) => {
    setSaving(true);
    setEditorMessage(null);
    try {
      await patchConfig(patch);
      setEditor(null);
      if (key === "new") say({ tone: "success", text: success });
      else rows.set([key], { tone: "success", text: success });
      refresh?.();
    } catch (err) {
      setEditorMessage(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = (list: readonly WorkerView[], enabled: boolean) => {
    const patch = { workers: { update: Object.fromEntries(list.map((w) => [w.id, { enabled }])) } };
    const undo = { workers: { update: Object.fromEntries(list.map((w) => [w.id, { enabled: w.enabled }])) } };
    void rows.apply(list.map((w) => w.id), patch, enabled ? "已启用" : "已停用", undo);
  };

  /** 匿名 Worker 删除后可撤销：按原样重建（它没有凭证）。含认证 Worker 时先确认。 */
  const remove = (list: readonly WorkerView[]) => {
    if (list.some((w) => w.kind === "authenticated")) {
      setPendingDelete(list);
      return;
    }
    const undo = {
      workers: {
        create: list.map((w) => ({ id: w.id, name: w.name, kind: w.kind, apiKey: "", proxyId: w.proxyId, enabled: w.enabled })),
      },
    };
    setSelected(new Set());
    // 被删的行已不在表里：结果与撤销放到列表上方，10 秒内有效。
    void deletion.run(list.map((w) => w.id), undo);
  };

  const q = view.q.trim().toLowerCase();
  const filtered = data.workers.filter((w) => {
    if (q !== "") {
      const haystack = `${w.id} ${w.name} ${w.proxyId ?? ""} ${w.egressIp ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (view.status === "ready" && !w.ready) return false;
    if (view.status === "cooling" && (w.ready || !w.inPool)) return false;
    if (view.status === "unusable" && w.inPool) return false;
    if (view.status === "shared" && !sharedIds.has(w.id)) return false;
    return true;
  });
  const chosen = data.workers.filter((w) => selected.has(w.id));
  const detail = view.detail === null ? null : (data.workers.find((w) => w.id === view.detail) ?? null);

  const columns: ReadonlyArray<Column<WorkerView>> = [
    {
      key: "id",
      header: "Worker",
      render: (w) => (
        <a
          href={`#workers?detail=${encodeURIComponent(w.id)}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate({ detail: w.id });
          }}
          className="no-underline hover:underline"
        >
          <Mono>{w.id}</Mono>
          {w.name !== "" && <Truncate text={w.name} maxWidth="14rem" className="ml-2 text-text-muted" />}
        </a>
      ),
    },
    { key: "kind", header: "类型", render: (w) => <span>{workerKindLabel(w)}</span> },
    {
      key: "status",
      header: "状态",
      render: (w) => {
        const note = rows.noteOf(w.id);
        if (note !== undefined) return <RowNoteView note={note} busy={rows.busy} onUndo={() => void rows.runUndo(w.id)} />;
        const s = workerStatus(w);
        return <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />;
      },
    },
    {
      key: "egress",
      header: "回显出口",
      render: (w) => <EgressCell w={w} shared={sharedIds.has(w.id)} probe={probe ?? IDLE_PROBE} />,
    },
    {
      key: "fails",
      header: "连续失败",
      numeric: true,
      // 偶发还是持续：连续次数说明退避到第几级（`bad_request` 不计入）。
      render: (w) => <span className={w.consecutiveFails > 0 ? "text-warn" : "text-text-muted"}>{w.consecutiveFails}</span>,
    },
    {
      key: "key",
      header: "API key",
      render: (w) =>
        w.kind === "anonymous" ? (
          <span className="text-text-muted">无需 key</span>
        ) : w.apiKey.present ? (
          <Mono>{w.apiKey.fingerprint}</Mono>
        ) : (
          <span className="text-error">未配置</span>
        ),
    },
    {
      key: "actions",
      header: "操作",
      render: (w) => (
        <span className="flex gap-2">
          <SecondaryButton
            compact
            onClick={() => {
              setEditorMessage(null);
              setEditor(editor === w.id ? null : w.id);
            }}
          >
            {editor === w.id ? "收起" : "编辑"}
          </SecondaryButton>
          <SecondaryButton compact disabled={rows.busy} onClick={() => setEnabled([w], !w.enabled)}>
            {w.enabled ? "停用" : "启用"}
          </SecondaryButton>
          <RowMenu
            label={`${w.id} 的更多操作`}
            items={[
              { label: "查看详情", onSelect: () => navigate({ detail: w.id }) },
              { label: "复制 id", onSelect: () => void copyText(w.id).then((ok) => rows.set([w.id], ok ? { tone: "success", text: "已复制 id" } : { tone: "error", text: "复制失败，请手动选中" })) },
              { label: "删除", danger: true, onSelect: () => remove([w]) },
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Worker"
        status={`${data.pool.ready}/${data.pool.total} 就绪${data.isolation.sharedGroups.length > 0 ? ` · ${data.isolation.sharedGroups.length} 组共用出口` : ""}`}
        action={
          <>
            {probe !== undefined && probe.running && <SecondaryButton onClick={probe.stop}>停止探测</SecondaryButton>}
            {probe !== undefined && (
              <SecondaryButton onClick={() => void probe.run(targets)} disabled={probe.running || targets.length === 0}>
                {probe.running ? `探测中 ${probe.done}/${probe.total ?? 0}` : "探测在用出口"}
              </SecondaryButton>
            )}
            <SecondaryButton
              onClick={() => {
                say(null);
                setBulkOpen(true);
              }}
            >
              {candidateCount === null || candidateCount === 0 ? "从 Clash 节点导入" : `从 Clash 节点导入（${candidateCount}）`}
            </SecondaryButton>
            {/* 编辑器打开时它的「保存」是本视图唯一的主操作，这里退为描边按钮。 */}
            {editor === null ? (
              <PrimaryButton onClick={() => setEditor("new")}>新增 Worker</PrimaryButton>
            ) : (
              <SecondaryButton onClick={() => setEditor(editor === "new" ? null : "new")}>{editor === "new" ? "收起" : "新增 Worker"}</SecondaryButton>
            )}
          </>
        }
      />

      {probe !== undefined && <ProbeSummary probe={probe} />}

      {editor === "new" && (
        <Panel title="新增 Worker">
          <WorkerEditor
            mode="create"
            existingIds={existingIds}
            saving={saving}
            proxies={proxies}
            onCancel={() => setEditor(null)}
            message={editorMessage}
            onSave={(patch) => saveEditor(patch, "已新增", "new")}
          />
        </Panel>
      )}

      <Panel title={`Worker（${filtered.length}/${data.workers.length}）`} hint={<WorkerRules />}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <FormStatus message={listMessage} />
            {deletion.canUndo && (
              <SecondaryButton compact disabled={deletion.busy} onClick={() => void deletion.undo()}>
                撤销
              </SecondaryButton>
            )}
          </div>
          <BulkBar count={chosen.length} onClear={() => setSelected(new Set())}>
            <SecondaryButton compact disabled={rows.busy} onClick={() => setEnabled(chosen, true)}>
              启用
            </SecondaryButton>
            <SecondaryButton compact disabled={rows.busy} onClick={() => setEnabled(chosen, false)}>
              停用
            </SecondaryButton>
            <SecondaryButton compact danger disabled={rows.busy} onClick={() => remove(chosen)}>
              删除
            </SecondaryButton>
          </BulkBar>
          <TableFilters
            q={view.q}
            onQ={(next) => navigate({ q: next, page_: 1 })}
            status={view.status}
            onStatus={(next) => navigate({ status: next, page_: 1 })}
            statuses={[
              { value: "ready", label: "就绪" },
              { value: "cooling", label: "冷却中" },
              { value: "unusable", label: "不可用" },
              { value: "shared", label: "共用出口" },
            ]}
            placeholder="搜索 id / 名称 / 出口 IP…"
          />
          <DataTable
            label="Worker 列表"
            rows={filtered}
            total={data.workers.length}
            columns={columns}
            rowKey={(w) => w.id}
            rowTone={(w) => (rows.noteOf(w.id)?.tone === "error" ? "error" : workerStatus(w).tone)}
            selection={{ selected, onChange: setSelected, rowLabel: (id) => id }}
            page={view.page_}
            onPageChange={(next) => navigate({ page_: next })}
            expandedRowKey={editor === "new" ? null : editor}
            renderExpanded={(w) => (
              <WorkerEditor
                key={`editor-${w.id}`}
                mode="edit"
                worker={w}
                saving={saving}
                proxies={proxies}
                onCancel={() => setEditor(null)}
                message={editorMessage}
                onSave={(patch) => saveEditor(patch, "已保存", w.id)}
              />
            )}
            empty={
              data.workers.length === 0 ? (
                <>
                  <p className="text-heading-16 font-medium">还没有配置 Worker</p>
                  <p className="mt-1 text-text-muted">匿名 Worker 不需要 key；认证 Worker 填你自己的 Zen API key。绑定不同出口才有隔离意义。</p>
                  <div className="mt-3 flex justify-center gap-2">
                    <SecondaryButton onClick={() => setEditor("new")}>新增 Worker</SecondaryButton>
                    <SecondaryButton onClick={() => setBulkOpen(true)}>从 Clash 节点导入</SecondaryButton>
                  </div>
                </>
              ) : (
                <p className="text-text-muted">没有匹配的 Worker。</p>
              )
            }
          />
        </Panel>

      {detail !== null && (
        <WorkerDetail
          worker={detail}
          shared={sharedIds.has(detail.id)}
          stats={stats}
          onClose={() => navigate({ detail: null })}
          onEdit={() => {
            navigate({ detail: null });
            setEditor(detail.id);
          }}
        />
      )}

      <BulkImportDialog
        open={bulkOpen}
        proxies={proxies}
        existingIds={existingIds}
        onClose={() => setBulkOpen(false)}
        onDone={(created) => {
          setBulkOpen(false);
          say({ tone: "success", text: `已从 Clash 节点新建 ${created} 个匿名 Worker` });
          refresh?.();
        }}
      />

      <ConfirmDialog
        open={pendingDelete.length > 0}
        title="删除 Worker"
        confirmLabel="确认删除"
        destructive
        onCancel={() => setPendingDelete([])}
        onConfirm={() => {
          const list = pendingDelete;
          setPendingDelete([]);
          setSelected(new Set());
          void rows.apply(list.map((w) => w.id), { workers: { delete: list.map((w) => w.id) } }, "已删除").then((ok) => {
            if (ok) say({ tone: "success", text: `已删除 ${list.map((w) => w.id).join("、")}` });
          });
        }}
      >
        <p>将删除 {pendingDelete.length === 1 ? <Mono>{pendingDelete[0]!.id}</Mono> : `${pendingDelete.length} 个 Worker`}。</p>
        <p>
          其中的认证 Worker 保存的 API key <Strong>无法从后台找回</Strong>：后台只保存指纹，删除后要重新填写原 key，所以这次不能撤销。
        </p>
        <p>它们的冷却与失败计数也会一起清除。</p>
      </ConfirmDialog>
    </div>
  );
}

/** 没有探测能力时（测试或未装配）出口列照常显示已保存的 IP 与共用标记。 */
const IDLE_PROBE: ProbeRun = { running: false, total: null, done: 0, results: {}, current: null, error: null, run: async () => {}, stop: () => {} };

/**
 * 可撤销的删除：被删的行已离开表格，所以提示与「撤销」在列表上方；10 秒后撤销失效。
 * 提示写进列表的那一条消息（与新增、导入共用），后来的操作结果自然覆盖它。
 * 撤销 = 按原样重建（只用于匿名 Worker，它们没有凭证）。
 */
function useUndoableDelete(setMessage: (m: FormMessage) => void, refresh?: () => void) {
  const [undoPatch, setUndoPatch] = useState<ConfigPatch | null>(null);
  const [busy, setBusy] = useState(false);
  // ref 而不是 state：连续删除时要清掉的是上一个计时器本身，而不是渲染时闭包里的旧值。
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);
  const expireLater = () => {
    stopTimer();
    timer.current = setTimeout(() => setUndoPatch(null), UNDO_WINDOW_MS);
  };
  return {
    busy,
    canUndo: undoPatch !== null,
    dismiss: () => {
      stopTimer();
      setUndoPatch(null);
    },
    run: async (ids: readonly string[], undo: ConfigPatch) => {
      setBusy(true);
      try {
        await patchConfig({ workers: { delete: [...ids] } });
        setMessage({ tone: "success", text: `已删除 ${ids.join("、")}` });
        setUndoPatch(undo);
        expireLater();
        refresh?.();
      } catch (err) {
        setMessage(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    undo: async () => {
      if (undoPatch === null) return;
      setBusy(true);
      try {
        await patchConfig(undoPatch);
        stopTimer();
        setUndoPatch(null);
        setMessage({ tone: "success", text: "已撤销删除" });
        refresh?.();
      } catch (err) {
        setMessage(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** 探测结果一行：本轮探了几个、几个失败、出错原因。 */
function ProbeSummary({ probe }: { probe: ProbeRun }) {
  return (
    <div aria-live="polite">
      {probe.error !== null && (
        <p role="alert">
          <StatusIndicator tone="error" icon="✕" label={`探测失败：${probe.error}`} />
        </p>
      )}
      {!probe.running && probe.total !== null && probe.error === null && (
        <p className="text-text-muted">
          本轮探测了 {probe.done}/{probe.total} 个出口，{Object.values(probe.results).filter((r) => !r.ok).length} 个失败。
          仅反映 IP 回显目标的出口，Zen 实际出口需核对发往 opencode.ai 的连接。
        </p>
      )}
    </div>
  );
}

/** 状态与冷却规则：只在需要时查看，收进面板标题旁的 ⓘ。 */
function WorkerRules() {
  return (
    <span className="block space-y-2">
      <span className="block">
        <Strong>「已启用」不等于「在候选池里」</Strong>：认证 Worker 还要求 API key 非空；匿名 Worker 可以不填 key。
      </span>
      <span className="block">
        <Strong>冷却是分级的</Strong>：限流尊重上游的 <Mono>Retry-After</Mono>（默认 15 分钟）、鉴权失败 60 秒、传输失败指数退避；
        <Mono>bad_request</Mono> 不冷却。冷却只延长不缩短。
      </span>
      <span className="block">
        「回显出口」列是 IP 回显目标看到的出口，Zen 实际出口需核对发往 opencode.ai 的连接；标「共用」的 Worker 出口相同。
        已保存的 IP 是最后一次成功探测的结果，不代表当前仍然可用。
      </span>
    </span>
  );
}

export { proxyOptionLabel } from "../components/WorkerEditor.tsx";
