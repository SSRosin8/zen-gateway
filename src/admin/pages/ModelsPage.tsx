import { useState } from "react";
import type { ModelList, ModelView } from "../../shared/contract.ts";
import { FormStatus, Metric, Mono, PageHeader, Panel, PrimaryButton, Strong, errorMessage, type FormMessage } from "../components/Panel.tsx";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import type { ViewState } from "../lib/router.ts";
import { patchConfig } from "../lib/api.ts";
import { FIELD, TEXTAREA } from "../lib/styles.ts";
import { useFormState, useLeaveGuard } from "../lib/formState.ts";
import { DirtyMark } from "../components/GatewaySettingsForms.tsx";

/**
 * 模型页。
 *
 * ## 它要回答的是「为什么这个模型不能用」
 *
 * 所以列表**含付费模型**。只列免费集的话，用户在 OpenCode 里看到一个模型名
 * 却在这里找不到它，于是不知道是「网关不认识它」还是「网关拒绝它」。
 *
 * `reason` 直接来自 `judgeFree` 的联合类型 —— 界面说的理由与转发时拒绝的
 * 理由是**同一个值**，不另造一套措辞。
 */

/** 判定依据的人话。取值与 `FreeVerdict.reason` 一一对应（纪律 #4：不另造清单）。 */
const REASON_LABEL: Record<string, string> = {
  suffix: "后缀命中",
  extra: "在 extraFreeIds 名单里",
  suffix_unverified: "后缀命中（目录拿不到，未做交集）",
  extra_unverified: "在名单里（目录拿不到，未做交集）",
  not_free: "不是免费模型",
  retired: "已下架（依据成立但不在在架目录里）",
};

/** 协议的人话。取值与 `ModelViewSchema.protocol` 一一对应。 */
const PROTOCOL_LABEL: Record<string, string> = {
  chat: "Chat",
  responses: "Responses",
  messages: "Messages",
  other: "网关不支持的协议",
};

/**
 * 声明（models.dev）为主，实测（本网关 2xx）只在补充信息时显示：与声明一致就不重复。
 * 拿不到声明与「没声明」分开说，免得把第三方故障读成模型没有协议。
 */
export function protocolText(m: ModelView, sourceAvailable: boolean): string {
  const { declared, measured } = m.protocol;
  const head =
    declared !== null ? PROTOCOL_LABEL[declared] ?? declared : sourceAvailable ? "未声明" : "声明拿不到";
  const extra = measured.filter((p) => p !== declared);
  if (extra.length === 0) return head;
  return `${head} · 实测：${measured.map((p) => PROTOCOL_LABEL[p] ?? p).join(" / ")}`;
}

function modelTone(m: ModelView): "success" | "warn" | "error" | "neutral" {
  if (m.free) return m.reason.endsWith("_unverified") ? "warn" : "success";
  // `retired` 与 `not_free` 的处置完全不同 —— 前者要删 extraFreeIds 条目。
  return m.reason === "retired" ? "warn" : "neutral";
}

export function ModelsPage({
  data,
  view,
  navigate,
  refresh,
}: {
  data: ModelList;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
  /** 刷新 `/api/models`。保存判定设置后调用。 */
  refresh?: () => void;
}) {
  const form = useFormState({
    freeSuffix: data.rules.freeSuffix,
    extraFreeIds: data.rules.extraFreeIds.join("\n"),
    enforceCatalog: data.rules.enforceCatalog,
  });
  const { freeSuffix, extraFreeIds, enforceCatalog } = form.value;
  const setFreeSuffix = (v: string) => form.set((p) => ({ ...p, freeSuffix: v }));
  const setExtraFreeIds = (v: string) => form.set((p) => ({ ...p, extraFreeIds: v }));
  const setEnforceCatalog = (v: boolean) => form.set((p) => ({ ...p, enforceCatalog: v }));
  useLeaveGuard(form.dirty);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const q = view.q.trim().toLowerCase();
  const filtered = data.models.filter((m) => {
    if (q !== "" && !m.id.toLowerCase().includes(q)) return false;
    if (view.status === "free" && !m.free) return false;
    if (view.status === "paid" && m.free) return false;
    if (view.status === "retired" && m.reason !== "retired") return false;
    return true;
  });

  const listedCount = data.models.filter((m) => m.listed).length;
  const freeCount = data.models.filter((m) => m.free).length;

  const columns: ReadonlyArray<Column<ModelView>> = [
    { key: "id", header: "模型", render: (m) => <Mono>{m.id}</Mono> },
    {
      key: "verdict",
      header: "放行",
      render: (m) => {
        const tone: StatusTone = modelTone(m);
        return (
          <StatusIndicator
            tone={tone}
            icon={m.free ? "✓" : "✕"}
            label={m.free ? "可用" : "已拒绝"}
          />
        );
      },
    },
    {
      key: "reason",
      header: "依据",
      render: (m) => (
        <span className="text-text-muted">{REASON_LABEL[m.reason] ?? m.reason}</span>
      ),
    },
    {
      key: "protocol",
      header: "协议",
      // 只作展示，不是放行闸门：网关对每个模型都开放全部三个面。
      render: (m) => <span className="text-text-muted">{protocolText(m, data.protocolSource.available)}</span>,
    },
  ];

  if (!data.catalogAvailable) {
    /*
     * 目录拿不到 —— 与「目录里一个模型都没有」必须分开报。
     *
     * 前者的下一步是查网络/CA（诊断页的目录层会直接指出），
     * 后者是查 freeSuffix。显示一个空表会把用户引向错误方向。
     */
    return (
      <Panel title="模型">
        <StatusIndicator tone="error" icon="✕" label="拿不到上游模型目录" />
        <p className="mt-3 text-text-muted">
          目录从未成功拉取过，所以这一页没有数据可显示 —— 这<Strong>不是</Strong>
          「一个免费模型都没有」。
        </p>
        <p className="mt-2 text-text-muted">
          到{" "}
          <a href="#diagnostics" className="text-accent-fg underline">
            诊断页
          </a>{" "}
          看目录层，它会区分「上游不可达」与「目录可达但免费集为空」，并给出下一步。最常见的成因是企业网络下
          缺 <Mono>NODE_EXTRA_CA_CERTS</Mono>（Node 不读系统 CA 库，
          而 <Mono>curl</Mono> 读 —— 所以 curl 通不代表网关通）。
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="模型" />
      <Panel
        title="免费判定"
        hint={
          <>
            判定规则：（后缀命中 ∪ <Mono>extraFreeIds</Mono>）∩ 在架目录。交集是已下架模型自动失效的<Strong>唯一</Strong>机制：
            少了它，一个下架的 <Mono>xxx-free</Mono> 会被放行，再由上游返回 400。反过来，
            <Strong>新出现的无后缀免费模型无法自动发现</Strong>：上游的 <Mono>/models</Mono> 给在架性却不给价格，只能手工补进{" "}
            <Mono>extraFreeIds</Mono>。
          </>
        }
      >
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Metric label="在架模型" value={String(listedCount)} hint="上游目录总数" />
          <Metric label="可用" value={String(freeCount)} hint="通过免费判定" />
          <Metric
            label="已下架"
            value={String(data.models.filter((m) => m.reason === "retired").length)}
            hint="依据成立但不在架"
          />
          <Metric
            label="后缀"
            value={data.rules.freeSuffix}
            hint={`交集${data.rules.enforceCatalog ? "已开" : "已关"}`}
          />
        </div>
      </Panel>

      <Panel title="判定设置" action={<DirtyMark form={form} />}>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            setMessage(null);
            void patchConfig({
              models: {
                freeSuffix,
                extraFreeIds: extraFreeIds.split(/\r?\n/).map((id) => id.trim()).filter(Boolean),
                enforceCatalog,
              },
            })
              .then(() => {
                form.markSaved();
                setMessage({ tone: "success", text: "已保存" });
                // 判定结果在 /api/models 上，保存后立即刷新这一页自己的数据。
                refresh?.();
              })
              .catch((err) => setMessage(errorMessage(err)))
              .finally(() => setSaving(false));
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">免费模型后缀</span>
            <input value={freeSuffix} onChange={(e) => setFreeSuffix(e.target.value)} required className={FIELD} />
          </label>
          <label className="flex items-center gap-2 min-h-[44px] self-end">
            <input type="checkbox" checked={enforceCatalog} onChange={(e) => setEnforceCatalog(e.target.checked)} /> 与在架目录求交集
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-text-muted">无后缀免费模型（每行一个）</span>
            <textarea value={extraFreeIds} onChange={(e) => setExtraFreeIds(e.target.value)} rows={3} className={`${TEXTAREA} font-mono`} />
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <PrimaryButton type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</PrimaryButton>
            <FormStatus message={message} />
          </div>
        </form>
      </Panel>

      <Panel
        title={`模型（${filtered.length}/${data.models.length}）`}
        hint={
          <>
            「协议」列：声明取自 models.dev 的 OpenCode 条目（OpenCode 按它选择请求协议；第三方数据，
            可能落后于 Zen）；「实测」是本网关{data.measuredSinceDay === null ? "（统计库不可用，暂无）" : `自 ${data.measuredSinceDay} 起`}
            实际成功转发过的协议面。两者都不证明 Zen 当前接受哪个面，也不是放行条件。
          </>
        }
      >
        <TableFilters
          q={view.q}
          onQ={(next) => navigate({ q: next, page_: 1 })}
          status={view.status}
          onStatus={(next) => navigate({ status: next, page_: 1 })}
          statuses={[
            { value: "free", label: "可用" },
            { value: "paid", label: "已拒绝" },
            { value: "retired", label: "已下架" },
          ]}
          placeholder="搜索模型 id…"
        />
        <DataTable
          label="模型列表"
          rows={filtered}
          total={data.models.length}
          columns={columns}
          rowKey={(m) => m.id}
          rowTone={modelTone}
          page={view.page_}
          onPageChange={(next) => navigate({ page_: next })}
          empty={<p className="text-text-muted">没有匹配的模型。</p>}
        />
      </Panel>
    </div>
  );
}
