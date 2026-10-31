import { describe, expect, it, vi } from "vitest";
import { createStreamRegistry } from "./stream-registry.js";

describe("stream registry", () => {
  it("closes every registered stream once", () => {
    const registry = createStreamRegistry();
    const first = vi.fn();
    const second = vi.fn();

    registry.register(first);
    registry.register(second);
    registry.closeAll();
    registry.closeAll();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops tracking a stream that closes on its own", () => {
    const registry = createStreamRegistry();
    const closed = vi.fn();
    const unregister = registry.register(closed);

    unregister();
    registry.closeAll();

    expect(closed).not.toHaveBeenCalled();
  });
});
