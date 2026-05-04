import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getDaySummary,
  getWeekSummary,
  getTasksForProject,
  bookEffort,
  deleteEffort,
  setAttendance,
  getOvertimeBalance,
  getVacationStatus,
} from "./api.js";
import { log } from "./logger.js";

function jsonResponse(data: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function registerTools(server: McpServer): void {
  server.tool(
    "bcs_get_week_summary",
    "Get overview for an entire work week (Mon-Fri): per-day attendance, projects, booked/unbooked, plus weekly totals. Pass any date in the target week.",
    {
      date: z
        .string()
        .describe(
          "Any date in the target week (YYYY-MM-DD). Monday is derived automatically.",
        ),
    },
    async ({ date }) => {
      log("tool:call", "bcs_get_week_summary", { date });
      const week = await getWeekSummary(date);
      log("tool:result", "bcs_get_week_summary", week);
      return jsonResponse(week);
    },
  );

  server.tool(
    "bcs_get_day_summary",
    "Get day overview: attendance times, projects with booked hours, and unbooked remainder. Use this first to see the current state.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      log("tool:call", "bcs_get_day_summary", { date });
      const summary = await getDaySummary(date);
      log("tool:result", "bcs_get_day_summary", summary);
      return jsonResponse(summary);
    },
  );

  server.tool(
    "bcs_get_tasks",
    "List bookable tasks for a project. Use bcs_get_day_summary first to get project OIDs, then expand a project to see its tasks.",
    {
      date: z.string().describe("Date in YYYY-MM-DD format"),
      projectOid: z.string().describe("Project OID from bcs_get_day_summary"),
    },
    async ({ date, projectOid }) => {
      log("tool:call", "bcs_get_tasks", { date, projectOid });
      const tasks = await getTasksForProject(date, projectOid);
      log("tool:result", "bcs_get_tasks", tasks);
      return jsonResponse(tasks);
    },
  );

  server.tool(
    "bcs_book_effort",
    "Book time to a task. Use bcs_get_day_summary for projectOid, then bcs_get_tasks for taskLineOid.",
    {
      date: z.string().describe("Date in YYYY-MM-DD format"),
      projectOid: z.string().describe("Project OID from bcs_get_day_summary"),
      taskLineOid: z.string().describe("Task lineOid from bcs_get_tasks"),
      hours: z.number().int().min(0).describe("Hours to book"),
      minutes: z
        .number()
        .int()
        .min(0)
        .max(59)
        .default(0)
        .describe("Minutes to book (0-59)"),
      description: z.string().describe("Description of work done"),
    },
    async ({ date, projectOid, taskLineOid, hours, minutes, description }) => {
      log("tool:call", "bcs_book_effort", {
        date,
        projectOid,
        taskLineOid,
        hours,
        minutes,
        description,
      });
      try {
        const result = await bookEffort({
          date,
          projectOid,
          taskLineOid,
          hours,
          minutes,
          description,
        });
        log("tool:result", "bcs_book_effort", result);
        return jsonResponse(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("tool:error", "bcs_book_effort", msg);
        throw err;
      }
    },
  );

  server.tool(
    "bcs_delete_effort",
    "Delete a booked effort entry. Use bcs_get_tasks to find the taskLineOid of the entry to delete.",
    {
      date: z.string().describe("Date in YYYY-MM-DD format"),
      projectOid: z.string().describe("Project OID from bcs_get_day_summary"),
      taskLineOid: z.string().describe("Task lineOid of the effort to delete"),
    },
    async ({ date, projectOid, taskLineOid }) => {
      log("tool:call", "bcs_delete_effort", { date, projectOid, taskLineOid });
      try {
        const result = await deleteEffort({ date, projectOid, taskLineOid });
        log("tool:result", "bcs_delete_effort", result);
        return jsonResponse(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("tool:error", "bcs_delete_effort", msg);
        throw err;
      }
    },
  );

  server.tool(
    "bcs_set_attendance",
    "Set attendance for a day (start time, end time, optional pause duration).",
    {
      date: z.string().describe("Date in YYYY-MM-DD format"),
      startHour: z.number().int().min(0).max(23).describe("Start hour"),
      startMinute: z
        .number()
        .int()
        .min(0)
        .max(59)
        .default(0)
        .describe("Start minute"),
      endHour: z.number().int().min(0).max(23).describe("End hour"),
      endMinute: z
        .number()
        .int()
        .min(0)
        .max(59)
        .default(0)
        .describe("End minute"),
      pauseHour: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pause duration hours"),
      pauseMinute: z
        .number()
        .int()
        .min(0)
        .max(59)
        .optional()
        .describe("Pause duration minutes"),
    },
    async ({
      date,
      startHour,
      startMinute,
      endHour,
      endMinute,
      pauseHour,
      pauseMinute,
    }) => {
      log("tool:call", "bcs_set_attendance", {
        date,
        startHour,
        startMinute,
        endHour,
        endMinute,
        pauseHour,
        pauseMinute,
      });
      try {
        const result = await setAttendance({
          date,
          startHour,
          startMinute,
          endHour,
          endMinute,
          pauseHour,
          pauseMinute,
        });
        log("tool:result", "bcs_set_attendance", result);
        return jsonResponse(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("tool:error", "bcs_set_attendance", msg);
        throw err;
      }
    },
  );

  server.tool(
    "bcs_get_overtime_balance",
    "Get current working time account balance (Arbeitszeitkonto): flexi-time balance, target vs actual hours, and saldo. All values in minutes.",
    {},
    async () => {
      log("tool:call", "bcs_get_overtime_balance", {});
      const balance = await getOvertimeBalance();
      log("tool:result", "bcs_get_overtime_balance", balance);
      return jsonResponse(balance);
    },
  );

  server.tool(
    "bcs_get_vacation_status",
    "Get vacation budget for the current year: total days, base/extra/carryover, used, planned, requested, approved, and available days remaining.",
    {},
    async () => {
      log("tool:call", "bcs_get_vacation_status", {});
      const status = await getVacationStatus();
      log("tool:result", "bcs_get_vacation_status", status);
      return jsonResponse(status);
    },
  );
}
