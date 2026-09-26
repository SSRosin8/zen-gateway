import { useState } from "react";
import type { ConfigPatch, Overview, WorkerView } from "../../shared/contract.ts";
import { Mono, Panel, PrimaryButton, Strong } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import { workerStatus } from "./OverviewPage.tsx";
import type { ViewState } from "../lib/router.ts";
import { patchConfig } from "../lib/api.ts";

/**
 * Worker 页。
 *
 * 比 Overview 的那张表多两列（连续失败、绑定出口的可读形态）并且**可筛选**——
 * Overview 回答「整体怎么样」，这一页回答「这一个怎么了」。
 *
 * 状态判定复用 `workerStatus`（Overview 页导出的那个）而不是另写一份:
 * 两份必然分叉,而分叉后同一个 Worker 在两页显示不同状态 —— 用户会以为
 * 其中一页是旧数据。
 */
export function WorkersPage({
  data,
  view,
  navigate,
  refresh,
}: {
  data: Overview;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
  refresh?: () => void;
}) {
  const [editor, setEditor] = useState<"new" | string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const removeWorker = async (id: string) => {
    setSaving(true);
    setMessage(null);
    try {
      await patchConfig({ workers: { delete: [id] } });
      setEditor(null);
      setMessage("已删除");
      refresh?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
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
    return true;
  });

  const columns: ReadonlyArray<Column<WorkerView>> = [
    {
      key: "id",
      header: "Worker",
      render: (w) => (
        <span>
          <Mono>{w.id}</Mono>
          {w.name !== "" && <span className="ml-2 text-text-muted">{w.name}</span>}
        </span>
      ),
    },
    {
      key: "kind",
      header: "类型",
      render: (w) => <span>{w.kind === "anonymous" ? "匿名" : "认证"}</span>,
    },
    {
      key: "status",
      header: "状态",
      render: (w) => {
        const s = workerStatus(w);
        return <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />;
      },
    },
    {
      key: "egress",
      header: "出口",
      render: (w) => (
        <span>
          {w.egressIp === null ? (
            <span className="text-text-muted">{w.proxyId === null ? "本机直连" : "未探测"}</span>
          ) : (
            <Mono>{w.egressIp}</Mono>
          )}
          {w.proxyId !== null && (
            <span className="block truncate text-text-muted" style={{ maxWidth: "16rem" }}>
              {w.proxyId}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "fails",
      header: "连续失败",
      numeric: true,
      /*
       * 这一列回答一个 Overview 答不了的问题:**一个 Worker 是在偶发失败还是
       * 在持续失败**。冷却剩余只说「现在不能用」，而连续次数说「它退避到第几级」
       * —— 一个 `consecutiveFails: 6` 的 Worker 即使此刻冷却已过期，
       * 下一次失败也会直接退到分钟级。
       *
       * ⚠️ 这里先前写的是「连续失败 12 次却从未冷却 = 客户端在发坏请求」，
       * 而那个场景**在 UI 上永远显示不出来**：`bad_request` 走
       * `markNotBlamed`（清零），压根到不了计数那一步。第十轮审核实测确认。
       */
      render: (w) => (
        <span className={w.consecutiveFails > 0 ? "text-warn" : "text-text-muted"}>
          {w.consecutiveFails}
        </span>
      ),
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
        <>
          <button
            type="button"
            className="min-h-[44px] rounded-xs border border-border-strong px-3"
            onClick={() => {
              setMessage(null);
              setEditor(editor === w.id ? null : w.id);
            }}
          >
            {editor === w.id ? "收起" : "编辑"}
          </button>
          <button
            type="button"
            disabled={saving}
            className="ml-2 min-h-[44px] rounded-xs border border-error px-3 text-error disabled:cursor-not-allowed"
            onClick={() => void removeWorker(w.id)}
          >
            删除
          </button>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Panel
        title={`Worker（${filtered.length}/${data.workers.length}）`}
        action={
          <PrimaryButton
            onClick={() => {
              setMessage(null);
              setEditor(editor === "new" ? null : "new");
            }}
          >
            {editor === "new" ? "收起" : "新增 Worker"}
          </PrimaryButton>
        }
      >
        {editor === "new" && (
          <WorkerEditor
            mode="create"
            saving={saving}
            onCancel={() => setEditor(null)}
            onSave={async (patch) => {
              setSaving(true);
              setMessage(null);
              try {
                await patchConfig(patch);
                setEditor(null);
                setMessage("已保存");
                refresh?.();
              } catch (err) {
                setMessage(err instanceof Error ? err.message : String(err));
              } finally {
                setSaving(false);
              }
            }}
          />
        )}
        {message !== null && <p className="mb-3 text-text-muted">{message}</p>}
        <TableFilters
          q={view.q}
          onQ={(next) => navigate({ q: next, page_: 1 })}
          status={view.status}
          onStatus={(next) => navigate({ status: next, page_: 1 })}
          statuses={[
            { value: "ready", label: "就绪" },
            { value: "cooling", label: "冷却中" },
            { value: "unusable", label: "不可用" },
          ]}
          placeholder="搜索 id / 名称 / 出口 IP…"
        />
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(w) => w.id}
          rowTone={(w) => workerStatus(w).tone}
          page={view.page_}
          onPageChange={(next) => navigate({ page_: next })}
          empty={
            data.workers.length === 0 ? (
              <>
                <p className="font-serif text-lg">还没有配置 Worker</p>
                <p className="mt-1 text-text-muted">
                  转发需要至少一个带 Zen API key 的 Worker。每个 key 一条，
                  绑不同出口才有隔离意义。
                </p>
              </>
            ) : (
              <p className="text-text-muted">没有匹配的 Worker。</p>
            )
          }
        />
        {filtered.map((w) =>
          editor === w.id ? (
            <WorkerEditor
              key={`editor-${w.id}`}
              mode="edit"
              worker={w}
              saving={saving}
              onCancel={() => setEditor(null)}
              onSave={async (patch) => {
                setSaving(true);
                setMessage(null);
                try {
                  await patchConfig(patch);
                  setEditor(null);
                  setMessage("已保存");
                  refresh?.();
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err));
                } finally {
                  setSaving(false);
                }
              }}
            />
          ) : null,
        )}
      </Panel>

      <Panel title="说明">
        <ul className="space-y-2 text-text-muted">
          <li>
            <Strong>「已启用」不等于「在候选池里」</Strong> —— 认证 Worker 还要求 API key
            非空；匿名 Worker 可以不填 key，并按免鉴权请求参与调度。
          </li>
          <li>
            <Strong>冷却是分级的</Strong>：限流尊重上游的 <Mono>Retry-After</Mono>（默认 15 分钟）、
            鉴权失败固定 60 秒短退避、传输失败指数退避。
            <Mono>bad_request</Mono> <Strong>不冷却</Strong> —— 一次坏请求不该打掉所有健康 Worker。
          </li>
          <li>
            <Strong>冷却只延长不缩短</Strong>：并发失败乱序到达时，一次传输失败的 2 秒
            不能覆盖 429 的 15 分钟。
          </li>
        </ul>
      </Panel>
    </div>
  );
}

function WorkerEditor({
  mode,
  worker,
  saving,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  worker?: WorkerView;
  saving: boolean;
  onCancel: () => void;
  onSave: (patch: ConfigPatch) => Promise<void>;
}) {
  const [id, setId] = useState(worker?.id ?? "");
  const [name, setName] = useState(worker?.name ?? "");
  const [kind, setKind] = useState<"anonymous" | "authenticated">(worker?.kind ?? "authenticated");
  const [apiKey, setApiKey] = useState("");
  const [proxyId, setProxyId] = useState(worker?.proxyId ?? "");
  const [enabled, setEnabled] = useState(worker?.enabled ?? true);
  const [clearKey, setClearKey] = useState(false);

  return (
    <form
      className="mb-4 grid gap-3 border-b border-border-strong pb-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const proxy = proxyId.trim() === "" ? null : proxyId.trim();
        if (mode === "create") {
          void onSave({
            workers: {
              create: [{
                id: id.trim(),
                name,
                kind,
                // 匿名身份不采集 key，但请求契约仍显式给出空值。
                apiKey: kind === "authenticated" ? apiKey : "",
                proxyId: proxy,
                enabled,
              }],
            },
          });
          return;
        }
        const update: ConfigPatch["workers"] = {
          update: {
            [worker!.id]: {
              kind,
              name,
              enabled,
              proxyId: proxy,
              ...(kind === "authenticated"
                ? clearKey
                  ? { apiKey: { clear: true } }
                  : apiKey !== ""
                    ? { apiKey: { set: apiKey } }
                    : {}
                : {}),
            },
          },
        };
        void onSave({ workers: update });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">ID</span>
        <input
          required
          disabled={mode === "edit"}
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">类型</span>
        <select
          value={kind}
          onChange={(e) => {
            const nextKind = e.target.value as "anonymous" | "authenticated";
            setKind(nextKind);
            if (nextKind === "anonymous") {
              // 匿名身份不收集凭证；切换时也丢掉尚未提交的认证 key。
              setApiKey("");
              setClearKey(false);
            }
          }}
          className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
        >
          <option value="authenticated">认证 Worker</option>
          <option value="anonymous">匿名 Worker</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3" />
      </label>
      {kind === "authenticated" && (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">API key（认证必填）</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={mode === "edit" && worker?.apiKey.present ? "留空表示不修改" : "必填"}
            className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">出口代理 ID（留空为直连）</span>
        <input value={proxyId} onChange={(e) => setProxyId(e.target.value)} className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3" />
      </label>
      <label className="flex items-center gap-2 self-end min-h-[44px]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
      </label>
      {mode === "edit" && kind === "authenticated" && worker?.apiKey.present && (
        <label className="flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> 清空当前 key
        </label>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <PrimaryButton type="submit" onClick={() => undefined} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </PrimaryButton>
        <button type="button" onClick={onCancel} className="min-h-[44px] rounded-xs border border-border-strong px-3">
          取消
        </button>
      </div>
    </form>
  );
}
