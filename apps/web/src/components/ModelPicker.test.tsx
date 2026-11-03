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

it("loads Codex models from its runner catalog and replaces an incompatible OpenRouter selection", async () => {
  const client = new ApiClient("test");
  const native = vi.spyOn(client, "listModels");
  vi.spyOn(client, "listRunnerModels").mockResolvedValue({
    models: [
      { id: "codex-default", name: "Codex Default" },
      { id: "codex-other", name: "Codex Other" },
    ],
    defaultModel: "codex-default",
  });
  const change = vi.fn();
  render(
    <ModelPicker
      client={client}
      runner="codex"
      model="openrouter/old-model"
      models={[]}
      onChange={change}
    />,
  );
  await waitFor(() => expect(change).toHaveBeenCalledWith("codex-default"));
  expect(native).not.toHaveBeenCalled();
  const menu = screen.getByLabelText("Conversation model").closest("details")!;
  menu.open = true;
  fireEvent(menu, new Event("toggle"));
  expect(screen.queryByRole("option", { name: /openrouter/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: /Codex Other/ }));
  expect(change).toHaveBeenLastCalledWith("codex-other");
});
it("keeps an already valid Codex model selected", async () => {
  const client = new ApiClient("test");
  vi.spyOn(client, "listRunnerModels").mockResolvedValue({
    models: [
      { id: "chosen", name: "Chosen" },
      { id: "default", name: "Default" },
    ],
    defaultModel: "default",
  });
  const change = vi.fn();
  render(
    <ModelPicker client={client} runner="codex" model="chosen" models={[]} onChange={change} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Conversation model")).toHaveTextContent("Chosen"),
  );
  expect(change).not.toHaveBeenCalled();
});
it("shows actionable runner catalog errors and lets the user retry", async () => {
  const client = new ApiClient("test");
  const catalog = vi
    .spyOn(client, "listRunnerModels")
    .mockRejectedValueOnce(new Error("Connect Codex first."))
    .mockResolvedValue({
      models: [{ id: "codex-model", name: "Codex Model" }],
      defaultModel: "codex-model",
    });
  render(<ModelPicker client={client} runner="codex" model="codex-model" models={[]} />);
  const menu = screen.getByLabelText("Conversation model").closest("details")!;
  menu.open = true;
  fireEvent(menu, new Event("toggle"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connect Codex first.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("option", { name: /Codex Model/ })).toBeInTheDocument();
});
