import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import { ApiClient } from "../lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
it("shows model-supported reasoning efforts beside the model picker and protects mandatory reasoning", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listModels").mockResolvedValue([
    {
      id: "model",
      name: "Model",
      supportsReasoning: true,
      reasoningMandatory: true,
      reasoningEfforts: ["low", "high"],
    },
  ]);
  const change = vi.fn();
  render(
    <ModelPicker
      client={client}
      model="model"
      models={[]}
      reasoning="auto"
      onReasoningChange={change}
    />,
  );
  fireEvent.click(screen.getByLabelText("Reasoning effort"));
  await screen.findByRole("option", { name: "High" });
  const reasoning = screen.getByRole("listbox", { name: "Reasoning effort options" });
  expect(within(reasoning).queryByRole("option", { name: "Off" })).not.toBeInTheDocument();
  expect(within(reasoning).queryByRole("option", { name: "Medium" })).not.toBeInTheDocument();
  fireEvent.click(within(reasoning).getByRole("option", { name: "High" }));
  expect(change).toHaveBeenCalledWith("high");
});
it("resets unsupported saved reasoning settings instead of displaying Auto but sending a stale effort", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listModels").mockResolvedValue([
    { id: "model", name: "Model", supportsReasoning: false },
  ]);
  const change = vi.fn();
  render(
    <ModelPicker
      client={client}
      model="model"
      models={[]}
      reasoning="high"
      onReasoningChange={change}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Reasoning effort")).toHaveAttribute("aria-disabled", "true"),
  );
  expect(change).toHaveBeenCalledWith("auto");
});

it("stars models without selecting them, pins favourites first and restores them on reopening", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listModels").mockResolvedValue([
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ]);
  const change = vi.fn();
  const props = { client, model: "a", models: [], onChange: change };
  const first = render(<ModelPicker {...props} />);
  const open = () => {
    const menu = screen.getByLabelText("Conversation model").closest("details")!;
    menu.open = true;
    fireEvent(menu, new Event("toggle"));
  };
  open();
  const beta = await screen.findByRole("button", { name: "Star Beta" });
  fireEvent.click(beta);
  expect(change).not.toHaveBeenCalled();
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Beta");
  expect(localStorage.getItem("vektor.favoriteModels")).toBe('["b"]');
  first.unmount();
  render(<ModelPicker {...props} />);
  open();
  await screen.findByRole("button", { name: "Unstar Beta" });
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Beta");
  fireEvent.click(screen.getByRole("button", { name: "Unstar Beta" }));
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Alpha");
});
