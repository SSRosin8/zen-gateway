import { useEffect, useState } from "react";

/**
 * 设置表单的状态：跟踪「改过没」，并在服务端值变了时处理冲突。
 *
 * - 本地没改：服务端值变化（网关重启、手改配置、别的标签页保存）时自动跟上，
 *   否则表单停在旧值，点保存会把旧值写回去。
 * - 本地改过：不覆盖用户输入，只标出「服务端的值已变化」，由用户决定载入最新。
 * - `dirty` 供页头与离页守卫显示「未保存」。
 *
 * 值用 JSON 比较：表单值是字符串与小对象，这里没有性能问题。
 */
export function useFormState<T>(server: T): {
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  dirty: boolean;
  /** 本地改过，而服务端值在此期间又变了。 */
  serverChanged: boolean;
  /** 放弃本地修改，载入服务端当前值。 */
  reset: () => void;
  /** 保存成功后调用：以刚保存的值为新的基准。 */
  markSaved: (saved?: T) => void;
} {
  const key = JSON.stringify(server);
  const [value, setValue] = useState<T>(server);
  // 基准用 state 而不是 ref：markSaved/reset 之后 `dirty` 要立刻重算，不能等调用方碰巧再渲染一次。
  const [base, setBase] = useState<string>(key);
  const [serverChanged, setServerChanged] = useState(false);
  const dirty = JSON.stringify(value) !== base;

  useEffect(() => {
    if (key === base) return;
    if (!dirty) {
      setBase(key);
      setValue(server);
      setServerChanged(false);
    } else {
      setServerChanged(true);
    }
    // `server` 与 `key` 同源；只按 key 触发，避免对象身份变化造成循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // 改过期间服务端变了，而用户又把输入改回了基准：此时已无本地修改要保护，载入最新值，
  // 否则表单停在旧值、「载入最新」按钮也随 dirty 一起消失。markSaved 同时清掉 serverChanged，不会误触发。
  useEffect(() => {
    if (dirty || !serverChanged) return;
    setBase(key);
    setValue(server);
    setServerChanged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, serverChanged]);

  return {
    value,
    set: (next) => setValue((prev) => (typeof next === "function" ? (next as (p: T) => T)(prev) : next)),
    dirty,
    serverChanged,
    reset: () => {
      setBase(key);
      setValue(server);
      setServerChanged(false);
    },
    markSaved: (saved) => {
      setBase(JSON.stringify(saved ?? value));
      setServerChanged(false);
    },
  };
}

/**
 * 有未保存修改时拦住离开：换页（hash 变化）先确认，关页由浏览器原生提示。
 * `dirty` 为 false 时什么都不做。
 *
 * 同一页可能有多个表单同时改过（网关页的运行参数与调度）：它们共用一个监听，
 * 否则每个表单各问一次，取消后恢复 hash 那一次又会被另一个表单当成换页再问。
 */
export function useLeaveGuard(dirty: boolean, message = "有未保存的修改，确定离开吗？"): void {
  useEffect(() => {
    if (!dirty) return;
    const entry = { message };
    guards.add(entry);
    if (guards.size === 1) installGuard();
    return () => {
      guards.delete(entry);
      if (guards.size === 0) uninstallGuard?.();
    };
  }, [dirty, message]);
}

const guards = new Set<{ message: string }>();
let uninstallGuard: (() => void) | null = null;

function installGuard(): void {
  const beforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };
  let restoring = false;
  let last = window.location.hash;
  const onHash = (e: HashChangeEvent) => {
    if (restoring) {
      restoring = false;
      return;
    }
    const leavingPage = new URL(e.oldURL).hash.split("?")[0] !== new URL(e.newURL).hash.split("?")[0];
    const [first] = guards;
    if (leavingPage && first !== undefined && !window.confirm(first.message)) {
      restoring = true;
      e.stopImmediatePropagation();
      window.location.hash = last;
      return;
    }
    last = window.location.hash;
  };
  window.addEventListener("beforeunload", beforeUnload);
  // 捕获阶段先于路由的 hashchange 监听运行，才能在切页前拦下。
  window.addEventListener("hashchange", onHash, true);
  uninstallGuard = () => {
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("hashchange", onHash, true);
    uninstallGuard = null;
  };
}
