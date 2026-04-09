import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getBookings,
  getBookingTasks,
  bookEffort,
  getDaySummary,
} from "./api.js";
import type { BookingEntry, BookingTask, DaySummary } from "./api.js";

function formatBookings(entries: BookingEntry[]): string {
  if (entries.length === 0) return "No bookings found for this date.";
  return entries
    .map(
      (e, i) =>
        `${i + 1}. ${e.taskName} — ${e.effortExpense_hour}h ${e.effortExpense_minute}m: ${e.description}`,
    )
    .join("\n");
}

function formatTasks(tasks: BookingTask[]): string {
  if (tasks.length === 0) return "No bookable tasks found.";
  return tasks.map((t) => `- ${t.name} (OID: ${t.oid})`).join("\n");
}

function formatDaySummary(summary: DaySummary): string {
  const lines = [
    `Booked: ${summary.totalHours}h ${summary.totalMinutes}m`,
    `Unbooked: ${summary.unbooked.hours}h ${summary.unbooked.minutes}m (of 8h target)`,
    "",
    "Entries:",
    formatBookings(summary.entries),
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
    "Get available tasks that can be booked to. Returns task names and OIDs needed for booking. Optionally filter by date.",
    {
      date: z
        .string()
        .optional()
        .describe("Optional date in YYYY-MM-DD format to filter tasks"),
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
        .describe("OID of the task to book to (from bcs_get_booking_tasks)"),
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
      return {
        content: [
          {
            type: "text",
            text: `Booked ${hours}h ${minutes}m to task ${taskOid} on ${date}: ${description}\n\nResponse: ${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  server.tool(
    "bcs_get_day_summary",
    "Get a summary of the day including total booked time, remaining time, and all entries. Use this to check how much time is left to book.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const summary = await getDaySummary(date);
      return { content: [{ type: "text", text: formatDaySummary(summary) }] };
    },
  );
}
