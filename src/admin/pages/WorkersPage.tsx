import { useEffect, useState } from "react";
import type { ConfigPatch, Overview, ProxyList, WorkerView } from "../../shared/contract.ts";
import {
  FormStatus,
  Mono,
  Panel,
  PrimaryButton,
  SecondaryButton,
  Strong,
  Truncate,
  errorMessage,
  type FormMessage,
} from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import { WorkerEditor } from "../components/WorkerEditor.tsx";
import { BulkImportDialog, bulkCandidates } from "../components/BulkImportDialog.tsx";
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
/** 进入 Worker 页时要打开的界面；null 表示正常打开列表。 */
export type WorkerIntent = "create" | "bulk" | null;

export function WorkersPage({
  data,
  view,
  navigate,
  refresh,
  proxies,
  intent = null,
  onIntentConsumed,
}: {
  data: Overview;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
  refresh?: () => void;
  /** 出口下拉框的数据源；拿不到时编辑器退回文本输入。 */
  proxies?: FetchState<ProxyList>;
  /** 从快速开始跳转过来时要打开的界面；取走后调用 `onIntentConsumed` 清空。 */
  intent?: WorkerIntent;
  onIntentConsumed?: () => void;
}) {
  const [editor, setEditor] = useState<"new" | string | null>(intent === "create" ? "new" : null);
  const [saving, setSaving] = useState(false);
  /*
   * 结果显示在触发它的操作旁边：编辑器里的保存失败显示在编辑器的保存按钮旁
   * （表单还开着，用户要在那里改）；成功会收起编辑器，结果与删除结果一起显示在列表上方。
   * `scope` 是编辑器的键（"new" 或 Worker id）或 "list"。
   */
  const [feedback, setFeedback] = useState<{ scope: string; message: FormMessage }>({ scope: "list", message: null });
  const setMessage = (message: FormMessage, scope = "list") => setFeedback({ scope, message });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const [bulkOpen, setBulkOpen] = useState(intent === "bulk");
  const existingIds = data.workers.map((w) => w.id);
  const candidateCount = proxies?.status === "ready" ? bulkCandidates(proxies.data.proxies).length : null;

  useEffect(() => {
    if (intent === null) return;
    if (intent === "create") {
      setMessage(null);
      setEditor("new");
    } else {
      setBulkOpen(true);
    }
    onIntentConsumed?.();
  }, [intent, onIntentConsumed]);

  const save = async (patch: ConfigPatch, success: string, scope: string) => {
    setSaving(true);
    setMessage(null);
    try {
      await patchConfig(patch);
      setEditor(null);
      setMessage({ tone: "success", text: success });
      refresh?.();
    } catch (err) {
      setMessage(errorMessage(err), scope);
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
      /* 出口 IP 与绑定的代理 id 同一行：行高 36px 只容得下单行。 */
      render: (w) => (
        <span className="inline-flex items-baseline gap-2">
          {w.egressIp === null ? (
            <span className="text-text-muted">{w.proxyId === null ? "本机直连" : "未探测"}</span>
          ) : (
            <Mono>{w.egressIp}</Mono>
          )}
          {w.proxyId !== null && (
            <Truncate text={w.proxyId} maxWidth="12rem" className="text-label-13 text-text-muted" />
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
            compact
            onClick={() => {
              setMessage(null);
              setEditor(editor === w.id ? null : w.id);
            }}
          >
            {editor === w.id ? "收起" : "编辑"}
          </SecondaryButton>
          <SecondaryButton compact danger disabled={saving} onClick={() => setPendingDelete(w.id)}>
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
          <span className="flex flex-wrap gap-2">
          <SecondaryButton
            onClick={() => {
              setMessage(null);
              setBulkOpen(true);
            }}
          >
            {candidateCount === null || candidateCount === 0 ? "从 Clash 节点导入" : `从 Clash 节点导入（${candidateCount}）`}
          </SecondaryButton>
          {/* 编辑器打开时它的「保存」是本视图唯一的主操作，这里退为描边按钮。 */}
          {editor === null ? (
            <PrimaryButton
              onClick={() => {
                setMessage(null);
                setEditor("new");
              }}
            >
              新增 Worker
            </PrimaryButton>
          ) : (
            <SecondaryButton
              onClick={() => {
                setMessage(null);
                setEditor(editor === "new" ? null : "new");
              }}
            >
              {editor === "new" ? "收起" : "新增 Worker"}
            </SecondaryButton>
          )}
          </span>
        }
      >
        {editor === "new" && (
          <div className="mb-4 border-b border-border-strong pb-4">
            <WorkerEditor
              mode="create"
              existingIds={existingIds}
              saving={saving}
              proxies={proxies}
              onCancel={() => setEditor(null)}
              message={feedback.scope === "new" ? feedback.message : null}
              onSave={(patch) => save(patch, "已新增", "new")}
            />
          </div>
        )}
        <div className="mb-3">
          <FormStatus message={feedback.scope === "list" ? feedback.message : null} />
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
              message={feedback.scope === w.id ? feedback.message : null}
              onSave={(patch) => save(patch, "已保存", w.id)}
            />
          )}
          empty={
            data.workers.length === 0 ? (
              <>
                <p className="text-heading-16 font-medium">还没有配置 Worker</p>
                <p className="mt-1 text-text-muted">
                  点「新增 Worker」创建一个，或从 Clash 节点批量导入匿名 Worker，保存后立即生效。
                  匿名 Worker 不需要 key；认证 Worker 填你自己的 Zen API key。绑定不同出口才有隔离意义。
                </p>
              </>
            ) : (
              <p className="text-text-muted">没有匹配的 Worker。</p>
            )
          }
        />
      </Panel>

      <BulkImportDialog
        open={bulkOpen}
        proxies={proxies}
        existingIds={existingIds}
        onClose={() => setBulkOpen(false)}
        onDone={(created) => {
          setBulkOpen(false);
          setMessage({ tone: "success", text: `已从 Clash 节点新建 ${created} 个匿名 Worker` });
          refresh?.();
        }}
      />

      <ConfirmDialog
        open={pendingWorker !== null}
        title="删除 Worker"
        confirmLabel="确认删除"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id !== null) void save({ workers: { delete: [id] } }, "已删除", "list");
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

export { proxyOptionLabel } from "../components/WorkerEditor.tsx";
