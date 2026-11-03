import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChoicePicker } from "./ChoicePicker";

afterEach(cleanup);
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
