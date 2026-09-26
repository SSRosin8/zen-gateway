import { useId, useState } from "react";
import type { SecretPatch, SecretPresence } from "../../shared/contract.ts";
import { Mono } from "./Panel.tsx";

/**
 * 已保存凭证的三态编辑：留空不改 / 设置新值 / 清空。
 *
 * 前端拿不到原值，所以「空输入框」不能等于「清空」—— 否则用户只改了名称，
 * 提交时就把一个能用的 secret 抹掉了。清空必须显式选择（契约 `SecretPatchSchema`）。
 */
export type SecretMode = "keep" | "set" | "clear";

export function secretPatch(mode: SecretMode, value: string): SecretPatch | undefined {
  if (mode === "set") return { set: value };
  if (mode === "clear") return { clear: true };
  return undefined;
}

export function useSecretField() {
  const [mode, setMode] = useState<SecretMode>("keep");
  const [value, setValue] = useState("");
  return { mode, setMode, value, setValue, patch: () => secretPatch(mode, value) };
}

export function SecretField({
  label,
  saved,
  field,
  allowClear = true,
  hint,
}: {
  label: string;
  saved: SecretPresence;
  field: ReturnType<typeof useSecretField>;
  /** 必填凭证（如订阅 URL）不能清空。 */
  allowClear?: boolean;
  /** 替换默认的「已保存，指纹 …」说明（如订阅 URL 显示脱敏串）。 */
  hint?: React.ReactNode;
}) {
  const hintId = useId();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-text-muted">{label}</legend>
      <select
        aria-label={`${label}的修改方式`}
        aria-describedby={hintId}
        value={field.mode}
        onChange={(e) => {
          field.setMode(e.target.value as SecretMode);
          if (e.target.value !== "set") field.setValue("");
        }}
        className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
      >
        <option value="keep">留空不改</option>
        <option value="set">设置新值</option>
        {allowClear && saved.present && <option value="clear">清空</option>}
      </select>
      {field.mode === "set" && (
        <input
          type="password"
          autoComplete="off"
          aria-label={`新的${label}`}
          value={field.value}
          onChange={(e) => field.setValue(e.target.value)}
          className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
        />
      )}
      <span id={hintId} className="text-label-13 text-text-muted">
        {hint !== undefined ? hint : saved.present ? (
          <>
            已保存，指纹 <Mono>{saved.fingerprint}</Mono>
          </>
        ) : (
          "未设置"
        )}
      </span>
    </fieldset>
  );
}
