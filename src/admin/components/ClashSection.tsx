import { useState } from "react";
import type { ConfigPatch, ProxyList } from "../../shared/contract.ts";
import { FormStatus, Mono, Panel, SecondaryButton, errorMessage, type FormMessage } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SimpleTable, type Column } from "./DataTable.tsx";
import { SecretField, useSecretField } from "./SecretField.tsx";
import { ClashImportFlow } from "./ClashImportFlow.tsx";
import { patchConfig } from "../lib/api.ts";
import { FIELD } from "../lib/styles.ts";

/**
 * 代理池页的 Clash 内核管理：总开关、选择模式、内核增删改，以及探测导入。
 *
 * 内核 id 创建后不能改（代理的 `bridgeId` 按 id 引用）；secret 走三态。
 * 删除内核会连带删除它导入的代理，被 Worker 引用时服务端整体拒绝并说明原因。
 */
type Clash = ProxyList["clash"];
type Bridge = Clash["bridges"][number];

const INPUT = `${FIELD} w-full`;

export function ClashSection({ clash, refresh }: { clash: Clash; refresh: () => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Bridge | null>(null);
  const [message, setMessage] = useState<FormMessage>(null);
  const [busy, setBusy] = useState(false);

  const save = async (patch: ConfigPatch, success: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      await patchConfig(patch);
      setMessage({ tone: "success", text: success });
      refresh();
      return true;
    } catch (err) {
      setMessage(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const columns: ReadonlyArray<Column<Bridge>> = [
    {
      key: "id",
      header: "内核",
      render: (b) => (
        <span className="inline-flex items-center gap-2">
          <Mono>{b.id}</Mono>
          <span className="text-text-muted">{b.name}</span>
          {b.id === clash.activeBridgeId && <span className="text-accent-fg">当前</span>}
        </span>
      ),
    },
    {
      key: "enabled",
      header: "状态",
      render: (b) =>
        b.enabled ? <StatusIndicator tone="success" icon="✓" label="启用" /> : <StatusIndicator tone="neutral" icon="○" label="已停用" />,
    },
    { key: "api", header: "控制面", render: (b) => <Mono>{b.apiBase}</Mono> },
    { key: "port", header: "代理端口", numeric: true, render: (b) => <Mono>{`${b.localProxyHost}:${b.localProxyPort}`}</Mono> },
    { key: "group", header: "分组", render: (b) => <Mono>{b.selectorGroup}</Mono> },
    { key: "priority", header: "优先级", numeric: true, render: (b) => <Mono>{b.priority}</Mono> },
    {
      key: "secret",
      header: "secret",
      render: (b) => (b.apiSecret.present ? <Mono>{b.apiSecret.fingerprint}</Mono> : <span className="text-text-muted">无</span>),
    },
    {
      key: "actions",
      header: "操作",
      render: (b) => (
        <span className="flex gap-2">
          <SecondaryButton compact onClick={() => setEditing(editing === b.id ? null : b.id)}>
            {editing === b.id ? "收起" : "编辑"}
          </SecondaryButton>
          <SecondaryButton compact danger disabled={busy} onClick={() => setPendingDelete(b)}>
            删除
          </SecondaryButton>
        </span>
      ),
    },
  ];

  const editingBridge = clash.bridges.find((b) => b.id === editing) ?? null;

  return (
    <div className="space-y-4">
      <Panel
        title={`Clash 内核（${clash.bridges.length}）`}
        action={
          <SecondaryButton onClick={() => setEditing(editing === "new" ? null : "new")}>
            {editing === "new" ? "收起" : "添加内核"}
          </SecondaryButton>
        }
      >
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex min-h-[44px] items-center gap-2">
            <input
              type="checkbox"
              checked={clash.enabled}
              disabled={busy}
              onChange={(e) => void save({ clash: { enabled: e.target.checked } }, e.target.checked ? "已启用 Clash 桥接" : "已停用 Clash 桥接")}
            />
            启用 Clash 桥接
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">内核选择</span>
            <select
              value={clash.selectionMode}
              disabled={busy}
              onChange={(e) => void save({ clash: { selectionMode: e.target.value as Clash["selectionMode"] } }, "已保存")}
              className={FIELD}
            >
              <option value="auto">自动（按优先级选健康内核）</option>
              <option value="manual">手动</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">当前内核</span>
            <select
              value={clash.activeBridgeId ?? ""}
              disabled={busy}
              onChange={(e) => void save({ clash: { activeBridgeId: e.target.value === "" ? null : e.target.value } }, "已保存")}
              className={FIELD}
            >
              <option value="">未指定</option>
              {clash.bridges.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}（{b.id}）
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3">
          <FormStatus message={message} />
        </div>

        {editing === "new" && (
          <div className="mt-4 border-t border-border-strong pt-4">
            <BridgeEditor
              existingIds={clash.bridges.map((b) => b.id)}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={async (patch) => {
                if (await save(patch, "已添加内核")) setEditing(null);
              }}
            />
          </div>
        )}

        <div className="mt-4">
          {clash.bridges.length === 0 ? (
            <p className="text-text-muted">还没有 Clash 内核。用下面的探测导入，或手动添加。</p>
          ) : (
            <SimpleTable label="Clash 内核" rows={clash.bridges} columns={columns} rowKey={(b) => b.id} rowAttr="data-bridge" />
          )}
        </div>

        {editingBridge !== null && (
          <div className="mt-4 border-t border-border-strong pt-4">
            <BridgeEditor
              key={editingBridge.id}
              bridge={editingBridge}
              existingIds={[]}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={async (patch) => {
                if (await save(patch, "已保存")) setEditing(null);
              }}
            />
          </div>
        )}

        <p className="mt-3 max-w-3xl text-text-muted">
          代理端口必须与内核实际的 <Mono>mixed-port</Mono> 一致，否则桥接代理全部传输失败而控制面仍是通的。
          分组不要用 <Mono>GLOBAL</Mono>：rule 模式下它不参与选路，切它不改变出口。
        </p>
      </Panel>

      <Panel title="Clash 探测与导入">
        <ClashImportFlow onImported={refresh} />
      </Panel>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除 Clash 内核"
        confirmLabel="确认删除"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const b = pendingDelete;
          setPendingDelete(null);
          if (b !== null) void save({ clash: { bridges: { delete: [b.id] } } }, "已删除内核");
        }}
      >
        <p>
          将删除内核 <Mono>{pendingDelete?.id ?? ""}</Mono>，以及它导入的全部代理节点。
        </p>
        <p>有 Worker 正在使用其中的节点时不会删除，先把那些 Worker 改绑到别的出口。</p>
      </ConfirmDialog>
    </div>
  );
}

function BridgeEditor({
  bridge,
  existingIds,
  busy,
  onCancel,
  onSave,
}: {
  bridge?: Bridge;
  existingIds: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: ConfigPatch) => Promise<void>;
}) {
  const [id, setId] = useState(bridge?.id ?? "");
  const [name, setName] = useState(bridge?.name ?? "");
  const [apiBase, setApiBase] = useState(bridge?.apiBase ?? "http://127.0.0.1:9097");
  const [host, setHost] = useState(bridge?.localProxyHost ?? "127.0.0.1");
  const [port, setPort] = useState(String(bridge?.localProxyPort ?? 7897));
  const [group, setGroup] = useState(bridge?.selectorGroup ?? "");
  const [priority, setPriority] = useState(String(bridge?.priority ?? 100));
  const [enabled, setEnabled] = useState(bridge?.enabled ?? true);
  const secret = useSecretField();
  const [error, setError] = useState<FormMessage>(null);

  return (
    <form
      aria-label={bridge === undefined ? "添加 Clash 内核" : `编辑内核 ${bridge.id}`}
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const portNum = Number(port);
        const prio = Number(priority);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return setError({ tone: "error", text: "代理端口必须是 1 到 65535 的整数" });
        if (!Number.isInteger(prio) || prio < 0 || prio > 999) return setError({ tone: "error", text: "优先级必须是 0 到 999 的整数" });
        if (name.trim() === "") return setError({ tone: "error", text: "名称不能为空" });
        const secretPatch = secret.patch();
        if (bridge === undefined) {
          if (id.trim() === "") return setError({ tone: "error", text: "ID 不能为空" });
          if (existingIds.includes(id.trim())) return setError({ tone: "error", text: `ID ${id.trim()} 已被占用` });
          setError(null);
          void onSave({
            clash: {
              bridges: {
                create: [
                  {
                    id: id.trim(),
                    name: name.trim(),
                    enabled,
                    priority: prio,
                    apiBase: apiBase.trim(),
                    apiSecret: secretPatch !== undefined && "set" in secretPatch ? secretPatch.set : "",
                    localProxyHost: host.trim(),
                    localProxyPort: portNum,
                    selectorGroup: group.trim() === "" ? "GLOBAL" : group.trim(),
                  },
                ],
              },
            },
          });
          return;
        }
        setError(null);
        void onSave({
          clash: {
            bridges: {
              update: {
                [bridge.id]: {
                  name: name.trim(),
                  enabled,
                  priority: prio,
                  apiBase: apiBase.trim(),
                  localProxyHost: host.trim(),
                  localProxyPort: portNum,
                  ...(group.trim() === "" ? {} : { selectorGroup: group.trim() }),
                  ...(secretPatch === undefined ? {} : { apiSecret: secretPatch }),
                },
              },
            },
          },
        });
      }}
    >
      {bridge === undefined && (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">ID</span>
          <input value={id} onChange={(e) => setId(e.target.value)} className={`${INPUT} font-mono`} />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">控制面地址</span>
        <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} className={`${INPUT} font-mono`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">代理主机</span>
        <input value={host} onChange={(e) => setHost(e.target.value)} className={`${INPUT} font-mono`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">代理端口（mixed-port）</span>
        <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} className={`${INPUT} font-mono`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">selector 分组</span>
        <input value={group} onChange={(e) => setGroup(e.target.value)} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">优先级（越小越优先）</span>
        <input inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT} />
      </label>
      <SecretField
        label="控制面 secret"
        saved={bridge?.apiSecret ?? { present: false, fingerprint: null }}
        field={secret}
      />
      <label className="flex min-h-[44px] items-center gap-2 self-end">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-4">
        <SecondaryButton type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存内核"}
        </SecondaryButton>
        <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
        <FormStatus message={error} />
      </div>
    </form>
  );
}
