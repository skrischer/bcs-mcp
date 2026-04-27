import { createWriteStream, type WriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = resolve(__dirname, "..", "bcs-mcp.log");

let logStream: WriteStream | null = null;
let stdioMode = false;

export function setStdioMode(): void {
  stdioMode = true;
}

export function initLogFile(): void {
  logStream = createWriteStream(LOG_FILE, { flags: "w" });
}

export function closeLogFile(): void {
  logStream?.end();
  logStream = null;
}

export function log(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  if (!stdioMode) {
    console.error(`[${ts}] [${tag}]`, ...args);
  }

  if (logStream) {
    const fullTs = new Date().toISOString();
    const parts = args.map((a) =>
      typeof a === "object" && a !== null ? JSON.stringify(a) : String(a),
    );
    logStream.write(`[${fullTs}] [${tag}] ${parts.join(" ")}\n`);
  }
}
