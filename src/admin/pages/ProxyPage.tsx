import type {
  BatchProgressView,
  ProxyList,
  ProxyView,
  SubscriptionRefresh,
} from "../../shared/contract.ts";
import { isActive, percentages } from "../../shared/batchProbe.ts";
import { useState } from "react";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Metric, Mono, Panel, PrimaryButton, SecondaryButton, Strong } from "../components/Panel.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { toHash, type ViewState } from "../lib/router.ts";
import { useBatchProbe, useSubscriptionRefresh } from "../lib/api.ts";
import { formatLocalTime, humanMs } from "../lib/format.ts";

/**
 * 代理池页。
 *
 * 两个标签：**列表**（分页）与**回显出口**（不分页）。
 *
 * 隔离视图刻意不分页：那个任务本身就是「一眼看全、找出共用出口的节点」，
 * 分页会破坏它的意义。数量大时靠浏览器原生滚动，而不是切成 6 页
 * 让用户在页间比对 IP。
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
function BatchPanel({ progress, control }: { progress: BatchProgressView; control: ReturnType<typeof useBatchProbe> }) {
  const pct = percentages(progress);
  const running = isActive(progress);
  const [confirming, setConfirming] = useState(false);

  const stateLabel: Record<BatchProgressView["state"], string> = {
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
          <PrimaryButton onClick={() => setConfirming(true)} disabled={running}>
            {running ? "进行中…" : "开始批量探测"}
          </PrimaryButton>
        </div>
      }
    >
      <StatusIndicator
        tone={tone}
        icon={progress.state === "done" && progress.failureKind === null ? "✓" : running ? "◴" : "○"}
        /*
         * 带上耗时 —— 一个几十秒的任务不报「已跑多久」时，用户无法区分
         * 「还在跑」与「卡住了」。`elapsedMs` 为 null 表示从未跑过。
         */
        label={
          progress.elapsedMs === null
            ? stateLabel[progress.state]
            : `${stateLabel[progress.state]} · ${humanMs(progress.elapsedMs)}`
        }
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
            label="第 2 段 · 实测回显出口"
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

      <div aria-live="polite">
        {control.error !== null && (
          <p role="alert" className="mt-3">
            <StatusIndicator tone="error" icon="✕" label={control.error} />
          </p>
        )}
      </div>

      <p className="mt-3 text-text-muted">
        进度由服务端持有 —— 刷新页面或关掉再开都能接着看。桥接探测会切换
        Clash selector（那是进程外的全局状态），所以<Strong>同一时刻只允许一批</Strong>。
      </p>

      <ConfirmDialog
        open={confirming}
        title="开始批量探测"
        confirmLabel="开始探测"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void control.send("start");
        }}
      >
        <p>
          经 Clash 桥接的节点会逐个<Strong>切换 Clash 分组的选中节点</Strong>。那是 Clash
          的全局状态：探测期间本机其他走这个分组的流量也会跟着换出口，结束后不会自动切回。
        </p>
        <p>探测成功的出口可能会自动新建对应的 Worker，结果写回配置。</p>
        <p>探测期间可以暂停或取消。</p>
      </ConfirmDialog>
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

/** 回显出口视图 —— **不分页**（见文件头）。 */
function IsolationTab({ data }: { data: ProxyList }) {
  const { groups, sharedGroups, unknownWorkerIds, isolated } = data.isolation;

  return (
    <Panel title="回显出口">
      <StatusIndicator
        tone={isolated ? "success" : sharedGroups.length > 0 ? "error" : "warn"}
        icon={isolated ? "✓" : sharedGroups.length > 0 ? "✕" : "!"}
        label={
          isolated
            ? `回显出口独立 · ${groups.length} 个出口`
            : sharedGroups.length > 0
              ? `回显出口共用 · ${sharedGroups.length} 组共用出口`
              : `${unknownWorkerIds.length} 个出口未探测`
        }
      />

      <p className="mt-3 text-text-muted">
        <Strong>按回显目标的实测公网 IP 分组</Strong>。两个不同代理可能共用公网 IP；
        未探测的出口单独列出。已保存的 IP 是最后一次成功探测结果，不代表当前仍然可用。
      </p>
      <p className="mt-2 text-text-muted">
        仅反映 IP 回显目标的出口；Zen 实际出口需核对发往 opencode.ai 的连接。
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

/**
 * 订阅标签。
 *
 * ## 为什么 URL 只显示脱敏串
 *
 * 订阅 URL 的 token 通常带在 query 或 path 里，它本身就是付费凭证 ——
 * 与 API key 同一条规则：界面要回答"这是哪个订阅"，不该让人从界面抄走 token。
 * 服务端的 `subscriptionViews` 已经过了 `redactUrl`，前端拿不到原值。
 *
 * ## 「从没拉过」与「拉过但失败了」要分开显示
 *
 * 两者的下一步完全不同：前者是"点一下刷新"，后者是"看看 token 过期了没"。
 * 合成一句"未就绪"会让用户从头猜 —— 与 doctor 分层同一个理由。
 */
function SubscriptionTab({ data }: { data: ProxyList }) {
  const { stateOf, refresh } = useSubscriptionRefresh();

  if (data.subscriptions.length === 0) {
    return (
      <Panel title="订阅">
        <p className="text-text-muted">
          还没有订阅。订阅是批量导入节点的来源 —— 手工添加代理也可以，
          但一个机场几十个节点逐个填不现实。
        </p>
        <p className="mt-2 text-text-muted">
          眼下需要直接编辑 <Mono>data/config.json</Mono> 的{" "}
          <Mono>subscriptions</Mono> 数组（<Mono>id</Mono> / <Mono>name</Mono> /{" "}
          <Mono>url</Mono>），然后回到这里点刷新。
        </p>
      </Panel>
    );
  }

  return (
    <Panel title={`订阅（${data.subscriptions.length}）`}>
      <ul className="space-y-3">
        {data.subscriptions.map((s) => {
          const state = stateOf(s.id);
          const running = state.status === "running";
          return (
            <li
              key={s.id}
              className="rounded-md border border-border-strong p-4"
              data-subscription={s.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{s.name}</div>
                  {/* 已脱敏 —— 服务端过了 redactUrl，这里只是显示。 */}
                  <div className="text-text-muted">
                    <Mono>{s.urlRedacted}</Mono>
                  </div>
                </div>
                {/* 每行一个刷新按钮，用描边按钮：页面的主操作是批量探测。 */}
                <SecondaryButton onClick={() => void refresh(s.id)} disabled={running}>
                  {running ? "刷新中…" : "刷新"}
                </SecondaryButton>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4">
                <span title={s.lastFetchedAt ?? undefined}>
                  <StatusIndicator {...subscriptionStatus(s)} />
                </span>
                <span className="text-text-muted">
                  当前 <Mono>{s.proxyCount}</Mono> 个节点
                  {s.lastFormat === null ? null : (
                    <>
                      {" · 格式 "}
                      <Mono>{s.lastFormat}</Mono>
                    </>
                  )}
                </span>
              </div>

              <div aria-live="polite">
                {state.status === "done" && <RefreshReport result={state.result} />}
                {state.status === "error" && (
                  <p role="alert" className="mt-2">
                    <StatusIndicator tone="error" icon="✕" label={state.message} />
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/**
 * 订阅的状态标签。
 *
 * 四态而不是两态 —— 见 `SubscriptionTab` 的说明。注意**停用**时也要把
 * 失败原因带上（如果有）：与 `proxyStatus` 同一个理由，一条 early return
 * 会让最常见的那类输入看不到原因。
 *
 * 拉取时间按本地时区显示；完整 ISO 串放在外层元素的 `title` 上。
 */
export function subscriptionStatus(s: ProxyList["subscriptions"][number]): {
  tone: StatusTone;
  icon: string;
  label: string;
} {
  if (!s.enabled) {
    const suffix = s.lastErrorKind === null ? "" : ` · 上次失败（${s.lastErrorKind}）`;
    return { tone: "neutral", icon: "○", label: `已停用${suffix}` };
  }
  if (s.lastErrorKind !== null) {
    return { tone: "error", icon: "✕", label: `上次拉取失败（${s.lastErrorKind}）` };
  }
  if (s.lastFetchedAt === null) {
    // 「从没拉过」不是错误 —— 但也绝不能显示成成功。
    return { tone: "warn", icon: "?", label: "从未拉取" };
  }
  return { tone: "success", icon: "✓", label: `上次拉取 ${formatLocalTime(s.lastFetchedAt)}` };
}

/** 一次刷新的结果明细。 */
function RefreshReport({ result }: { result: SubscriptionRefresh }) {
  if (!result.ok) {
    return (
      <p role="alert" className="mt-2">
        <StatusIndicator tone="error" icon="✕" label={`刷新失败（${result.failureKind}）：${result.reason}`} />
      </p>
    );
  }
  return (
    <div className="mt-2">
      <p>
        新增 <Mono>{result.added}</Mono> · 更新 <Mono>{result.updated}</Mono> · 移除{" "}
        <Mono>{result.removed}</Mono>
        {result.skipped > 0 ? (
          <>
            {" · 跳过 "}
            <Mono>{result.skipped}</Mono>
          </>
        ) : null}
      </p>
      {result.keptBecauseInUse > 0 && (
        <p className="mt-1 text-text-muted">
          有 <Mono>{result.keptBecauseInUse}</Mono> 个节点已不在订阅里，但仍被 Worker
          绑着，所以<Strong>没有删除</Strong> —— 删了配置会过不了引用完整性校验。
          先把那些 Worker 改绑到别的出口。
        </p>
      )}
      {result.disabledNeedBridge > 0 && (
        <p className="mt-1 text-text-muted">
          有 <Mono>{result.disabledNeedBridge}</Mono> 个节点只能经 Clash 桥接，
          而桥接当前未启用，所以它们以<Strong>停用</Strong>状态导入。
          开启 Clash 桥接后再启用它们。
        </p>
      )}
    </div>
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
   * 数据量是几十行，一次过滤是微秒级 —— 让服务端做会
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
    // 「配置有问题」筛选同样排除仅停用的 —— 见 `isBroken`。
    if (view.status === "broken" && !isBroken(p)) return false;
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
       * 这一列必须显示 —— 高风险字段：桥接时它是本机 Clash 的混合端口，与内核实际 `mixed-port` 不一致会让所有桥接代理静默失败
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
            label="已实测回显出口"
            value={String(data.proxies.filter((p) => p.egressIp !== null).length)}
            hint="有公网 IP"
          />
          <Metric
            label="配置有问题"
            value={String(data.proxies.filter(isBroken).length)}
            hint="启用了但解析不出出口"
            tone={data.proxies.some(isBroken) ? "error" : "normal"}
          />
        </div>
      </Panel>

      <BatchPanel progress={batch.progress} control={batch} />

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="代理池视图">
        {TABS.map((t) => (
          <TabLink
            key={t.id}
            id={t.id}
            active={tab === t.id}
            onSelect={() => navigate({ tab: t.id })}
            label={
              t.id === "subscriptions" && data.subscriptions.length > 0
                ? `${t.label}（${data.subscriptions.length}）`
                : t.label
            }
          />
        ))}
      </div>

      <div role="tabpanel" id={`proxy-panel-${tab}`} aria-labelledby={`proxy-tab-${tab}`}>
      {tab === "isolation" ? (
        <IsolationTab data={data} />
      ) : tab === "subscriptions" ? (
        <SubscriptionTab data={data} />
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
              { value: "broken", label: "配置有问题" },
            ]}
            placeholder="搜索节点名 / id / 出口 IP…"
          />
          <DataTable
            label="代理节点"
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
    </div>
  );
}

const TABS = [
  { id: "list", label: "列表" },
  { id: "isolation", label: "回显出口" },
  { id: "subscriptions", label: "订阅" },
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
      href={toHash({ page: "proxy", tab: id, q: "", status: null, sort: null, page_: 1 })}
      aria-selected={active}
      aria-controls={`proxy-panel-${id}`}
      onClick={(event) => {
        // 修饰键点击交给浏览器（新标签页等）。
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onSelect();
      }}
      className={`inline-flex min-h-[44px] items-center rounded-sm border px-4 no-underline ${
        active ? "border-accent-fg text-accent-fg font-medium" : "border-border-strong text-text-muted"
      }`}
    >
      {label}
    </a>
  );
}
