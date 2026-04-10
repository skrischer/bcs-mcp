import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api.js", () => ({
  getDaySummary: vi.fn(),
  getWeekSummary: vi.fn(),
  getTasksForProject: vi.fn(),
  bookEffort: vi.fn(),
  deleteEffort: vi.fn(),
  setAttendance: vi.fn(),
}));

import {
  getDaySummary,
  getWeekSummary,
  getTasksForProject,
  bookEffort,
  deleteEffort,
  setAttendance,
} from "../api.js";
import type {
  DaySummary,
  WeekSummary,
  TaskDetail,
  ProjectAggregate,
} from "../api.js";

const mockGetDaySummary = vi.mocked(getDaySummary);
const mockGetWeekSummary = vi.mocked(getWeekSummary);
const mockGetTasksForProject = vi.mocked(getTasksForProject);
const mockBookEffort = vi.mocked(bookEffort);
const mockDeleteEffort = vi.mocked(deleteEffort);
const mockSetAttendance = vi.mocked(setAttendance);

import { registerTools } from "../tools.js";

interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createMockServer(): {
  tools: ToolRegistration[];
  tool: (...args: unknown[]) => void;
} {
  const tools: ToolRegistration[] = [];
  return {
    tools,
    tool(
      name: unknown,
      description: unknown,
      schema: unknown,
      handler: unknown,
    ) {
      tools.push({
        name: name as string,
        description: description as string,
        schema: schema as Record<string, unknown>,
        handler: handler as ToolRegistration["handler"],
      });
    },
  };
}

function getToolHandler(
  tools: ToolRegistration[],
  name: string,
): ToolRegistration["handler"] {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.handler;
}

describe("tools", () => {
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    registerTools(mockServer as unknown as Parameters<typeof registerTools>[0]);
  });

  it("registers all 6 tools", () => {
    expect(mockServer.tools).toHaveLength(6);
    const names = mockServer.tools.map((t) => t.name);
    expect(names).toContain("bcs_get_week_summary");
    expect(names).toContain("bcs_get_day_summary");
    expect(names).toContain("bcs_get_tasks");
    expect(names).toContain("bcs_book_effort");
    expect(names).toContain("bcs_delete_effort");
    expect(names).toContain("bcs_set_attendance");
  });

  describe("bcs_get_week_summary", () => {
    it("returns formatted week overview", async () => {
      const makeDaySummary = (
        bookedH: number,
        bookedM: number,
        unbookedH: number,
        unbookedM: number,
      ): DaySummary => ({
        attendance: [],
        projects: [
          {
            projectOid: "PROJ1",
            name: "Akquise",
            hours: bookedH,
            minutes: bookedM,
          },
        ],
        bookedHours: bookedH,
        bookedMinutes: bookedM,
        unbookedHours: unbookedH,
        unbookedMinutes: unbookedM,
      });

      const week: WeekSummary = {
        days: [
          { date: "2026-04-06", summary: makeDaySummary(8, 0, 0, 0) },
          { date: "2026-04-07", summary: makeDaySummary(7, 30, 0, 30) },
          { date: "2026-04-08", summary: makeDaySummary(8, 0, 0, 0) },
          { date: "2026-04-09", summary: makeDaySummary(6, 0, 2, 0) },
          { date: "2026-04-10", summary: makeDaySummary(0, 0, 8, 0) },
        ],
        totalBookedHours: 29,
        totalBookedMinutes: 30,
        totalUnbookedHours: 10,
        totalUnbookedMinutes: 30,
      };
      mockGetWeekSummary.mockResolvedValue(week);

      const handler = getToolHandler(mockServer.tools, "bcs_get_week_summary");
      const result = await handler({ date: "2026-04-10" });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("Mo 2026-04-06: 8h 0m");
      expect(text).toContain("Fr 2026-04-10: 0h 0m");
      expect(text).toContain("unbooked: 2h 0m");
      expect(text).toContain("Week total booked: 29h 30m");
      expect(text).toContain("Week total unbooked: 10h 30m");
    });
  });

  describe("bcs_get_day_summary", () => {
    it("returns formatted summary with attendance and projects", async () => {
      const summary: DaySummary = {
        attendance: [
          {
            oid: "ATT1",
            startHour: 8,
            startMinute: 0,
            endHour: 17,
            endMinute: 0,
            durationHour: 9,
            durationMinute: 0,
            recordType: "unsavedAttendance",
          },
        ],
        projects: [
          { projectOid: "PROJ1", name: "Akquise", hours: 4, minutes: 30 },
          {
            projectOid: "PROJ2",
            name: "Internes Projekt",
            hours: 2,
            minutes: 0,
          },
        ],
        bookedHours: 6,
        bookedMinutes: 30,
        unbookedHours: 1,
        unbookedMinutes: 30,
      };
      mockGetDaySummary.mockResolvedValue(summary);

      const handler = getToolHandler(mockServer.tools, "bcs_get_day_summary");
      const result = await handler({ date: "2026-04-10" });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("8:00 - 17:00");
      expect(text).toContain("Akquise (PROJ1): 4h 30m");
      expect(text).toContain("Booked: 6h 30m");
      expect(text).toContain("Unbooked: 1h 30m");
    });
  });

  describe("bcs_get_tasks", () => {
    it("returns formatted task list", async () => {
      const tasks: TaskDetail[] = [
        {
          lineOid: "TASK1",
          name: "Neukundenakquise",
          recordOid: "REC1",
          hours: 2,
          minutes: 0,
          description: "JIRA-42",
          recordType: "effort",
        },
      ];
      mockGetTasksForProject.mockResolvedValue(tasks);

      const handler = getToolHandler(mockServer.tools, "bcs_get_tasks");
      const result = await handler({
        date: "2026-04-10",
        projectOid: "PROJ1",
      });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("Neukundenakquise [TASK1]");
      expect(text).toContain("2h 0m");
      expect(text).toContain("JIRA-42");
    });
  });

  describe("bcs_book_effort", () => {
    it("books effort and returns confirmation", async () => {
      const projects: ProjectAggregate[] = [
        { projectOid: "PROJ1", name: "Akquise", hours: 5, minutes: 0 },
      ];
      mockBookEffort.mockResolvedValue({ success: true, projects });

      const handler = getToolHandler(mockServer.tools, "bcs_book_effort");
      const result = await handler({
        date: "2026-04-10",
        projectOid: "PROJ1",
        taskLineOid: "TASK1",
        hours: 3,
        minutes: 0,
        description: "Development",
      });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("Booking confirmed");
      expect(text).toContain("3h 0m");
      expect(text).toContain("Akquise (PROJ1): 5h 0m");
    });
  });

  describe("bcs_delete_effort", () => {
    it("deletes effort and returns confirmation", async () => {
      const projects: ProjectAggregate[] = [
        { projectOid: "PROJ1", name: "Akquise", hours: 0, minutes: 0 },
      ];
      mockDeleteEffort.mockResolvedValue({ success: true, projects });

      const handler = getToolHandler(mockServer.tools, "bcs_delete_effort");
      const result = await handler({
        date: "2026-04-10",
        projectOid: "PROJ1",
        taskLineOid: "TASK1",
      });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("Effort deleted");
      expect(text).toContain("Akquise (PROJ1): 0h 0m");
    });
  });

  describe("bcs_set_attendance", () => {
    it("sets attendance and returns confirmation", async () => {
      mockSetAttendance.mockResolvedValue({ success: true });

      const handler = getToolHandler(mockServer.tools, "bcs_set_attendance");
      const result = await handler({
        date: "2026-04-10",
        startHour: 8,
        startMinute: 0,
        endHour: 17,
        endMinute: 0,
      });
      const text = result.content[0]?.text ?? "";

      expect(text).toContain("Attendance set: 8:00 - 17:00");
    });

    it("reports failure", async () => {
      mockSetAttendance.mockResolvedValue({ success: false });

      const handler = getToolHandler(mockServer.tools, "bcs_set_attendance");
      const result = await handler({
        date: "2026-04-10",
        startHour: 8,
        startMinute: 0,
        endHour: 17,
        endMinute: 0,
      });

      expect(result.content[0]?.text).toContain("Failed");
    });
  });
});
