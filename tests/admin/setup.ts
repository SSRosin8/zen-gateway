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
});
