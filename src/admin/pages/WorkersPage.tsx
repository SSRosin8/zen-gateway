import { useEffect, useId, useRef, useState } from "react";
import type { ConfigPatch, Overview, ProxyList, WorkerView } from "../../shared/contract.ts";
import {
  FormStatus,
  Mono,
  Panel,
  PrimaryButton,
  SecondaryButton,
  Strong,
  errorMessage,
  type FormMessage,
} from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import { workerStatus } from "./OverviewPage.tsx";
import type { ViewState } from "../lib/router.ts";
import { patchConfig, type FetchState } from "../lib/api.ts";

/**
 * Worker 页。
 *
 * 比 Overview 的那张表多几列（类型、连续失败、绑定出口）并且**可筛选、可编辑**——
 * Overview 回答「整体怎么样」，这一页回答「这一个怎么了」。
 *
 * 状态判定复用 `workerStatus` 而不是另写一份：两份必然分叉，而分叉后同一个
 * Worker 在两页显示不同状态，用户会以为其中一页是旧数据。
 *
 * 编辑表单展开在被编辑那一行的正下方（`DataTable` 的 `expandedRowKey`），
 * 新增表单在表格上方。删除前用对话框确认：删掉认证 Worker 等于丢掉它的 key，
 * 后台拿不到原值，无法恢复。
 */
export function WorkersPage({
  data,
  view,
  navigate,
  refresh,
  proxies,
  createRequest = 0,
}: {
  data: Overview;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
  refresh?: () => void;
  /** 出口下拉框的数据源；拿不到时编辑器退回文本输入。 */
  proxies?: FetchState<ProxyList>;
  /** 每次递增表示「打开新增表单」（例如从向导跳转过来）。 */
  createRequest?: number;
}) {
  const [editor, setEditor] = useState<"new" | string | null>(createRequest > 0 ? "new" : null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (createRequest > 0) {
      setMessage(null);
      setEditor("new");
    }
  }, [createRequest]);

  const save = async (patch: ConfigPatch, success: string) => {
    setSaving(true);
    setMessage(null);
    try {
      await patchConfig(patch);
      setEditor(null);
      setMessage({ tone: "success", text: success });
      refresh?.();
    } catch (err) {
      setMessage(errorMessage(err));
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

  const pendingWorker = data.workers.find((w) => w.id === pendingDelete) ?? null;

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
       * 这一列回答 Overview 答不了的问题：一个 Worker 是偶发失败还是持续失败。
       * 冷却剩余只说「现在不能用」，连续次数说「它退避到第几级」—— 一个
       * `consecutiveFails: 6` 的 Worker 即使此刻冷却已过期，下一次失败也会
       * 直接退到分钟级。`bad_request` 不计入（它清零计数），所以这里不代表
       * 客户端在发坏请求。
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
        <span className="flex gap-2">
          <SecondaryButton
            onClick={() => {
              setMessage(null);
              setEditor(editor === w.id ? null : w.id);
            }}
          >
            {editor === w.id ? "收起" : "编辑"}
          </SecondaryButton>
          <SecondaryButton danger disabled={saving} onClick={() => setPendingDelete(w.id)}>
            删除
          </SecondaryButton>
        </span>
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
          <div className="mb-4 border-b border-border-strong pb-4">
            <WorkerEditor
              mode="create"
              saving={saving}
              proxies={proxies}
              onCancel={() => setEditor(null)}
              onSave={(patch) => save(patch, "已新增")}
            />
          </div>
        )}
        <div className="mb-3">
          <FormStatus message={message} />
        </div>
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
          label="Worker 列表"
          rows={filtered}
          columns={columns}
          rowKey={(w) => w.id}
          rowTone={(w) => workerStatus(w).tone}
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
              onSave={(patch) => save(patch, "已保存")}
            />
          )}
          empty={
            data.workers.length === 0 ? (
              <>
                <p className="font-serif text-lg">还没有配置 Worker</p>
                <p className="mt-1 text-text-muted">
                  点「新增 Worker」创建一个，保存后立即生效。匿名 Worker 不需要 key；
                  认证 Worker 填你自己的 Zen API key。绑定不同出口才有隔离意义。
                </p>
              </>
            ) : (
              <p className="text-text-muted">没有匹配的 Worker。</p>
            )
          }
        />
      </Panel>

      <ConfirmDialog
        open={pendingWorker !== null}
        title="删除 Worker"
        confirmLabel="确认删除"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id !== null) void save({ workers: { delete: [id] } }, "已删除");
        }}
      >
        <p>
          将删除 Worker <Mono>{pendingWorker?.id ?? ""}</Mono>
          {pendingWorker !== null && pendingWorker.name !== "" && <>（{pendingWorker.name}）</>}。
        </p>
        {pendingWorker?.kind === "authenticated" && pendingWorker.apiKey.present && (
          <p>
            它保存的 API key <Strong>无法从后台找回</Strong>：后台只保存指纹，删除后要重新填写原 key。
          </p>
        )}
        <p>它的冷却与失败计数也会一起清除。</p>
      </ConfirmDialog>

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

const INPUT = "min-h-[44px] rounded-sm border border-border-strong bg-bg px-3";

/** 出口下拉框里一个选项的文案：名称 + id + 已知的回显 IP，停用的标出来。 */
export function proxyOptionLabel(p: ProxyList["proxies"][number]): string {
  const parts = [p.name !== "" && p.name !== p.id ? `${p.name}（${p.id}）` : p.id];
  if (p.egressIp !== null) parts.push(p.egressIp);
  if (!p.enabled) parts.push("已停用");
  return parts.join(" · ");
}

function ProxyField({
  value,
  onChange,
  proxies,
}: {
  value: string;
  onChange: (next: string) => void;
  proxies: FetchState<ProxyList> | undefined;
}) {
  const hintId = useId();
  if (proxies?.status !== "ready") {
    const why =
      proxies === undefined || proxies.status === "loading"
        ? "代理列表加载中，可先直接填写代理 id。"
        : proxies.status === "offline"
          ? "拿不到代理列表（网关未连接），请直接填写代理 id。"
          : `拿不到代理列表（${proxies.message}），请直接填写代理 id。`;
    return (
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">出口代理 ID（留空为本机直连）</span>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby={hintId}
            className={INPUT}
          />
        </label>
        <span id={hintId} className="text-text-muted">
          {why}
        </span>
      </div>
    );
  }

  const list = proxies.data.proxies;
  // 当前绑定的 id 不在列表里（配置里引用了已删除的代理）时仍要能显示并保留它。
  const missing = value !== "" && !list.some((p) => p.id === value);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text-muted">出口代理</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        <option value="">本机直连</option>
        {missing && <option value={value}>{value} · 不在代理列表中</option>}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {proxyOptionLabel(p)}
          </option>
        ))}
      </select>
    </label>
  );
}

function WorkerEditor({
  mode,
  worker,
  saving,
  proxies,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  worker?: WorkerView;
  saving: boolean;
  proxies: FetchState<ProxyList> | undefined;
  onCancel: () => void;
  onSave: (patch: ConfigPatch) => Promise<void>;
}) {
  const [id, setId] = useState(worker?.id ?? "");
  const [name, setName] = useState(worker?.name ?? "");
  const [kind, setKind] = useState<"anonymous" | "authenticated">(worker?.kind ?? "authenticated");
  const [apiKey, setApiKey] = useState("");
  const [proxyId, setProxyId] = useState(worker?.proxyId ?? "");
  const [enabled, setEnabled] = useState(worker?.enabled ?? true);
  const firstField = useRef<HTMLInputElement>(null);

  // 打开时把焦点放到第一个可编辑字段：编辑表单插在表格中间，不移焦点的话
  // 键盘用户还停在「编辑」按钮上，不知道表单出现在哪里。
  useEffect(() => {
    firstField.current?.focus();
  }, []);

  /*
   * 认证 Worker 必须有 key（配置 schema 会拒绝空 key），所以「清空 key」不能
   * 单独存在。要去掉一个认证 Worker 的 key，就是把它改成匿名 Worker ——
   * 服务端会同时丢弃已保存的 key。这里把这个后果说出来。
   */
  const dropsSavedKey = mode === "edit" && worker?.kind === "authenticated" && kind === "anonymous";

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      aria-label={mode === "create" ? "新增 Worker" : `编辑 Worker ${worker?.id ?? ""}`}
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
              ...(kind === "authenticated" && apiKey !== "" ? { apiKey: { set: apiKey } } : {}),
            },
          },
        };
        void onSave({ workers: update });
      }}
    >
      {mode === "create" ? (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">ID</span>
          <input
            ref={firstField}
            required
            value={id}
            onChange={(e) => setId(e.target.value)}
            className={INPUT}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">名称</span>
          <input
            ref={firstField}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">类型</span>
        <select
          value={kind}
          onChange={(e) => {
            const nextKind = e.target.value as "anonymous" | "authenticated";
            setKind(nextKind);
            // 匿名身份不收集凭证；切换时也丢掉尚未提交的认证 key。
            if (nextKind === "anonymous") setApiKey("");
          }}
          className={INPUT}
        >
          <option value="authenticated">认证 Worker</option>
          <option value="anonymous">匿名 Worker</option>
        </select>
      </label>
      {mode === "create" && (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </label>
      )}
      {kind === "authenticated" && (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">API key（认证必填）</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={mode === "edit" && worker?.apiKey.present ? "留空表示不修改" : "必填"}
            className={INPUT}
          />
        </label>
      )}
      <ProxyField value={proxyId} onChange={setProxyId} proxies={proxies} />
      <label className="flex min-h-[44px] items-center gap-2 self-end">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
      </label>
      {mode === "edit" && kind === "authenticated" && worker?.apiKey.present && (
        <p className="text-text-muted sm:col-span-2">
          认证 Worker 必须有 key。要去掉已保存的 key，把类型改为匿名 Worker。
        </p>
      )}
      {dropsSavedKey && (
        <p className="sm:col-span-2" data-drops-key="">
          <StatusIndicator
            tone="warn"
            icon="!"
            label="改为匿名后，已保存的 API key 会被删除且无法从后台找回。"
          />
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
      </div>
    </form>
  );
}
