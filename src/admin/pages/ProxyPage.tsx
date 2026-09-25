import { useCallback, useEffect, useState } from "react";
import type { ProxyList, ProxyView } from "../../shared/contract.ts";
import { isActive, percentages, type BatchProgress } from "../../shared/batchProbe.ts";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Metric, Mono, Panel, PrimaryButton } from "../components/Panel.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import type { ViewState } from "../lib/router.ts";
import { useBatchProbe } from "../lib/api.ts";

/**
 * 代理池页。
 *
 * 两个标签：**列表**（分页）与**出口隔离**（不分页）。
 *
 * 隔离视图刻意不分页 —— 规划明确：那个任务本身就是「一眼看全、找出共用出口
 * 的节点」，分页会破坏它的意义。数量大时靠浏览器原生滚动，而不是切成 6 页
 * 让用户在页间比对 IP。
 */

function proxyTone(p: ProxyView): "success" | "warn" | "error" | "neutral" {
  if (!p.enabled) return "neutral";
  if (!p.resolvable) return "error";
  // 能用但没实测过出口 —— 那不是错误，只是还不知道。
  if (p.egressIp === null) return "warn";
  return "success";
}

function proxyStatus(p: ProxyView): { tone: StatusTone; icon: string; label: string } {
  /*
   * ## 停用与不可解析要**一起**说，不是二选一
   *
   * 第一版先判 `!enabled` 就 return「已停用」—— 而 `resolveProxy` 对
   * 「已停用」返回的正是一个失败（`{ kind: "disabled" }`）。于是**最常见的
   * 那条不可解析路径**永远显示不出原因，而 `unresolvableReason` 这个字段
   * 在那种情况下是死信息。测试的输出把它暴露了出来：那一行只有「已停用」。
   *
   * 现在停用时也把服务端给的原因带上 —— 它对「停用」这种自明的情况是冗余的，
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

/**
 * 批量探测的长任务 UI。
 *
 * ## 两段进度分开显示，不合成一个百分比
 *
 * 合成要给两段定权重，而那个权重是编的：筛选（纯本地判断）比主探测
 * （真发网络请求 + 切 selector）快得多，于是进度条会先飞到 40% 再慢慢爬，
 * 用户会以为卡住了。两个数字各自诚实。
 *
 * ## 按钮组随状态变化，且 `cancelling` 是独立态
 *
 * 取消是「请求已发出、等服务端确认」，不是立刻回 idle —— 那时后台那一批
 * 还在跑（它们要切 selector），放开「开始」按钮会让用户启动第二批。
 */
function BatchPanel({ progress, control }: { progress: BatchProgress; control: ReturnType<typeof useBatchProbe> }) {
  const pct = percentages(progress);
  const running = isActive(progress);

  const stateLabel: Record<BatchProgress["state"], string> = {
    idle: "未开始",
    screening: "筛选中",
    running: "探测中",
    paused: "已暂停",
    cancelling: "正在取消…",
    done: progress.failureKind === null ? "已完成" : `已结束（${progress.failureKind}）`,
  };

  const tone: StatusTone =
    progress.state === "done"
      ? progress.failureKind === null
        ? "success"
        : "warn"
      : running
        ? "info"
        : "neutral";

  return (
    <Panel
      title="批量探测"
      action={
        <div className="flex gap-2">
          {progress.state === "running" && (
            <SecondaryButton onClick={() => void control.send("pause")}>暂停</SecondaryButton>
          )}
          {progress.state === "paused" && (
            <SecondaryButton onClick={() => void control.send("resume")}>继续</SecondaryButton>
          )}
          {running && (
            <SecondaryButton
              onClick={() => void control.send("cancel")}
              /* 已在取消中就禁用 —— 重复点不该产生第二次请求。 */
              disabled={progress.state === "cancelling"}
            >
              取消
            </SecondaryButton>
          )}
          <PrimaryButton onClick={() => void control.send("start")} disabled={running}>
            {running ? "进行中…" : "开始批量探测"}
          </PrimaryButton>
        </div>
      }
    >
      <StatusIndicator
        tone={tone}
        icon={progress.state === "done" && progress.failureKind === null ? "✓" : running ? "◴" : "○"}
        label={stateLabel[progress.state]}
      />

      {(progress.screenTotal > 0 || progress.mainTotal > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {/* 两段各自一个进度 —— 不合成总百分比，见本组件的说明。 */}
          <ProgressBar
            label="第 1 段 · 筛选"
            done={progress.screenDone}
            total={progress.screenTotal}
            percent={pct.screen}
          />
          <ProgressBar
            label="第 2 段 · 实测出口"
            done={progress.mainDone}
            total={progress.mainTotal}
            percent={pct.main}
          />
        </div>
      )}

      {progress.addedWorkerIds.length > 0 && (
        <p className="mt-3 text-text-muted">
          本批新建 Worker：{progress.addedWorkerIds.join("、")}
        </p>
      )}

      {control.error !== null && <p className="mt-3 text-error">{control.error}</p>}

      <p className="mt-3 text-text-muted">
        进度由服务端持有 —— 刷新页面或关掉再开都能接着看。桥接探测会切换
        Clash selector（那是进程外的全局状态），所以**同一时刻只允许一批**。
      </p>
    </Panel>
  );
}

function ProgressBar({
  label,
  done,
  total,
  percent,
}: {
  label: string;
  done: number;
  total: number;
  percent: number | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-text-muted">{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {/* 分母为 0 显示「—」而不是 0%：「还没开始」与「0% 完成」是两件事。 */}
          {percent === null ? "—" : `${done}/${total}`}
        </span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-xs bg-bg"
        role="progressbar"
        aria-valuenow={percent ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/* accent-fill 只做填充 —— 它上面不压任何文字，所以这个用法合格。 */}
        <div className="h-full bg-accent-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
    </div>
  );
}

function SecondaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-[44px] rounded-sm border border-border-strong px-3 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** 出口隔离视图 —— **不分页**（见文件头）。 */
function IsolationTab({ data }: { data: ProxyList }) {
  const { groups, sharedGroups, unknownWorkerIds, isolated } = data.isolation;

  return (
    <Panel title="出口隔离">
      <StatusIndicator
        tone={isolated ? "success" : sharedGroups.length > 0 ? "error" : "warn"}
        icon={isolated ? "✓" : sharedGroups.length > 0 ? "✕" : "!"}
        label={
          isolated
            ? `已隔离 · ${groups.length} 个独立出口`
            : sharedGroups.length > 0
              ? `未隔离 · ${sharedGroups.length} 组共用出口`
              : `${unknownWorkerIds.length} 个出口未探测`
        }
      />

      <p className="mt-3 text-text-muted">
        **按实测公网 IP 分组，不按代理 id** —— 两个不同代理可能 NAT 到同一个
        公网 IP，那种情况下「已隔离」是假的。未探测出 IP 的**不算已隔离**。
      </p>

      {groups.length > 0 && (
        /* 一眼看全是这个视图的全部意义,所以不分页 —— 数量大时靠原生滚动。 */
        <ul className="mt-4 space-y-2">
          {groups.map((g) => {
            const shared = g.workerIds.length > 1;
            return (
              <li
                key={g.egressIp}
                className={`relative rounded-md border py-2 pl-4 pr-3 ${
                  shared ? "border-error" : "border-border-strong"
                }`}
              >
                <Mono>{g.egressIp}</Mono>
                {shared && <span className="ml-2 text-error">⚠ 共用出口</span>}
                <div className="text-text-muted">
                  Worker：{g.workerIds.join("、")}
                  {g.proxyIds.length > 0 && <> · 代理：{g.proxyIds.join("、")}</>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {unknownWorkerIds.length > 0 && (
        <p className="mt-4 text-text-muted">
          未探测：{unknownWorkerIds.join("、")} —— 跑一次批量探测即可实测。
        </p>
      )}
    </Panel>
  );
}

export function ProxyPage({
  data,
  view,
  navigate,
}: {
  data: ProxyList;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
}) {
  const batch = useBatchProbe();
  const tab = view.tab ?? "list";

  /*
   * 过滤与排序在前端做。
   *
   * 数据量是几十行（本机 69 个节点），一次过滤是微秒级 —— 让服务端做会
   * 把每次输入一个字符变成一次 HTTP 请求。而搜索词本身在 URL 里，
   * 所以刷新仍然还原同一视图。
   */
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
    if (view.status === "broken" && p.resolvable) return false;
    return true;
  });

  const columns: ReadonlyArray<Column<ProxyView>> = [
    {
      key: "name",
      header: "节点",
      render: (p) => (
        <span>
          <span className="block truncate" style={{ maxWidth: "22rem" }}>
            {p.name || <Mono>{p.id}</Mono>}
          </span>
          <span className="text-text-muted">
            {p.direct ? "直连" : "桥接"} · {p.type}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      render: (p) => {
        const s = proxyStatus(p);
        return <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />;
      },
    },
    {
      key: "egress",
      header: "出口 IP",
      render: (p) =>
        p.egressIp === null ? (
          <span className="text-text-muted">未探测</span>
        ) : (
          <Mono>{p.egressIp}</Mono>
        ),
    },
    {
      key: "port",
      header: "本地端口",
      numeric: true,
      /*
       * 这一列必须显示 —— Phase 8 实测出的高风险字段：桥接时它是本机 Clash 的
       * 混合端口，与内核实际 `mixed-port` 不一致会让所有桥接代理静默失败
       * （而控制面是通的）。
       */
      render: (p) => <Mono>{p.port}</Mono>,
    },
    {
      key: "usedBy",
      header: "被引用",
      render: (p) =>
        p.usedBy.length === 0 ? (
          <span className="text-text-muted">—</span>
        ) : (
          <span>{p.usedBy.join("、")}</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <Panel title="代理池">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Metric label="代理" value={String(data.proxies.length)} hint="配置里的总数" />
          <Metric
            label="启用"
            value={String(data.proxies.filter((p) => p.enabled).length)}
            hint="参与调度"
          />
          <Metric
            label="已实测出口"
            value={String(data.proxies.filter((p) => p.egressIp !== null).length)}
            hint="有公网 IP"
          />
          <Metric
            label="不可解析"
            value={String(data.proxies.filter((p) => !p.resolvable).length)}
            hint="配置自身矛盾"
            tone={data.proxies.some((p) => !p.resolvable) ? "error" : "normal"}
          />
        </div>
      </Panel>

      <BatchPanel progress={batch.progress} control={batch} />

      <div className="flex gap-1">
        <TabButton active={tab === "list"} onClick={() => navigate({ tab: "list" })} label="列表" />
        <TabButton
          active={tab === "isolation"}
          onClick={() => navigate({ tab: "isolation" })}
          label="出口隔离"
        />
      </div>

      {tab === "isolation" ? (
        <IsolationTab data={data} />
      ) : (
        <Panel title={`节点（${filtered.length}/${data.proxies.length}）`}>
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
              { value: "broken", label: "不可解析" },
            ]}
            placeholder="搜索节点名 / id / 出口 IP…"
          />
          <DataTable
            rows={filtered}
            columns={columns}
            rowKey={(p) => p.id}
            rowTone={proxyTone}
            page={view.page_}
            onPageChange={(next) => navigate({ page_: next })}
            empty={
              data.proxies.length === 0 ? (
                <>
                  <p className="font-serif text-lg">还没有代理</p>
                  <p className="mt-1 text-text-muted">
                    运行 <Mono>npm run setup</Mono> 自动探测本机 Clash 并导入节点。
                  </p>
                </>
              ) : (
                <p className="text-text-muted">没有匹配的节点 —— 换个搜索词或清掉筛选。</p>
              )
            }
          />
        </Panel>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[44px] rounded-sm border px-4 ${
        active ? "border-accent-fg text-accent-fg font-medium" : "border-border-strong text-text-muted"
      }`}
    >
      {label}
    </button>
  );
}
