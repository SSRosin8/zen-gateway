import { useEffect, useRef, useState } from "react";
import type { ConfigPatch, ProxyView } from "../../shared/contract.ts";
import { DIRECT_PROTOCOLS, IdSchema, ProxySchema } from "../../shared/schema.ts";
import { FormStatus, PrimaryButton, SecondaryButton, errorMessage, type FormMessage } from "./Panel.tsx";
import { SecretField, useSecretField } from "./SecretField.tsx";
import { FIELD } from "../lib/styles.ts";

/**
 * 手工直连代理的新增 / 编辑表单。
 *
 * 只处理 `source: "manual"` 的直连代理：订阅与 Controller 导入的节点改了会在下次刷新时被覆盖，
 * 桥接节点的出口由 Clash selector 决定，改 host/端口没有意义（服务端同样拒绝）。
 * 改了连接信息后服务端把 `egressIp` 置为未探测，保存成功后提示重新探测。
 */

type Protocol = (typeof DIRECT_PROTOCOLS)[number];

/** 能在后台编辑连接信息的代理。与 `patchSections.ts` 的判据相同。 */
export function isEditableProxy(p: ProxyView): boolean {
  return p.source === "manual" && p.direct && !p.bridgeable;
}

/** 下一个空闲的 `manual-N`。与 Worker 一样取最大序号 + 1，不填空洞。 */
export function suggestProxyId(existingIds: Iterable<string>): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^manual-(\d+)$/.exec(id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `manual-${max + 1}`;
}

/** 前端先按存储 schema 查 id、主机与端口（纪律 #4），错误指出字段；唯一性与完整校验仍由服务端判定。 */
export function validateProxyForm(
  form: { id: string; host: string; port: string },
  existingIds: ReadonlySet<string> | null,
): string | null {
  if (existingIds !== null) {
    const id = form.id.trim();
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) return `ID 不合法：${parsed.error.issues[0]?.message ?? "格式不对"}`;
    if (existingIds.has(id)) return `ID ${id} 已存在`;
  }
  const host = ProxySchema.shape.host.safeParse(form.host.trim());
  if (!host.success) return `主机不合法：${host.error.issues[0]?.message ?? "格式不对"}`;
  const port = ProxySchema.shape.port.safeParse(form.port.trim() === "" ? Number.NaN : Number(form.port.trim()));
  if (!port.success) return "端口必须是 1 到 65535 的整数";
  return null;
}

export function ProxyEditor({
  mode,
  proxy,
  existingIds,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  proxy?: ProxyView;
  existingIds: readonly string[];
  onCancel: () => void;
  /** 失败时抛出；错误显示在表单里，表单保持打开。 */
  onSave: (patch: ConfigPatch) => Promise<void>;
}) {
  const [id, setId] = useState(() => (mode === "create" ? suggestProxyId(existingIds) : (proxy?.id ?? "")));
  const [name, setName] = useState(proxy?.name ?? "");
  const [type, setType] = useState<Protocol>(() => {
    const t = proxy?.type.toLowerCase();
    return (DIRECT_PROTOCOLS as readonly string[]).includes(t ?? "") ? (t as Protocol) : "http";
  });
  const [host, setHost] = useState(proxy?.host ?? "127.0.0.1");
  const [port, setPort] = useState(proxy === undefined ? "" : String(proxy.port));
  const [username, setUsername] = useState(proxy?.username ?? "");
  const password = useSecretField();
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const firstField = useRef<HTMLInputElement>(null);

  // 表单插在表格中间，打开时把焦点移进来，键盘用户才知道它出现在哪里。
  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const submit = async () => {
    const err = validateProxyForm({ id, host, port }, mode === "create" ? new Set(existingIds) : null);
    if (err !== null) return setMessage({ tone: "error", text: err });
    const common = { type, host: host.trim(), port: Number(port.trim()), username: username.trim() };
    const trimmedName = name.trim() === "" ? id.trim() : name.trim();
    const patch: ConfigPatch =
      mode === "create"
        ? {
            proxies: {
              create: [
                {
                  id: id.trim(),
                  name: trimmedName,
                  ...common,
                  ...(newPassword !== "" ? { password: newPassword } : {}),
                  enabled: true,
                },
              ],
            },
          }
        : (() => {
            const secret = password.patch();
            return {
              proxies: {
                update: { [proxy!.id]: { name: trimmedName, ...common, ...(secret !== undefined ? { password: secret } : {}) } },
              },
            };
          })();
    setSaving(true);
    setMessage(null);
    try {
      await onSave(patch);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      aria-label={mode === "create" ? "新增代理" : `编辑代理 ${proxy?.id ?? ""}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {mode === "create" && (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">ID</span>
          <input ref={firstField} value={id} onChange={(e) => setId(e.target.value)} className={FIELD} />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">名称（留空用 id）</span>
        <input
          ref={mode === "edit" ? firstField : undefined}
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">协议</span>
        <select value={type} onChange={(e) => setType(e.target.value as Protocol)} className={FIELD}>
          {DIRECT_PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">主机</span>
        <input value={host} onChange={(e) => setHost(e.target.value)} className={FIELD} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">端口</span>
        <input type="number" min={1} max={65535} step={1} value={port} onChange={(e) => setPort(e.target.value)} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">用户名（可选）</span>
        <input value={username} maxLength={256} onChange={(e) => setUsername(e.target.value)} className={FIELD} autoComplete="off" />
      </label>
      {mode === "create" ? (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">口令（可选）</span>
          <input type="password" autoComplete="off" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={FIELD} />
        </label>
      ) : (
        <SecretField label="口令" saved={proxy!.password} field={password} />
      )}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-3">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? "保存中…" : mode === "create" ? "新增代理" : "保存"}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
        <FormStatus message={message} />
        <span className="text-label-13 text-text-muted">改了连接信息后回显出口变为未探测，保存后重新探测一次。</span>
      </div>
    </form>
  );
}
