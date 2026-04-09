import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getBookings,
  getBookingTasks,
  bookEffort,
  getDaySummary,
} from "./api.js";
import type { BookingEntry, TaskEntry, DaySummary } from "./api.js";

function formatBookings(entries: BookingEntry[]): string {
  if (entries.length === 0) return "No bookings found for this date.";
  return entries
    .map(
      (e, i) =>
        `${i + 1}. ${e.eventName || e.oid} — ${e.hours}h ${e.minutes}m: ${e.description || "(no description)"}${e.taskOid ? ` (task: ${e.taskOid})` : ""}`,
    )
    .join("\n");
}

function formatTasks(tasks: TaskEntry[]): string {
  if (tasks.length === 0) return "No bookable tasks found.";
  return tasks
    .map((t) => `- ${t.name} (OID: ${t.oid}, type: ${t.recordType})`)
    .join("\n");
}

function formatDaySummary(summary: DaySummary): string {
  const lines = [
    `Booked: ${summary.totalHours}h ${summary.totalMinutes}m`,
    `Unbooked: ${summary.unbooked.hours}h ${summary.unbooked.minutes}m (of 8h target)`,
    "",
    "Entries:",
    formatBookings(summary.entries),
    "",
    "Available tasks:",
    formatTasks(summary.tasks),
  ];
  return lines.join("\n");
}

export function registerTools(server: McpServer): void {
  server.tool(
    "bcs_get_bookings",
    "Get all time bookings for a specific date. Use this to see what has already been booked.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const entries = await getBookings(date);
      return { content: [{ type: "text", text: formatBookings(entries) }] };
    },
  );

  server.tool(
    "bcs_get_booking_tasks",
    "Get available tasks/projects that can be booked to. Returns task names and OIDs needed for booking. Optionally filter by date.",
    {
      date: z
        .string()
        .optional()
        .describe("Optional date in YYYY-MM-DD format"),
    },
    async ({ date }) => {
      const tasks = await getBookingTasks(date);
      return { content: [{ type: "text", text: formatTasks(tasks) }] };
    },
  );

  server.tool(
    "bcs_book_effort",
    "Book time effort to a specific task. Requires task OID (get it from bcs_get_booking_tasks first), date, duration, and description.",
    {
      date: z.string().describe("Date in YYYY-MM-DD format"),
      taskOid: z
        .string()
        .describe(
          "OID of the task/project to book to (from bcs_get_booking_tasks)",
        ),
      hours: z.number().int().min(0).describe("Hours to book"),
      minutes: z
        .number()
        .int()
        .min(0)
        .max(59)
        .default(0)
        .describe("Minutes to book (0-59)"),
      description: z.string().describe("Description of the work done"),
    },
    async ({ date, taskOid, hours, minutes, description }) => {
      const result = await bookEffort({
        date,
        taskOid,
        hours,
        minutes,
        description,
      });
      const status = result.success
        ? "Booking confirmed"
        : "Booking submitted (verify manually)";
      return {
        content: [
          {
            type: "text",
            text: `${status}: ${hours}h ${minutes}m on ${date}\n\nCurrent bookings:\n${formatBookings(result.entries)}`,
          },
        ],
      };
    },
  );

  server.tool(
    "bcs_get_day_summary",
    "Get a summary of the day including total booked time, remaining time, all entries, and available tasks. Use this to check how much time is left to book.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const summary = await getDaySummary(date);
      return { content: [{ type: "text", text: formatDaySummary(summary) }] };
    },
  );
}
