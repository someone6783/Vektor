export function mcpToolLabel(name: string, input: unknown): string {
  if (
    name.startsWith("vektor_mcp_") &&
    input &&
    typeof input === "object" &&
    "serverName" in input &&
    "toolName" in input &&
    typeof input.serverName === "string" &&
    typeof input.toolName === "string"
  )
    return `MCP · ${input.serverName} / ${input.toolName}`;
  return name;
}
