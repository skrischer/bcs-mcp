import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Derive the project-root `.env` path from a module's `import.meta.url`.
 *
 * The runtime entry is `dist/index.js`, so `../.env` resolves to the project
 * root regardless of the working directory the MCP client launches from.
 */
export function resolveEnvPath(metaUrl: string): string {
  return resolve(dirname(fileURLToPath(metaUrl)), "../.env");
}
