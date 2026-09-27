import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfigPatch } from "../../shared/contract.ts";
import { patchConfig } from "./api.ts";

/**
 * 行内反馈与撤销。
 *
 * 行操作（启停、删除、探测）的结果显示在那一行上，而不是表格顶部：翻到第 2 页点「停用」时，
 * 顶部那条提示根本不在视野里。可逆操作不弹确认框，结果旁给「撤销」，10 秒内有效；
 * 撤销就是发一个反向补丁。
 *
 * 失败的提示保留到该行下一次操作（失败要看得见），成功与可撤销的提示 10 秒后消失。
 */
export type RowNote = {
  readonly tone: "success" | "error";
  readonly text: string;
  /** 反向补丁；有它时显示「撤销」按钮。 */
  readonly undo?: ConfigPatch;
};

export const UNDO_WINDOW_MS = 10_000;

export function useRowNotes(refresh?: () => void): {
  noteOf: (key: string) => RowNote | undefined;
  set: (keys: readonly string[], note: RowNote) => void;
  clear: (key: string) => void;
  /** 应用补丁并把结果写到这些行上；`undo` 给出时附带撤销。 */
  apply: (keys: readonly string[], patch: ConfigPatch, success: string, undo?: ConfigPatch) => Promise<boolean>;
  runUndo: (key: string) => Promise<void>;
  busy: boolean;
} {
  const [notes, setNotes] = useState<ReadonlyMap<string, RowNote>>(new Map());
  // 计数而非布尔：两个补丁重叠时，先结束的那个不能提前放开按钮。
  const [pending, setPending] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);

  const clear = useCallback((key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setNotes((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const set = useCallback(
    (keys: readonly string[], note: RowNote) => {
      setNotes((prev) => {
        const next = new Map(prev);
        for (const k of keys) next.set(k, note);
        return next;
      });
      for (const k of keys) {
        clearTimeout(timers.current.get(k));
        if (note.tone === "success") timers.current.set(k, setTimeout(() => clear(k), UNDO_WINDOW_MS));
        else timers.current.delete(k);
      }
    },
    [clear],
  );

  const apply = useCallback(
    async (keys: readonly string[], patch: ConfigPatch, success: string, undo?: ConfigPatch) => {
      setPending((n) => n + 1);
      try {
        await patchConfig(patch);
        set(keys, { tone: "success", text: success, ...(undo !== undefined ? { undo } : {}) });
        refresh?.();
        return true;
      } catch (err) {
        set(keys, { tone: "error", text: err instanceof Error ? err.message : String(err) });
        return false;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [refresh, set],
  );

  const runUndo = useCallback(
    async (key: string) => {
      const note = notes.get(key);
      if (note?.undo === undefined) return;
      // 同一批操作的所有行共用一个撤销：撤销一次，清掉它们全部的提示。
      const siblings = [...notes].filter(([, n]) => n === note).map(([k]) => k);
      setPending((n) => n + 1);
      try {
        await patchConfig(note.undo);
        for (const k of siblings) clear(k);
        set(siblings, { tone: "success", text: "已撤销" });
        refresh?.();
      } catch (err) {
        set(siblings, { tone: "error", text: `撤销失败：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        setPending((n) => n - 1);
      }
    },
    [notes, clear, set, refresh],
  );

  return { noteOf: (key) => notes.get(key), set, clear, apply, runUndo, busy: pending > 0 };
}
