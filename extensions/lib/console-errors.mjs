/**
 * Console error ring buffer for the pi-mail daemon.
 *
 * Clients (agents, web UI, mobile apps) push console errors/warnings here;
 * the AI assistant can query them via the `get_console_errors` tool, and the
 * web UI's Settings tab shows a live "Debug Console" panel.
 *
 * Ring buffer: last 100 entries, oldest evicted first.
 */

const MAX_ENTRIES = 100;

/** @type {Array<{ timestamp: number, level: "error"|"warn", message: string, stack?: string, source?: string }>} */
export const consoleErrors = [];

/**
 * Push an entry onto the ring buffer. Evicts the oldest if at capacity.
 * @param {{ level?: "error"|"warn", message: string, stack?: string, source?: string }} entry
 */
export function pushConsoleError(entry) {
  const rec = {
    timestamp: Date.now(),
    level: entry.level === "warn" ? "warn" : "error",
    message: entry.message ?? "",
    ...(entry.stack ? { stack: entry.stack } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  };
  consoleErrors.push(rec);
  while (consoleErrors.length > MAX_ENTRIES) consoleErrors.shift();
}

/**
 * Query the ring buffer.
 * @param {{ limit?: number, level?: "error"|"warn"|"all" }} [opts]
 * @returns {Array<{ timestamp: number, level: string, message: string, stack?: string, source?: string }>}
 */
export function getConsoleErrors(opts = {}) {
  const { limit, level } = opts;
  let filtered = [...consoleErrors];
  if (level && level !== "all") {
    filtered = filtered.filter((e) => e.level === level);
  }
  // Newest first
  filtered.reverse();
  if (typeof limit === "number" && limit > 0) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
}

/** Clear the ring buffer entirely. */
export function clearConsoleErrors() {
  consoleErrors.length = 0;
}
