import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api.js", () => ({
  getBookings: vi.fn(),
  getBookingTasks: vi.fn(),
  bookEffort: vi.fn(),
  getDaySummary: vi.fn(),
}));

import {
  getBookings,
  getBookingTasks,
  bookEffort,
  getDaySummary,
} from "../api.js";
import type { BookingEntry, BookingTask, DaySummary } from "../api.js";

const mockGetBookings = vi.mocked(getBookings);
const mockGetBookingTasks = vi.mocked(getBookingTasks);
const mockBookEffort = vi.mocked(bookEffort);
const mockGetDaySummary = vi.mocked(getDaySummary);

// We test the tool handlers by importing registerTools and calling with a mock server
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

  it("registers all 4 tools", () => {
    expect(mockServer.tools).toHaveLength(4);
    const names = mockServer.tools.map((t) => t.name);
    expect(names).toContain("bcs_get_bookings");
    expect(names).toContain("bcs_get_booking_tasks");
    expect(names).toContain("bcs_book_effort");
    expect(names).toContain("bcs_get_day_summary");
  });

  describe("bcs_get_bookings", () => {
    it("returns formatted booking list", async () => {
      const entries: BookingEntry[] = [
        {
          oid: "B1",
          taskOid: "T1",
          taskName: "Project A",
          effortExpense_hour: 2,
          effortExpense_minute: 0,
          description: "Coding",
        },
      ];
      mockGetBookings.mockResolvedValue(entries);

      const handler = getToolHandler(mockServer.tools, "bcs_get_bookings");
      const result = await handler({ date: "2024-01-15" });

      expect(result.content[0]?.text).toContain("Project A");
      expect(result.content[0]?.text).toContain("2h 0m");
    });

    it("handles empty bookings", async () => {
      mockGetBookings.mockResolvedValue([]);

      const handler = getToolHandler(mockServer.tools, "bcs_get_bookings");
      const result = await handler({ date: "2024-01-15" });

      expect(result.content[0]?.text).toContain("No bookings found");
    });
  });

  describe("bcs_get_booking_tasks", () => {
    it("returns formatted task list", async () => {
      const tasks: BookingTask[] = [
        { oid: "T1", name: "Task One" },
        { oid: "T2", name: "Task Two" },
      ];
      mockGetBookingTasks.mockResolvedValue(tasks);

      const handler = getToolHandler(mockServer.tools, "bcs_get_booking_tasks");
      const result = await handler({});

      expect(result.content[0]?.text).toContain("Task One");
      expect(result.content[0]?.text).toContain("OID: T1");
    });
  });

  describe("bcs_book_effort", () => {
    it("books effort and returns confirmation", async () => {
      mockBookEffort.mockResolvedValue({ booked: true });

      const handler = getToolHandler(mockServer.tools, "bcs_book_effort");
      const result = await handler({
        date: "2024-01-15",
        taskOid: "T1",
        hours: 3,
        minutes: 0,
        description: "Development",
      });

      expect(result.content[0]?.text).toContain("Booked 3h 0m");
      expect(mockBookEffort).toHaveBeenCalledWith({
        date: "2024-01-15",
        taskOid: "T1",
        hours: 3,
        minutes: 0,
        description: "Development",
      });
    });
  });

  describe("bcs_get_day_summary", () => {
    it("returns formatted summary", async () => {
      const summary: DaySummary = {
        totalHours: 6,
        totalMinutes: 30,
        entries: [],
        unbooked: { hours: 1, minutes: 30 },
      };
      mockGetDaySummary.mockResolvedValue(summary);

      const handler = getToolHandler(mockServer.tools, "bcs_get_day_summary");
      const result = await handler({ date: "2024-01-15" });

      expect(result.content[0]?.text).toContain("6h 30m");
      expect(result.content[0]?.text).toContain("1h 30m");
    });
  });
});
