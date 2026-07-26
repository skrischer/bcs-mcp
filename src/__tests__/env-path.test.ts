import { describe, it, expect } from "vitest";
import { resolveEnvPath } from "../env-path.js";

describe("resolveEnvPath", () => {
  it("derives the project-root .env from the module location, not CWD", () => {
    // Runtime entry lives at <root>/dist/index.js -> ../.env is the root.
    const result = resolveEnvPath("file:///opt/bcs-mcp/dist/index.js");
    expect(result).toBe("/opt/bcs-mcp/.env");
  });

  it("resolves relative to the module dir regardless of process CWD", () => {
    const result = resolveEnvPath("file:///some/other/place/dist/index.js");
    expect(result).toBe("/some/other/place/.env");
    expect(result).not.toContain(process.cwd());
  });
});
