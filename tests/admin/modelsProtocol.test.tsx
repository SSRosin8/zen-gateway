import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ModelsPage, protocolText } from "../../src/admin/pages/ModelsPage.tsx";
import type { ModelList, ModelView } from "../../src/shared/contract.ts";
import { parseHash } from "../../src/admin/lib/router.ts";

/* 模型页「协议」列：声明（models.dev）与实测（本网关 2xx）分开说，拿不到就说拿不到。 */

const noop = () => {};

function model(id: string, protocol: ModelView["protocol"]): ModelView {
  return { id, free: true, reason: "suffix", protocol, listed: true };
}

function list(models: ModelView[], available = true, measuredSinceDay: string | null = "2026-01-01"): ModelList {
  return {
    models,
    catalogAvailable: true,
    protocolSource: { available, fetchedAt: available ? "2026-01-01T00:00:00.000Z" : null },
    measuredSinceDay,
    rules: { freeSuffix: "-free", extraFreeIds: [], catalogTtlMs: 1_800_000, enforceCatalog: true },
  };
}

function cellOf(id: string, header: string): HTMLElement {
  const table = within(screen.getByRole("region", { name: "模型列表" })).getByRole("table");
  const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
  const col = headers.indexOf(header);
  expect(col).toBeGreaterThanOrEqual(0);
  const row = within(table).getByText(id).closest("tr")!;
  return within(row).getAllByRole("cell")[col]!;
}

describe("模型页协议列", () => {
  it("各模型显示自己的声明协议（人话标签）", () => {
    render(
      <ModelsPage
        data={list([
          model("a-free", { declared: "chat", measured: [] }),
          model("b-free", { declared: "responses", measured: [] }),
          model("c-free", { declared: "messages", measured: [] }),
          model("d-free", { declared: "other", measured: [] }),
        ])}
        view={parseHash("#models")}
        navigate={noop}
      />,
    );
    expect(cellOf("a-free", "协议")).toHaveTextContent(/^Chat$/);
    expect(cellOf("b-free", "协议")).toHaveTextContent(/^Responses$/);
    expect(cellOf("c-free", "协议")).toHaveTextContent(/^Messages$/);
    expect(cellOf("d-free", "协议")).toHaveTextContent("网关不支持的协议");
  });

  it("实测与声明一致时不重复；补充了别的面才标「实测」", () => {
    render(
      <ModelsPage
        data={list([
          model("a-free", { declared: "chat", measured: ["chat"] }),
          model("b-free", { declared: "chat", measured: ["chat", "responses"] }),
        ])}
        view={parseHash("#models")}
        navigate={noop}
      />,
    );
    expect(cellOf("a-free", "协议")).toHaveTextContent(/^Chat$/);
    expect(cellOf("b-free", "协议")).toHaveTextContent("Chat · 实测：Chat / Responses");
  });

  it("没声明时写「未声明」，有实测就附上", () => {
    render(
      <ModelsPage
        data={list([
          model("a-free", { declared: null, measured: [] }),
          model("b-free", { declared: null, measured: ["messages"] }),
        ])}
        view={parseHash("#models")}
        navigate={noop}
      />,
    );
    expect(cellOf("a-free", "协议")).toHaveTextContent(/^未声明$/);
    expect(cellOf("b-free", "协议")).toHaveTextContent("未声明 · 实测：Messages");
  });

  it("声明源拿不到时说「声明拿不到」，不说成模型没声明", () => {
    expect(protocolText(model("a-free", { declared: null, measured: [] }), false)).toBe("声明拿不到");
    expect(protocolText(model("a-free", { declared: null, measured: [] }), true)).toBe("未声明");
  });
});
