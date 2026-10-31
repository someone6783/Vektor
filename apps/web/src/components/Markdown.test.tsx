import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders GFM tables and highlighted code blocks", () => {
    const { container } = render(
      <Markdown>
        {"| Name | Value |\n| --- | --- |\n| alpha | 1 |\n\n```ts\nconst answer = 42;\n```"}
      </Markdown>,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(container.querySelector("pre code")?.textContent).toContain("const answer = 42;");
    expect(container.querySelector("pre code")?.className).toContain("hljs");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("strips unsafe link protocols", () => {
    render(<Markdown>{"[click me](javascript:alert(1))"}</Markdown>);

    const link = screen.getByText("click me").closest("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("renders assistant text with inline code and lists", () => {
    render(<Markdown>{"Use `pnpm test`.\n\n- one\n- two"}</Markdown>);

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
