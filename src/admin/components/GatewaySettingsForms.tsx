import { useState, type ReactNode } from "react";
import { RoutingStrategySchema, CooldownConfigSchema, RoutingConfigSchema, GatewaySchema } from "../../shared/schema.ts";
import type { ConfigPatch, Overview } from "../../shared/contract.ts";
import { FormStatus, Panel, PrimaryButton, SecondaryButton, errorMessage, type FormMessage } from "./Panel.tsx";
import { patchConfig } from "../lib/api.ts";
import { FIELD } from "../lib/styles.ts";
import { useFormState, useLeaveGuard } from "../lib/formState.ts";

/**
 * 网关页的两张设置表单：运行参数与调度。
 *
 * 时长在界面上用秒或分钟，提交时换算成毫秒；取值范围直接取配置 schema 的
 * `minValue`/`maxValue`（纪律 #4），错误提示按显示单位说明规则。
 */

type Unit = "s" | "min";
const UNIT_MS: Record<Unit, number> = { s: 1000, min: 60_000 };
const UNIT_LABEL: Record<Unit, string> = { s: "秒", min: "分钟" };

type Bounded = { minValue: number | null; maxValue: number | null };

export type DurationField = {
  readonly label: string;
  readonly unit: Unit;
  readonly bounds: Bounded;
};

/** 显示值 → 毫秒；不在范围内或不是数字时返回错误说明（带显示单位）。 */
export function parseDuration(raw: string, field: DurationField): { ok: true; ms: number } | { ok: false; message: string } {
  const unitMs = UNIT_MS[field.unit];
  const min = (field.bounds.minValue ?? 0) / unitMs;
  const max = (field.bounds.maxValue ?? Number.MAX_SAFE_INTEGER) / unitMs;
  const rule = `${field.label}必须是 ${min} 到 ${max} ${UNIT_LABEL[field.unit]}之间的数`;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) return { ok: false, message: rule };
  const ms = Math.round(value * unitMs);
  if ((field.bounds.minValue !== null && ms < field.bounds.minValue) || (field.bounds.maxValue !== null && ms > field.bounds.maxValue)) {
    return { ok: false, message: rule };
  }
  return { ok: true, ms };
}

export function formatDuration(ms: number, unit: Unit): string {
  // 保留到毫秒精度，避免 0.1 秒这类值被显示成 0。
  return String(Math.round((ms / UNIT_MS[unit]) * 1000) / 1000);
}

/** 与 `GatewayPatchSchema.maxAttempts` 相同的范围；提交前校验，错误直接指出规则。 */
export function validateMaxAttempts(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const bounds = GatewaySchema.shape.maxAttempts.unwrap();
  const trimmed = raw.trim();
  const value = Number(trimmed);
  const min = bounds.minValue ?? 1;
  const max = bounds.maxValue ?? 10;
  if (trimmed === "" || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, message: `最多尝试 Worker 数必须是 ${min} 到 ${max} 的整数` };
  }
  return { ok: true, value };
}

const g = GatewaySchema.shape;
const c = CooldownConfigSchema.shape;

const RUNTIME_FIELDS = {
  headersTimeoutMs: { label: "响应头超时", unit: "s", bounds: g.headersTimeoutMs.unwrap() },
  bodyTimeoutMs: { label: "响应体空闲超时", unit: "s", bounds: g.bodyTimeoutMs.unwrap() },
} as const satisfies Record<string, DurationField>;

const AFFINITY_FIELD: DurationField = { label: "会话亲和时长", unit: "min", bounds: RoutingConfigSchema.shape.affinityTtlMs.unwrap() };

const COOLDOWN_FIELDS = {
  rateLimitMs: { label: "限流冷却", unit: "s", bounds: c.rateLimitMs.unwrap() },
  authFailMs: { label: "鉴权失败冷却", unit: "s", bounds: c.authFailMs.unwrap() },
  forbiddenMs: { label: "403 冷却", unit: "s", bounds: c.forbiddenMs.unwrap() },
  transportBaseMs: { label: "传输失败起始退避", unit: "s", bounds: c.transportBaseMs.unwrap() },
  transportMaxMs: { label: "传输失败最长退避", unit: "s", bounds: c.transportMaxMs.unwrap() },
} as const satisfies Record<string, DurationField>;

type CooldownKey = keyof typeof COOLDOWN_FIELDS;

const STRATEGY_LABEL: Record<(typeof RoutingStrategySchema.options)[number], string> = {
  anonymous_first: "匿名优先",
  authenticated_first: "认证优先",
  mixed: "混合",
};

const INPUT = `${FIELD} w-full min-w-[10rem]`;

function Field({ label, unit, children }: { label: string; unit?: Unit; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text-muted">{unit === undefined ? label : `${label}（${UNIT_LABEL[unit]}）`}</span>
      {children}
    </label>
  );
}

function useSave(refresh: (() => void) | undefined, onSaved?: () => void) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const save = (patch: ConfigPatch) => {
    setSaving(true);
    setMessage(null);
    void patchConfig(patch)
      .then(() => {
        onSaved?.();
        setMessage({ tone: "success", text: "已保存" });
        refresh?.();
      })
      .catch((err) => setMessage(errorMessage(err)))
      .finally(() => setSaving(false));
  };
  return { saving, message, setMessage, save };
}

export function RuntimeSettingsForm({ data, refresh }: { data: Overview; refresh?: (() => void) | undefined }) {
  const form = useFormState({
    maxAttempts: String(data.gateway.maxAttempts),
    headers: formatDuration(data.gateway.headersTimeoutMs, "s"),
    body: formatDuration(data.gateway.bodyTimeoutMs, "s"),
  });
  const { maxAttempts, headers, body } = form.value;
  const setMaxAttempts = (v: string) => form.set((p) => ({ ...p, maxAttempts: v }));
  const setHeaders = (v: string) => form.set((p) => ({ ...p, headers: v }));
  const setBody = (v: string) => form.set((p) => ({ ...p, body: v }));
  const { saving, message, setMessage, save } = useSave(refresh, form.markSaved);
  useLeaveGuard(form.dirty);

  return (
    <Panel
      title="运行参数"
      hint="超时修改后新请求使用新连接池，已开始的流按原设置完成。响应体超时是字节之间的空闲上限，不是总时长。"
      action={<DirtyMark form={form} />}
    >
      <form
        aria-label="运行参数"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        /* 自己校验并给出规则说明，不依赖浏览器原生气泡（它不进 aria-live 区域）。 */
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const attempts = validateMaxAttempts(maxAttempts);
          if (!attempts.ok) return setMessage({ tone: "error", text: attempts.message });
          const h = parseDuration(headers, RUNTIME_FIELDS.headersTimeoutMs);
          if (!h.ok) return setMessage({ tone: "error", text: h.message });
          const b = parseDuration(body, RUNTIME_FIELDS.bodyTimeoutMs);
          if (!b.ok) return setMessage({ tone: "error", text: b.message });
          save({ gateway: { maxAttempts: attempts.value, headersTimeoutMs: h.ms, bodyTimeoutMs: b.ms } });
        }}
      >
        <Field label="最多尝试 Worker 数">
          <input
            type="number"
            min={1}
            step={1}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label={RUNTIME_FIELDS.headersTimeoutMs.label} unit="s">
          <input inputMode="decimal" value={headers} onChange={(e) => setHeaders(e.target.value)} className={INPUT} />
        </Field>
        <Field label={RUNTIME_FIELDS.bodyTimeoutMs.label} unit="s">
          <input inputMode="decimal" value={body} onChange={(e) => setBody(e.target.value)} className={INPUT} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
          <PrimaryButton type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存运行参数"}
          </PrimaryButton>
          <FormStatus message={message} />
        </div>
      </form>
    </Panel>
  );
}

export function RoutingSettingsForm({ data, refresh }: { data: Overview; refresh?: (() => void) | undefined }) {
  const initialCooldown = {} as Record<CooldownKey, string>;
  for (const key of Object.keys(COOLDOWN_FIELDS) as CooldownKey[]) initialCooldown[key] = formatDuration(data.routing.cooldown[key], "s");
  const form = useFormState({
    strategy: data.routing.strategy,
    affinity: formatDuration(data.routing.affinityTtlMs, "min"),
    cooldown: initialCooldown,
  });
  const { strategy, affinity, cooldown } = form.value;
  const setStrategy = (v: typeof strategy) => form.set((p) => ({ ...p, strategy: v }));
  const setAffinity = (v: string) => form.set((p) => ({ ...p, affinity: v }));
  const setCooldown = (f: (prev: Record<CooldownKey, string>) => Record<CooldownKey, string>) =>
    form.set((p) => ({ ...p, cooldown: f(p.cooldown) }));
  const { saving, message, setMessage, save } = useSave(refresh, form.markSaved);
  useLeaveGuard(form.dirty);

  return (
    <Panel
      title="调度"
      hint="限流冷却在上游给出 Retry-After 时以上游为准；传输失败从起始退避开始指数增长，不超过最长退避。"
      action={<DirtyMark form={form} />}
    >
      <form
        aria-label="调度"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const a = parseDuration(affinity, AFFINITY_FIELD);
          if (!a.ok) return setMessage({ tone: "error", text: a.message });
          const next: Partial<Record<CooldownKey, number>> = {};
          for (const key of Object.keys(COOLDOWN_FIELDS) as CooldownKey[]) {
            const parsed = parseDuration(cooldown[key], COOLDOWN_FIELDS[key]);
            if (!parsed.ok) return setMessage({ tone: "error", text: parsed.message });
            next[key] = parsed.ms;
          }
          save({ routing: { strategy, affinityTtlMs: a.ms, cooldown: next } });
        }}
      >
        <Field label="调度策略">
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)} className={INPUT}>
            {RoutingStrategySchema.options.map((s) => (
              <option key={s} value={s}>
                {STRATEGY_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={AFFINITY_FIELD.label} unit="min">
          <input inputMode="decimal" value={affinity} onChange={(e) => setAffinity(e.target.value)} className={INPUT} />
        </Field>
        {(Object.keys(COOLDOWN_FIELDS) as CooldownKey[]).map((key) => (
          <Field key={key} label={COOLDOWN_FIELDS[key].label} unit="s">
            <input
              inputMode="decimal"
              value={cooldown[key]}
              onChange={(e) => setCooldown((prev) => ({ ...prev, [key]: e.target.value }))}
              className={INPUT}
            />
          </Field>
        ))}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
          {/* 本页主操作是运行参数的保存，这里用描边按钮。 */}
          <SecondaryButton type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存调度设置"}
          </SecondaryButton>
          <FormStatus message={message} />
        </div>
      </form>
    </Panel>
  );
}

/**
 * 表单面板右上角的状态：「未保存」，以及本地改过而服务端值又变了时的「载入最新」。
 * 与 `useFormState` 配套，模型页也用它。
 */
export function DirtyMark({ form }: { form: { dirty: boolean; serverChanged: boolean; reset: () => void } }) {
  if (!form.dirty) return null;
  return (
    <span className="inline-flex items-center gap-2" data-dirty="">
      <span className="text-label-13 text-warn">● 未保存</span>
      {form.serverChanged && (
        <SecondaryButton compact onClick={form.reset}>
          服务端已变化 · 载入最新
        </SecondaryButton>
      )}
    </span>
  );
}
