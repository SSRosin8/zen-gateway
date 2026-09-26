import { useEffect, useRef, type ReactNode } from "react";
import { PrimaryButton, SecondaryButton } from "./Panel.tsx";

/**
 * 确认对话框 —— 原生 `<dialog>` + `showModal()`。
 *
 * 原生模态自带焦点圈定、Esc 关闭与背景 inert，不需要额外依赖。
 * 打开时焦点落在「取消」上：破坏性或会改动全局状态的操作，回车不该直接确认。
 *
 * `destructive` 把确认按钮换成 error 描边；否则用主按钮。两种情况下对话框
 * 都只有一个主操作。
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="zg-dialog-title"
      /* Esc 触发原生 cancel 事件；交给调用方关闭，保持 open 由 props 决定。 */
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border-strong bg-surface p-0 text-text backdrop:bg-[#141413]/60"
    >
      {open && (
        <div className="px-5 py-4">
          <h2 id="zg-dialog-title" className="text-base font-medium">
            {title}
          </h2>
          <div className="mt-3 space-y-2 text-text-muted">{children}</div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <SecondaryButton buttonRef={cancelRef} onClick={onCancel}>
              取消
            </SecondaryButton>
            {destructive ? (
              <SecondaryButton danger onClick={onConfirm}>
                {confirmLabel}
              </SecondaryButton>
            ) : (
              <PrimaryButton onClick={onConfirm}>{confirmLabel}</PrimaryButton>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
