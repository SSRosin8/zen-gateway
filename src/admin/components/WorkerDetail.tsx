import { useEffect, useRef } from "react";
import type { StatsView, WorkerView } from "../../shared/contract.ts";
import { Mono, SecondaryButton } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { workerStatus, workerKindLabel } from "../lib/workerView.tsx";
import { formatLocalTime, humanMs } from "../lib/format.ts";

/**
 * Worker 详情侧栏：一个 Worker 的配置、运行态、出口与用量在一处看全，
 * 回答「这个 Worker 为什么没在被用」不必跨四个页面拼信息。
 *
 * 非模态 `<dialog>`（`show()` 而非 `showModal()`）：表格仍可操作，Esc 关闭并把焦点还给
 * 打开前的元素。打开状态在 URL（`?detail=<id>`），可分享、可后退。
 */
export function WorkerDetail({
  worker: w,
  shared,
  stats,
  onClose,
  onEdit,
}: {
  worker: WorkerView;
  shared: boolean;
  stats: StatsView | null;
  onClose: () => void;
  onEdit: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    const d = ref.current;
    if (d !== null && !d.open) d.show();
    d?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, []);

  const s = workerStatus(w);
  const totals = stats?.workers.find((x) => x.workerId === w.id) ?? null;
  const tokens = (stats?.daily.byWorker ?? []).filter((p) => p.key === w.id);
  const input = tokens.reduce((a, p) => a + p.inputTokens, 0);
  const output = tokens.reduce((a, p) => a + p.outputTokens, 0);

  return (
    <dialog
      ref={ref}
      aria-label={`Worker ${w.id} 详情`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      /* 右侧贴边的侧栏；非模态，所以没有遮罩。 */
      className="fixed inset-y-0 right-0 left-auto z-30 m-0 h-full max-h-none w-[min(26rem,100vw)] overflow-y-auto border-l border-border-strong bg-surface p-0 text-text shadow-float"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-heading-16 font-semibold">
            <Mono>{w.id}</Mono>
          </h2>
          {w.name !== "" && <p className="text-text-muted">{w.name}</p>}
        </div>
        <SecondaryButton compact onClick={onClose}>
          关闭
        </SecondaryButton>
      </div>

      <div className="space-y-5 px-5 py-4">
        <section>
          <h3 className="mb-2 text-label-13 font-medium text-text-muted">现在</h3>
          <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-text-muted">类型</dt>
            <dd>{workerKindLabel(w)}</dd>
            <dt className="text-text-muted">启用</dt>
            <dd>{w.enabled ? "是" : "否"}</dd>
            <dt className="text-text-muted">候选池</dt>
            <dd>{w.inPool ? "在" : "不在（停用或缺 key）"}</dd>
            <dt className="text-text-muted">连续失败</dt>
            <dd>{w.consecutiveFails}</dd>
            <dt className="text-text-muted">最近失败</dt>
            <dd>{w.lastFailure ?? <span className="text-text-muted">无</span>}</dd>
            {!w.ready && w.inPool && (
              <>
                <dt className="text-text-muted">冷却剩余</dt>
                <dd>{humanMs(w.cooldownRemainingMs)}</dd>
              </>
            )}
            <dt className="text-text-muted">API key</dt>
            <dd>
              {w.kind === "anonymous" ? (
                <span className="text-text-muted">无需 key</span>
              ) : w.apiKey.present ? (
                <Mono>{w.apiKey.fingerprint}</Mono>
              ) : (
                <span className="text-error">未配置</span>
              )}
            </dd>
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-label-13 font-medium text-text-muted">出口</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-text-muted">绑定</dt>
            <dd>{w.proxyId === null ? "本机直连" : <Mono>{w.proxyId}</Mono>}</dd>
            <dt className="text-text-muted">回显 IP</dt>
            <dd className="inline-flex items-center gap-2">
              {w.egressIp === null ? <span className="text-text-muted">未探测</span> : <Mono>{w.egressIp}</Mono>}
              {shared && <StatusIndicator tone="error" icon="✕" label="与其他 Worker 共用" />}
            </dd>
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-label-13 font-medium text-text-muted">用量</h3>
          {stats === null ? (
            <p className="text-text-muted">统计未加载。</p>
          ) : totals === null && tokens.length === 0 ? (
            <p className="text-text-muted">还没有这个 Worker 的记录。</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              {/* 尝试计数只有累计值（`worker_stats` 不分天），token 来自按天明细：两者口径不同，分别标明。 */}
              <dt className="text-text-muted">上游尝试（累计）</dt>
              <dd>
                {totals?.attempts ?? 0}（成功 {totals?.successes ?? 0} · 失败 {totals?.failures ?? 0}）
              </dd>
              <dt className="text-text-muted">最近状态码</dt>
              <dd>{totals?.lastStatus ?? <span className="text-text-muted">无响应</span>}</dd>
              <dt className="text-text-muted">最近使用</dt>
              <dd>{totals?.lastUsedAt == null ? <span className="text-text-muted">无</span> : formatLocalTime(new Date(totals.lastUsedAt).toISOString())}</dd>
              <dt className="text-text-muted">{stats.sinceDay === null ? "token（全部）" : `token（${stats.sinceDay} 起）`}</dt>
              <dd>
                输入 {input.toLocaleString()} · 输出 {output.toLocaleString()}
              </dd>
            </dl>
          )}
        </section>

        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <SecondaryButton onClick={onEdit}>编辑</SecondaryButton>
          <a href={`#usage?view=worker`} className="inline-flex min-h-[44px] items-center px-2 text-accent-fg underline">
            在用量页查看
          </a>
        </div>
      </div>
    </dialog>
  );
}
