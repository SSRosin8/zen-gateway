import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProxyList, ProxyView, WorkerCreate } from "../../shared/contract.ts";
import { FormStatus, Mono, PrimaryButton, SecondaryButton, Truncate, errorMessage, type FormMessage } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { patchConfig, type FetchState } from "../lib/api.ts";
import { WORKER_CREATE_MAX, bulkAnonymousWorkers, duplicateEgressIds } from "../../shared/workerIds.ts";
import { FIELD } from "../lib/styles.ts";

/**
 * 从 Clash 节点批量创建匿名 Worker。
 *
 * 候选：来自 Clash（`controller` 来源或挂在某个内核上）、已启用、还没被任何
 * Worker 引用的节点。默认全选，可搜索、全选 / 全不选；回显 IP 与别的节点重复的标出来，
 * 一键去掉（共用出口的 Worker 没有隔离意义）。一次 PATCH 提交整批，失败时整批不生效。
 */
export function bulkCandidates(proxies: readonly ProxyView[]): ProxyView[] {
  return proxies.filter((p) => p.enabled && p.usedBy.length === 0 && (p.source === "controller" || p.bridgeId !== null));
}

/**
 * 出口重复的候选：回显 IP 与已被 Worker 使用的节点相同，或与排在前面的另一个候选相同。
 * 建出来的 Worker 会共用出口，隔离没有意义。每个 IP 保留第一个未被占用的候选。
 * 未探测（`egressIp` 为 null）的不算重复：还不知道。
 */
export function duplicateEgress(proxies: readonly ProxyView[], candidates: readonly ProxyView[]): ReadonlySet<string> {
  return duplicateEgressIds(
    proxies.filter((p) => p.usedBy.length > 0 && p.egressIp !== null).map((p) => p.egressIp!),
    candidates,
  );
}

export function BulkImportDialog({
  open,
  proxies,
  existingIds,
  onClose,
  onDone,
}: {
  open: boolean;
  proxies: FetchState<ProxyList> | undefined;
  existingIds: readonly string[];
  onClose: () => void;
  /** 成功后调用，参数是新建的 Worker 数。 */
  onDone: (created: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      searchRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(48rem,calc(100vw-2rem))] zg-scrim rounded-xl border border-border-strong bg-surface p-0 text-text shadow-float"
    >
      {open && (
        <div className="px-5 py-4">
          <h2 id={titleId} className="text-heading-16 font-medium">
            从 Clash 节点导入匿名 Worker
          </h2>
          {proxies?.status === "ready" ? (
            <BulkBody
              candidates={bulkCandidates(proxies.data.proxies)}
              all={proxies.data.proxies}
              existingIds={existingIds}
              searchRef={searchRef}
              onClose={onClose}
              onDone={onDone}
            />
          ) : (
            <div className="mt-3 space-y-3">
              <StatusIndicator
                tone={proxies?.status === "loading" || proxies === undefined ? "neutral" : "error"}
                icon={proxies?.status === "loading" || proxies === undefined ? "○" : "✕"}
                label={
                  proxies?.status === "loading" || proxies === undefined
                    ? "代理列表加载中"
                    : proxies.status === "offline"
                      ? "拿不到代理列表（网关未连接）"
                      : `拿不到代理列表：${proxies.status === "error" ? proxies.message : ""}`
                }
              />
              <div className="flex justify-end">
                <SecondaryButton onClick={onClose}>关闭</SecondaryButton>
              </div>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

function BulkBody({
  candidates,
  all,
  existingIds,
  searchRef,
  onClose,
  onDone,
}: {
  candidates: ProxyView[];
  all: readonly ProxyView[];
  existingIds: readonly string[];
  searchRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onDone: (created: number) => void;
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(candidates.map((p) => p.id)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);

  const duplicates = useMemo(() => duplicateEgress(all, candidates), [all, candidates]);
  const needle = q.trim().toLowerCase();
  const visible = useMemo(
    () =>
      candidates.filter((p) =>
        needle === "" ? true : `${p.name} ${p.clashNodeName ?? ""} ${p.id}`.toLowerCase().includes(needle),
      ),
    [candidates, needle],
  );

  // 提交按候选原顺序排，编号与节点在列表里的顺序一致。
  const chosen = candidates.filter((p) => selected.has(p.id));
  const tooMany = chosen.length > WORKER_CREATE_MAX;

  const setMany = (ids: readonly string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  if (candidates.length === 0) {
    return (
      <div className="mt-3 space-y-3">
        <p className="text-text-muted">
          没有可导入的节点：Clash 节点都已被 Worker 引用、被停用，或还没有导入。先在快速开始或出口页导入 Clash 出口。
        </p>
        <div className="flex justify-end">
          <SecondaryButton onClick={onClose}>关闭</SecondaryButton>
        </div>
      </div>
    );
  }

  const submit = () => {
    const create: WorkerCreate[] = bulkAnonymousWorkers(
      existingIds,
      chosen.map((p) => ({ id: p.id, name: p.clashNodeName ?? p.name })),
    );
    setSaving(true);
    setMessage(null);
    void patchConfig({ workers: { create } })
      .then(() => onDone(create.length))
      .catch((err) => setMessage(errorMessage(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-3 space-y-3">
      <p className="text-text-muted">
        每个选中的节点新建一个匿名 Worker，id 接着现有的 <Mono>anon-N</Mono> 编号，名称为「匿名 · 节点名」。一次提交整批。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span className="text-text-muted">筛选节点</span>
          <input
            ref={searchRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按名称或地区筛选…"
            className={FIELD}
          />
        </label>
        <SecondaryButton onClick={() => setMany(visible.map((p) => p.id), true)}>全选</SecondaryButton>
        <SecondaryButton onClick={() => setMany(visible.map((p) => p.id), false)}>全不选</SecondaryButton>
        {duplicates.size > 0 && (
          <SecondaryButton onClick={() => setMany([...duplicates], false)}>去掉出口重复的（{duplicates.size}）</SecondaryButton>
        )}
      </div>
      <p aria-live="polite">
        已选 <Mono>{chosen.length}</Mono> / {candidates.length} 个节点
        {needle !== "" && <span className="text-text-muted">（当前显示 {visible.length} 个）</span>}
      </p>
      <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto rounded-md border border-border-strong bg-bg p-2" aria-label="候选节点">
        {visible.map((p) => (
          /* 出口信息放在 label 外：复选框的可访问名称只是节点名。 */
          <li key={p.id} className="flex min-h-[36px] items-center gap-2 rounded-xs px-2 hover:bg-surface-hover">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input type="checkbox" checked={selected.has(p.id)} onChange={(e) => setMany([p.id], e.target.checked)} />
              <Truncate text={p.clashNodeName ?? p.name} maxWidth="28rem" />
            </label>
            <span className="inline-flex shrink-0 items-center gap-2 text-label-13 text-text-muted">
              {duplicates.has(p.id) && <StatusIndicator tone="warn" icon="!" label="出口重复" />}
              {p.egressIp === null ? "未探测" : <Mono>{p.egressIp}</Mono>}
            </span>
          </li>
        ))}
        {visible.length === 0 && <li className="px-2 py-2 text-text-muted">没有匹配的节点。</li>}
      </ul>
      {tooMany && (
        <StatusIndicator tone="warn" icon="!" label={`一次最多创建 ${WORKER_CREATE_MAX} 个，请减少选择`} />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <FormStatus message={message} />
        <SecondaryButton onClick={onClose}>取消</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving || chosen.length === 0 || tooMany}>
          {saving ? "创建中…" : `创建 ${chosen.length} 个 Worker`}
        </PrimaryButton>
      </div>
    </div>
  );
}
