import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getDaySummary,
  getWeekSummary,
  getTasksForProject,
  bookEffort,
  deleteEffort,
  setAttendance,
} from "./api.js";
import type {
  DaySummary,
  WeekSummary,
  DaySummaryWithDate,
  ProjectAggregate,
  TaskDetail,
  AttendanceEntry,
} from "./api.js";

function formatAttendance(entries: AttendanceEntry[]): string {
  if (entries.length === 0) return "No attendance entries.";
  return entries
    .map((a) => {
      const start = `${a.startHour}:${String(a.startMinute).padStart(2, "0")}`;
      const end = `${a.endHour}:${String(a.endMinute).padStart(2, "0")}`;
      const dur = `${a.durationHour}:${String(a.durationMinute).padStart(2, "0")}`;
      const type = a.recordType === "unsavedPause" ? "Pause" : "Attendance";
      return `- ${start} - ${end} (${dur}h) [${type}]`;
    })
    .join("\n");
}

function formatProjects(projects: ProjectAggregate[]): string {
  if (projects.length === 0) return "No projects found.";
  return projects
    .map((p) => `- ${p.name} (${p.projectOid}): ${p.hours}h ${p.minutes}m`)
    .join("\n");
}

function formatDaySummary(summary: DaySummary): string {
  return [
    "Attendance:",
    formatAttendance(summary.attendance),
    "",
    "Projects:",
    formatProjects(summary.projects),
    "",
    `Booked: ${summary.bookedHours}h ${summary.bookedMinutes}m`,
    `Unbooked: ${summary.unbookedHours}h ${summary.unbookedMinutes}m`,
  ].join("\n");
}

const WEEKDAY_NAMES = ["Mo", "Di", "Mi", "Do", "Fr"];

function formatDayLine(entry: DaySummaryWithDate, index: number): string {
  const day = WEEKDAY_NAMES[index] ?? entry.date;
  const booked = `${entry.summary.bookedHours}h ${entry.summary.bookedMinutes}m`;
  const unbooked =
    entry.summary.unbookedHours + entry.summary.unbookedMinutes > 0
      ? ` (unbooked: ${entry.summary.unbookedHours}h ${entry.summary.unbookedMinutes}m)`
      : "";
  const projects = entry.summary.projects
    .filter((p) => p.hours > 0 || p.minutes > 0)
    .map((p) => `${p.name}: ${p.hours}h ${p.minutes}m`)
    .join(", ");
  return `${day} ${entry.date}: ${booked}${unbooked}${projects ? ` [${projects}]` : ""}`;
}

function formatWeekSummary(week: WeekSummary): string {
  const dayLines = week.days.map((d, i) => formatDayLine(d, i));
  return [
    ...dayLines,
    "",
    `Week total booked: ${week.totalBookedHours}h ${week.totalBookedMinutes}m`,
    `Week total unbooked: ${week.totalUnbookedHours}h ${week.totalUnbookedMinutes}m`,
  ].join("\n");
}

function formatTasks(tasks: TaskDetail[]): string {
  if (tasks.length === 0) return "No tasks found for this project.";
  return tasks
    .map(
      (t) =>
        `- ${t.name} [${t.lineOid}] (${t.recordType}): ${t.hours}h ${t.minutes}m${t.description ? ` — ${t.description}` : ""}`,
    )
    .join("\n");
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
      const week = await getWeekSummary(date);
      return { content: [{ type: "text", text: formatWeekSummary(week) }] };
    },
  );

  server.tool(
    "bcs_get_day_summary",
    "Get day overview: attendance times, projects with booked hours, and unbooked remainder. Use this first to see the current state.",
    { date: z.string().describe("Date in YYYY-MM-DD format") },
    async ({ date }) => {
      const summary = await getDaySummary(date);
      return { content: [{ type: "text", text: formatDaySummary(summary) }] };
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
      const tasks = await getTasksForProject(date, projectOid);
      return { content: [{ type: "text", text: formatTasks(tasks) }] };
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
      const result = await bookEffort({
        date,
        projectOid,
        taskLineOid,
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
            text: `${status}: ${hours}h ${minutes}m on ${date}\n\nProjects:\n${formatProjects(result.projects)}`,
          },
        ],
      };
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
      const result = await deleteEffort({ date, projectOid, taskLineOid });
      const status = result.success
        ? "Effort deleted"
        : "Delete submitted (verify manually)";
      return {
        content: [
          {
            type: "text",
            text: `${status}\n\nProjects:\n${formatProjects(result.projects)}`,
          },
        ],
      };
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
      const result = await setAttendance({
        date,
        startHour,
        startMinute,
        endHour,
        endMinute,
        pauseHour,
        pauseMinute,
      });
      const status = result.success
        ? `Attendance set: ${startHour}:${String(startMinute).padStart(2, "0")} - ${endHour}:${String(endMinute).padStart(2, "0")}`
        : "Failed to set attendance";
      return { content: [{ type: "text", text: status }] };
    },
  );
}
