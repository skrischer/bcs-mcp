import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../auth.js", () => ({
  authenticatedFetch: vi.fn(),
  getConfig: vi.fn(() => ({
    BCS_URL: "https://bcs.example.com",
    BCS_USERNAME: "testuser",
    BCS_PASSWORD: "testpass",
    BCS_USER_OID: "OID123",
  })),
  refreshCsrfToken: vi.fn(),
}));

import {
  getBookings,
  getBookingTasks,
  bookEffort,
  getDaySummary,
  BcsApiError,
} from "../api.js";
import { authenticatedFetch } from "../auth.js";

const mockAuthFetch = vi.mocked(authenticatedFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getBookings", () => {
    it("returns booking entries from response envelope", async () => {
      const entries = [
        {
          oid: "B1",
          taskOid: "T1",
          taskName: "Project A",
          effortExpense_hour: 2,
          effortExpense_minute: 30,
          description: "Development",
        },
      ];
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: true,
          type: "success",
          result: entries,
          messages: [],
          issues: null,
        }),
      );

      const result = await getBookings("2024-01-15");
      expect(result).toEqual(entries);
    });

    it("throws BcsApiError when ok is false", async () => {
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: false,
          type: "error",
          result: null,
          messages: [{ text: "Invalid date" }],
          issues: null,
        }),
      );

      await expect(getBookings("invalid")).rejects.toThrow(BcsApiError);
    });
  });

  describe("getBookingTasks", () => {
    it("returns tasks from response envelope", async () => {
      const tasks = [{ oid: "T1", name: "Task One" }];
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: true,
          type: "success",
          result: tasks,
          messages: [],
          issues: null,
        }),
      );

      const result = await getBookingTasks("2024-01-15");
      expect(result).toEqual(tasks);
    });

    it("works without date parameter", async () => {
      const tasks = [{ oid: "T2", name: "Task Two" }];
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: true,
          type: "success",
          result: tasks,
          messages: [],
          issues: null,
        }),
      );

      const result = await getBookingTasks();
      expect(result).toEqual(tasks);
      expect(mockAuthFetch).toHaveBeenCalledWith(
        expect.not.stringContaining("date="),
        expect.anything(),
      );
    });
  });

  describe("bookEffort", () => {
    it("sends booking request and returns result", async () => {
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: true,
          type: "success",
          result: { booked: true },
          messages: [],
          issues: null,
        }),
      );

      const result = await bookEffort({
        date: "2024-01-15",
        taskOid: "T1",
        hours: 2,
        minutes: 30,
        description: "Dev work",
      });
      expect(result).toEqual({ booked: true });
    });
  });

  describe("getDaySummary", () => {
    it("aggregates booking entries into summary", async () => {
      const entries = [
        {
          oid: "B1",
          taskOid: "T1",
          taskName: "Project A",
          effortExpense_hour: 3,
          effortExpense_minute: 30,
          description: "Morning",
        },
        {
          oid: "B2",
          taskOid: "T2",
          taskName: "Project B",
          effortExpense_hour: 2,
          effortExpense_minute: 15,
          description: "Afternoon",
        },
      ];
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: true,
          type: "success",
          result: entries,
          messages: [],
          issues: null,
        }),
      );

      const summary = await getDaySummary("2024-01-15");
      expect(summary.totalHours).toBe(5);
      expect(summary.totalMinutes).toBe(45);
      expect(summary.unbooked.hours).toBe(2);
      expect(summary.unbooked.minutes).toBe(15);
      expect(summary.entries).toHaveLength(2);
    });

    it("handles empty bookings", async () => {
      mockAuthFetch.mockResolvedValue(
        jsonResponse({
          ok: true,
          type: "success",
          result: [],
          messages: [],
          issues: null,
        }),
      );

      const summary = await getDaySummary("2024-01-15");
      expect(summary.totalHours).toBe(0);
      expect(summary.totalMinutes).toBe(0);
      expect(summary.unbooked.hours).toBe(8);
      expect(summary.unbooked.minutes).toBe(0);
    });
  });
});
