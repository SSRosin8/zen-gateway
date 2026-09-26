import { useEffect, useId, useRef, useState } from "react";
import type { ConfigPatch, ProxyList, WorkerView } from "../../shared/contract.ts";
import { FormStatus, PrimaryButton, SecondaryButton, type FormMessage } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import type { FetchState } from "../lib/api.ts";
import { suggestWorker, validateWorkerId } from "../lib/workerIds.ts";

const INPUT = "min-h-[44px] rounded-sm border border-border-strong bg-bg px-3";

type Kind = "anonymous" | "authenticated";

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
          <input value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hintId} className={INPUT} />
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

/**
 * Worker 新增 / 编辑表单。
 *
 * ## 新增时自动填 id 与名称
 *
 * 默认匿名（不需要凭证就能用），id 取下一个空闲的 `anon-N` / `auth-N`，名称
 * 「匿名 N」/「认证 N」。切换类型时重新建议，**除非用户已经手改过**那个字段：
 * 覆盖用户输入比不建议更糟。id 在客户端按契约规则与现有 id 校验，服务端仍会再判。
 */
export function WorkerEditor({
  mode,
  worker,
  existingIds = [],
  saving,
  proxies,
  message,
  onCancel,
  onSave,
}: {
  mode: "create" | "edit";
  worker?: WorkerView;
  /** 新增时用于建议 id 与唯一性校验。 */
  existingIds?: readonly string[];
  saving: boolean;
  proxies: FetchState<ProxyList> | undefined;
  /** 本编辑器的保存失败；成功时编辑器已收起，不会收到。 */
  message: FormMessage;
  onCancel: () => void;
  onSave: (patch: ConfigPatch) => Promise<void>;
}) {
  const initialKind: Kind = worker?.kind ?? "anonymous";
  const initial = mode === "create" ? suggestWorker(existingIds, initialKind) : { id: worker?.id ?? "", name: worker?.name ?? "" };
  const [id, setId] = useState(initial.id);
  const [name, setName] = useState(initial.name);
  const [touched, setTouched] = useState({ id: false, name: false });
  const [kind, setKind] = useState<Kind>(initialKind);
  const [apiKey, setApiKey] = useState("");
  const [proxyId, setProxyId] = useState(worker?.proxyId ?? "");
  const [enabled, setEnabled] = useState(worker?.enabled ?? true);
  const [idError, setIdError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const idErrorId = useId();

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

  const changeKind = (nextKind: Kind) => {
    setKind(nextKind);
    // 匿名身份不收集凭证；切换时也丢掉尚未提交的认证 key。
    if (nextKind === "anonymous") setApiKey("");
    if (mode === "create") {
      const s = suggestWorker(existingIds, nextKind);
      if (!touched.id) {
        setId(s.id);
        setIdError(null);
      }
      if (!touched.name) setName(s.name);
    }
  };

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      aria-label={mode === "create" ? "新增 Worker" : `编辑 Worker ${worker?.id ?? ""}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const proxy = proxyId.trim() === "" ? null : proxyId.trim();
        if (mode === "create") {
          const err = validateWorkerId(id, new Set(existingIds));
          setIdError(err);
          if (err !== null) return;
          void onSave({
            workers: {
              create: [
                {
                  id: id.trim(),
                  name,
                  kind,
                  // 匿名身份不采集 key，但请求契约仍显式给出空值。
                  apiKey: kind === "authenticated" ? apiKey : "",
                  proxyId: proxy,
                  enabled,
                },
              ],
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
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">类型</span>
        <select value={kind} onChange={(e) => changeKind(e.target.value as Kind)} className={INPUT}>
          <option value="anonymous">匿名 Worker</option>
          <option value="authenticated">认证 Worker</option>
        </select>
      </label>
      {mode === "create" && (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">ID</span>
            <input
              ref={firstField}
              value={id}
              aria-invalid={idError !== null ? true : undefined}
              aria-describedby={idError !== null ? idErrorId : undefined}
              onChange={(e) => {
                setId(e.target.value);
                setTouched((t) => ({ ...t, id: true }));
                if (idError !== null) setIdError(validateWorkerId(e.target.value, new Set(existingIds)));
              }}
              className={`${INPUT} font-mono`}
            />
          </label>
          {idError !== null && (
            <span id={idErrorId} role="alert">
              <StatusIndicator tone="error" icon="✕" label={idError} />
            </span>
          )}
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">名称</span>
        <input
          ref={mode === "edit" ? firstField : undefined}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setTouched((t) => ({ ...t, name: true }));
          }}
          className={INPUT}
        />
      </label>
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
        <p className="text-text-muted sm:col-span-2 xl:col-span-3">
          认证 Worker 必须有 key。要去掉已保存的 key，把类型改为匿名 Worker。
        </p>
      )}
      {dropsSavedKey && (
        <p className="sm:col-span-2 xl:col-span-3" data-drops-key="">
          <StatusIndicator tone="warn" icon="!" label="改为匿名后，已保存的 API key 会被删除且无法从后台找回。" />
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-3">
        <PrimaryButton type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
        <FormStatus message={message} />
      </div>
    </form>
  );
}
