import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api.js", () => ({
  getDaySummary: vi.fn(),
  getWeekSummary: vi.fn(),
  getTasksForProject: vi.fn(),
  bookEffort: vi.fn(),
  deleteEffort: vi.fn(),
  setAttendance: vi.fn(),
  getOvertimeBalance: vi.fn(),
  getVacationStatus: vi.fn(),
}));

import {
  getDaySummary,
  getWeekSummary,
  getTasksForProject,
  bookEffort,
  deleteEffort,
  setAttendance,
  getOvertimeBalance,
  getVacationStatus,
} from "../api.js";
import type {
  DaySummary,
  WeekSummary,
  TaskDetail,
  ProjectAggregate,
  OvertimeBalance,
  VacationStatus,
} from "../api.js";

const mockGetDaySummary = vi.mocked(getDaySummary);
const mockGetWeekSummary = vi.mocked(getWeekSummary);
const mockGetTasksForProject = vi.mocked(getTasksForProject);
const mockBookEffort = vi.mocked(bookEffort);
const mockDeleteEffort = vi.mocked(deleteEffort);
const mockSetAttendance = vi.mocked(setAttendance);
const mockGetOvertimeBalance = vi.mocked(getOvertimeBalance);
const mockGetVacationStatus = vi.mocked(getVacationStatus);

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

  it("registers all 8 tools", () => {
    expect(mockServer.tools).toHaveLength(8);
    const names = mockServer.tools.map((t) => t.name);
    expect(names).toContain("bcs_get_week_summary");
    expect(names).toContain("bcs_get_day_summary");
    expect(names).toContain("bcs_get_tasks");
    expect(names).toContain("bcs_book_effort");
    expect(names).toContain("bcs_delete_effort");
    expect(names).toContain("bcs_set_attendance");
    expect(names).toContain("bcs_get_overtime_balance");
    expect(names).toContain("bcs_get_vacation_status");
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
      const data = JSON.parse(result.content[0]?.text ?? "{}") as WeekSummary;

      expect(data.days).toHaveLength(5);
      expect(data.days[0]).toEqual({
        date: "2026-04-06",
        summary: expect.objectContaining({ bookedHours: 8, bookedMinutes: 0 }),
      });
      expect(data.days[4]).toEqual({
        date: "2026-04-10",
        summary: expect.objectContaining({ bookedHours: 0, unbookedHours: 8 }),
      });
      expect(data.totalBookedHours).toBe(29);
      expect(data.totalBookedMinutes).toBe(30);
      expect(data.totalUnbookedHours).toBe(10);
      expect(data.totalUnbookedMinutes).toBe(30);
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
      const data = JSON.parse(result.content[0]?.text ?? "{}") as DaySummary;

      expect(data.attendance[0]).toMatchObject({
        startHour: 8,
        startMinute: 0,
        endHour: 17,
        endMinute: 0,
      });
      expect(data.projects).toEqual([
        { projectOid: "PROJ1", name: "Akquise", hours: 4, minutes: 30 },
        { projectOid: "PROJ2", name: "Internes Projekt", hours: 2, minutes: 0 },
      ]);
      expect(data.bookedHours).toBe(6);
      expect(data.bookedMinutes).toBe(30);
      expect(data.unbookedHours).toBe(1);
      expect(data.unbookedMinutes).toBe(30);
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
      const data = JSON.parse(result.content[0]?.text ?? "[]") as TaskDetail[];

      expect(data).toHaveLength(1);
      expect(data[0]).toEqual({
        lineOid: "TASK1",
        name: "Neukundenakquise",
        recordOid: "REC1",
        hours: 2,
        minutes: 0,
        description: "JIRA-42",
        recordType: "effort",
      });
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
      const data = JSON.parse(result.content[0]?.text ?? "{}") as {
        success: boolean;
        projects: ProjectAggregate[];
      };

      expect(data.success).toBe(true);
      expect(data.projects).toEqual([
        { projectOid: "PROJ1", name: "Akquise", hours: 5, minutes: 0 },
      ]);
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
      const data = JSON.parse(result.content[0]?.text ?? "{}") as {
        success: boolean;
        projects: ProjectAggregate[];
      };

      expect(data.success).toBe(true);
      expect(data.projects).toEqual([
        { projectOid: "PROJ1", name: "Akquise", hours: 0, minutes: 0 },
      ]);
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
      const data = JSON.parse(result.content[0]?.text ?? "{}") as {
        success: boolean;
      };

      expect(data.success).toBe(true);
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
      const data = JSON.parse(result.content[0]?.text ?? "{}") as {
        success: boolean;
      };

      expect(data.success).toBe(false);
    });
  });
});
