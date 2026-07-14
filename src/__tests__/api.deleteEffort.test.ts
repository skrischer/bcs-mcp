import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth layer so deleteEffort() runs against controlled HTTP responses.
const authenticatedFetch = vi.fn();
vi.mock("../auth.js", () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  getConfig: () => ({
    BCS_URL: "https://bcs.example.test",
    BCS_USER_OID: "USER1_JUser",
  }),
}));

const PSP = "daytimerecording,Content,daytimerecordingPspTree,Columns";
const PROJ = "PROJ1_JProject";
const TASK = "TASK1_JTask";
const EFFORT = "EFF1_JEffort";

// Minimal day page: one project row.
const DAY_HTML = `<form>
  <input type="hidden" name="pagetimestamp" value="1">
  <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="30">
</form>`;

// AJAX tree-expand: task carries booked effort, so BCS surfaces the _JEffort row
// (not the _JTask OID). The effort row's effortTargetOid points back at the task.
const EXPAND_JSON = JSON.stringify({
  html:
    `<input type="hidden" name="${PSP},recordType,listeditoid_${EFFORT}.recordType" value="effort">` +
    `<input type="hidden" name="${PSP},recordOid,listeditoid_${EFFORT}.recordOid" value="${EFFORT}">` +
    `<input type="hidden" name="${PSP},effortTargetOid,listeditoid_${EFFORT}.effortTargetOid" value="${TASK}">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour" value="0">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute" value="30">` +
    `<input type="text" name="${PSP},description,listeditoid_${EFFORT}.description" value="work">`,
});

// Save response after clearing: aggregate back to 0.
const CLEARED_RESPONSE = `<form>
  <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="00">
</form>`;

function mockFlow(): void {
  authenticatedFetch.mockReset();
  authenticatedFetch
    .mockResolvedValueOnce(new Response(DAY_HTML, { status: 200 }))
    .mockResolvedValueOnce(new Response(EXPAND_JSON, { status: 201 }))
    .mockResolvedValueOnce(new Response(CLEARED_RESPONSE, { status: 200 }));
}

function postedBody(): URLSearchParams {
  const postCall = authenticatedFetch.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "POST",
  );
  if (!postCall) throw new Error("no POST call captured");
  return new URLSearchParams((postCall[1] as RequestInit).body as string);
}

describe("deleteEffort", () => {
  beforeEach(() => authenticatedFetch.mockReset());

  it("resolves the _JTask OID to the effort row and clears its fields", async () => {
    mockFlow();
    const { deleteEffort } = await import("../api.js");
    const result = await deleteEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: TASK, // the task OID, not present as a row in the expand
    });

    expect(result.success).toBe(true);
    const body = postedBody();
    // Effort fields of the _JEffort row are emptied.
    expect(body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`)).toBe("");
    expect(body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute`)).toBe("");
    expect(body.get(`${PSP},description,listeditoid_${EFFORT}.description`)).toBe("");
  });

  it("still works when given the _JEffort OID directly", async () => {
    mockFlow();
    const { deleteEffort } = await import("../api.js");
    const result = await deleteEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: EFFORT,
    });

    expect(result.success).toBe(true);
    expect(postedBody().get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`)).toBe("");
  });

  it("throws when the OID matches neither a row nor an effortTargetOid", async () => {
    mockFlow();
    const { deleteEffort } = await import("../api.js");
    await expect(
      deleteEffort({
        date: "2026-07-08",
        projectOid: PROJ,
        taskLineOid: "UNKNOWN_JTask",
      }),
    ).rejects.toThrow(/not found/);
  });
});
