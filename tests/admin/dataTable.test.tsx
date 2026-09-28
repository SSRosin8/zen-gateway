import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable, PAGE_SIZE, ROW_HEIGHT } from "../../src/admin/components/DataTable.tsx";

/*
 * 在筛选之间切换时表格高度不跳：总数多于一页时，表格区固定为「表头 + 一整页」的高度，
 * 分页栏常在；空结果也占同样的高度。jsdom 不做布局，所以断言的是预留的最小高度。
 */

const cols = [{ key: "id", header: "id", render: (r: { id: string }) => r.id }];
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
const page = `${(PAGE_SIZE + 1) * ROW_HEIGHT}px`;

function table(n: number, total: number | undefined) {
  return (
    <DataTable label="t" rows={rows(n)} {...(total === undefined ? {} : { total })} columns={cols} rowKey={(r) => r.id} page={1} onPageChange={() => {}} empty={<p>空</p>} />
  );
}

function reserved(container: HTMLElement): string {
  return (container.querySelector("[style*='min-height']") as HTMLElement | null)?.style.minHeight ?? "";
}

describe("DataTable 的固定高度", () => {
  it("总数多于一页时，满页、少行、空结果预留的高度一样，分页栏常在", () => {
    for (const n of [PAGE_SIZE * 2, 3, 0]) {
      const { container, unmount } = render(table(n, PAGE_SIZE * 3));
      expect(reserved(container)).toBe(page);
      if (n > 0) expect(screen.getByText(/共 \d+ 条/)).toBeInTheDocument();
      unmount();
    }
  });

  it("总数本来就不满一页时不预留空白；不传 total 时行为不变", () => {
    for (const total of [5, undefined]) {
      const { container, unmount } = render(table(3, total));
      expect(reserved(container)).toBe("");
      expect(screen.queryByText(/共 \d+ 条/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("DataTable 的固定操作列", () => {
  const pinned = [
    { key: "id", header: "id", render: (r: { id: string }) => r.id },
    { key: "actions", header: "操作", pinEnd: true, render: () => <button type="button">编辑</button> },
  ];

  it("表头与每一行的操作格都标为固定，其他列不标", () => {
    const { container } = render(
      <DataTable label="t" rows={rows(3)} columns={pinned} rowKey={(r) => r.id} page={1} onPageChange={() => {}} empty={<p>空</p>} />,
    );
    const marked = [...container.querySelectorAll("[data-pin='end']")];
    expect(marked).toHaveLength(4);
    expect(marked.every((el) => el === el.parentElement!.lastElementChild)).toBe(true);
    expect(marked[0]).toHaveTextContent("操作");
  });

  it("固定列不在最后时直接报错，而不是盖住右边的列", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <DataTable label="t" rows={rows(1)} columns={[...pinned].reverse()} rowKey={(r) => r.id} page={1} onPageChange={() => {}} empty={<p>空</p>} />,
      ),
    ).toThrow(/固定列必须是最后一列/);
    vi.restoreAllMocks();
  });
});
