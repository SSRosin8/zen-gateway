import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/*
 * 必须显式注册 cleanup。
 *
 * @testing-library/react 只在 `globals: true` 时才自动挂 afterEach 清理,
 * 而本项目没开 globals(显式 import 更清楚)。缺了这一行,每个 render
 * 都会把 DOM 留在 document.body 里累积 —— 后面的测试用 getByText 会
 * 撞上「找到多个元素」,或者更糟:断言到上一个测试留下的节点而误判通过。
 */
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.skin;
});

/*
 * jsdom 没有实现 `HTMLDialogElement.showModal/close`。
 *
 * 这里只补状态：`open` 属性与 close 事件。模态本身的焦点圈定、背景 inert
 * 属于浏览器行为，不在组件测试范围内；截图验证覆盖真实渲染。
 * 只在缺失时补，避免 jsdom 将来实现后被这里覆盖。
 */
const proto = window.HTMLDialogElement?.prototype;
if (proto !== undefined && typeof proto.showModal !== "function") {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.show = function show(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/*
 * jsdom 也没有实现 Popover API：`[popover]` 被默认样式隐藏，却没有
 * `showPopover/hidePopover`，`popovertarget` 按钮点了也没反应。
 *
 * 同样只补状态：打开时用行内 display 盖过默认隐藏，并发出带 `newState` 的
 * toggle 事件（组件据此定位与移焦）。置顶层与点外面关闭属于浏览器行为，不在这里模拟。
 */
const el = window.HTMLElement.prototype as HTMLElement & Record<string, unknown>;
if (typeof el.showPopover !== "function") {
  const open = new WeakSet<HTMLElement>();
  const setOpen = (node: HTMLElement, next: boolean) => {
    if (open.has(node) === next) return;
    if (next) open.add(node);
    else open.delete(node);
    node.style.display = next ? "block" : "";
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: next ? "open" : "closed" });
    node.dispatchEvent(event);
  };
  el.showPopover = function showPopover(this: HTMLElement) {
    setOpen(this, true);
  };
  el.hidePopover = function hidePopover(this: HTMLElement) {
    setOpen(this, false);
  };
  el.togglePopover = function togglePopover(this: HTMLElement) {
    setOpen(this, !open.has(this));
    return open.has(this);
  };
  document.addEventListener("click", (e) => {
    const invoker = (e.target as Element | null)?.closest?.("[popovertarget]");
    const id = invoker?.getAttribute("popovertarget");
    const target = id ? document.getElementById(id) : null;
    if (target?.hasAttribute("popover")) setOpen(target, !open.has(target));
  });
}
