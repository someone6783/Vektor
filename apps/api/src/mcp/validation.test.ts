import { describe, it, expect } from "vitest";
import { validateSchemas } from "./validation.js";
describe("bounded MCP JSON schema validation", () => {
  it("validates local references, required fields and additional properties", async () => {
    const schema = {
      type: "object",
      $defs: { text: { type: "string", minLength: 2 } },
      properties: { value: { $ref: "#/$defs/text" } },
      required: ["value"],
      additionalProperties: false,
    };
    await expect(validateSchemas([schema], { value: "ok" })).resolves.toBeUndefined();
    await expect(validateSchemas([schema], { value: 2 })).rejects.toThrow("schema");
    await expect(validateSchemas([schema], { value: "ok", extra: true })).rejects.toThrow("schema");
  });
  it("rejects external references without fetching them", async () => {
    await expect(
      validateSchemas([{ type: "object", $ref: "https://example.com/schema" }]),
    ).rejects.toThrow("schema");
  });
  it("bounds schema size and terminates pathological regex validation off the API thread", async () => {
    await expect(
      validateSchemas([{ type: "object", description: "X".repeat(40000) }]),
    ).rejects.toThrow("size limit");
    const started = Date.now();
    await expect(
      validateSchemas(
        [{ type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } }],
        { value: "a".repeat(100) + "!" },
      ),
    ).rejects.toThrow("deadline");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 6000);
});
