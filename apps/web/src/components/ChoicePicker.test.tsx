import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChoicePicker } from "./ChoicePicker";

afterEach(cleanup);
it("positions the popup synchronously when opening without waiting for a native toggle", () => {
  const { container } = render(
    <ChoicePicker
      label="Display"
      value="headless"
      options={[{ value: "headless", label: "Background" }]}
      onChange={vi.fn()}
    />,
  );
  const trigger = screen.getByLabelText("Display");
  const bounds = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 136,
    left: 20,
    right: 420,
    width: 400,
    height: 36,
    x: 20,
    y: 100,
    toJSON: () => ({}),
  });
  fireEvent.click(trigger);
  const panel = container.querySelector<HTMLElement>(".choice-menu")!;
  expect(panel).toHaveStyle({ position: "fixed", top: "144px", minWidth: "400px" });
  expect(panel.hidden).toBe(false);
  fireEvent.click(trigger);
  expect(panel.hidden).toBe(true);
  bounds.mockRestore();
});
it("supports keyboard navigation, selection and returning focus to the trigger", () => {
  const change = vi.fn();
  render(
    <ChoicePicker
      label="Choice"
      value="a"
      options={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
      onChange={change}
    />,
  );
  const trigger = screen.getByLabelText("Choice");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const alpha = screen.getByRole("option", { name: "Alpha" });
  expect(alpha).toHaveFocus();
  expect(alpha).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(alpha, { key: "End" });
  const beta = screen.getByRole("option", { name: "Beta" });
  expect(beta).toHaveFocus();
  fireEvent.click(beta);
  expect(change).toHaveBeenCalledWith("b");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("option", { name: "Alpha" }), { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
it("dismisses outside the menu and never opens a disabled picker", () => {
  const { rerender } = render(
    <ChoicePicker
      label="Choice"
      value="a"
      options={[{ value: "a", label: "Alpha" }]}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByLabelText("Choice"));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  rerender(
    <ChoicePicker
      label="Choice"
      value="a"
      options={[{ value: "a", label: "Alpha" }]}
      onChange={vi.fn()}
      disabled
    />,
  );
  fireEvent.click(screen.getByLabelText("Choice"));
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});

it("skips disabled options during keyboard navigation and prevents selecting them", () => {
  const change = vi.fn();
  render(
    <ChoicePicker
      label="Access"
      value="off"
      options={[
        { value: "off", label: "Off", disabled: true },
        { value: "approved", label: "Approved commands" },
        { value: "unrestricted", label: "Unrestricted", disabled: true },
        { value: "other", label: "Other allowed" },
      ]}
      onChange={change}
    />,
  );
  const trigger = screen.getByLabelText("Access");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Approved commands" })).toHaveFocus();
  fireEvent.click(screen.getByRole("option", { name: "Unrestricted" }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Other allowed" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(screen.getByRole("option", { name: "Approved commands" })).toHaveFocus();
  fireEvent.click(screen.getByRole("option", { name: "Approved commands" }));
  expect(change).toHaveBeenCalledWith("approved");
  expect(trigger).toHaveFocus();
});

it("dismisses immediately when an outside control stops pointer propagation", () => {
  render(
    <>
      <ChoicePicker
        label="Choice"
        value="a"
        options={[{ value: "a", label: "Alpha" }]}
        onChange={vi.fn()}
      />
      <button onPointerDown={(event) => event.stopPropagation()}>Next control</button>
    </>,
  );
  const trigger = screen.getByLabelText("Choice");
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Next control" }));
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  expect(trigger.closest(".choice-picker")).toHaveAttribute("data-open", "false");
});

it("keeps only the latest picker open when immediately clicking the control beneath it", () => {
  const change = vi.fn();
  render(
    <>
      {["First", "Second"].map((label) => (
        <ChoicePicker
          key={label}
          label={label}
          value="a"
          options={[{ value: "a", label: "Alpha" }]}
          onChange={change}
        />
      ))}
    </>,
  );
  const first = screen.getByLabelText("First");
  const second = screen.getByLabelText("Second");
  fireEvent.click(first);
  fireEvent.pointerDown(second);
  fireEvent.click(second);
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(second).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
  expect(change).toHaveBeenCalledOnce();
  expect(second).toHaveAttribute("aria-expanded", "false");
});

it("dismisses when focus leaves, but keeps the menu open while navigating options", () => {
  render(
    <>
      <ChoicePicker
        label="Choice"
        value="a"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onChange={vi.fn()}
      />
      <button>Next control</button>
    </>,
  );
  const trigger = screen.getByLabelText("Choice");
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("option", { name: "Alpha" }), { key: "ArrowDown" });
  const beta = screen.getByRole("option", { name: "Beta" });
  expect(beta).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  fireEvent.blur(beta, { relatedTarget: screen.getByRole("button", { name: "Next control" }) });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("dismisses when the window loses focus", () => {
  render(
    <ChoicePicker
      label="Choice"
      value="a"
      options={[{ value: "a", label: "Alpha" }]}
      onChange={vi.fn()}
    />,
  );
  const trigger = screen.getByLabelText("Choice");
  fireEvent.click(trigger);
  fireEvent(window, new Event("blur"));
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("does not reopen a previously open menu when re-enabled", () => {
  const props = {
    label: "Choice",
    value: "a",
    options: [{ value: "a", label: "Alpha" }],
    onChange: vi.fn(),
  };
  const { rerender } = render(<ChoicePicker {...props} />);
  fireEvent.click(screen.getByLabelText("Choice"));
  rerender(<ChoicePicker {...props} disabled />);
  rerender(<ChoicePicker {...props} />);
  expect(screen.getByLabelText("Choice")).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
});
