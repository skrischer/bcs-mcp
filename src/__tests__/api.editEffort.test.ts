import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth layer so editEffort() runs against controlled HTTP responses.
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

// Minimal day page: one project row, aggregate 0h30 (the existing effort).
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

// AJAX tree-expand: task has no booked effort yet -> recordType=neweffort.
const EXPAND_JSON_EMPTY = JSON.stringify({
  html:
    `<input type="hidden" name="${PSP},recordType,listeditoid_${TASK}.recordType" value="neweffort">` +
    `<input type="hidden" name="${PSP},effortTargetOid,listeditoid_${TASK}.effortTargetOid" value="${TASK}">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_hour" value="0">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_minute" value="00">` +
    `<input type="text" name="${PSP},description,listeditoid_${TASK}.description" value="">`,
});

function saveResponse(hour: string, minute: string): string {
  return `<form>
    <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
    <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="${hour}">
    <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="${minute}">
  </form>`;
}

function mockFlow(expandJson: string, saveHtml: string): void {
  authenticatedFetch.mockReset();
  authenticatedFetch
    .mockResolvedValueOnce(new Response(DAY_HTML, { status: 200 }))
    .mockResolvedValueOnce(new Response(expandJson, { status: 201 }))
    .mockResolvedValueOnce(new Response(saveHtml, { status: 200 }));
}

function postedBody(): URLSearchParams {
  const postCall = authenticatedFetch.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "POST",
  );
  if (!postCall) throw new Error("no POST call captured");
  return new URLSearchParams((postCall[1] as RequestInit).body as string);
}

describe("editEffort", () => {
  beforeEach(() => authenticatedFetch.mockReset());

  it("resolves the _JTask OID to the effort row and updates hours, minutes, and description", async () => {
    mockFlow(EXPAND_JSON, saveResponse("1", "15"));
    const { editEffort } = await import("../api.js");
    const result = await editEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: TASK,
      hours: 1,
      minutes: 15,
      description: "updated",
    });

    expect(result.success).toBe(true);
    const body = postedBody();
    expect(
      body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`),
    ).toBe("1");
    expect(
      body.get(
        `${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute`,
      ),
    ).toBe("15");
    expect(
      body.get(`${PSP},description,listeditoid_${EFFORT}.description`),
    ).toBe("updated");
  });

  it("still works when given the _JEffort OID directly", async () => {
    mockFlow(EXPAND_JSON, saveResponse("1", "15"));
    const { editEffort } = await import("../api.js");
    const result = await editEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: EFFORT,
      hours: 1,
      minutes: 15,
      description: "updated",
    });

    expect(result.success).toBe(true);
    expect(
      postedBody().get(
        `${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`,
      ),
    ).toBe("1");
  });

  it("preserves the existing hours and minutes when only description is changed", async () => {
    mockFlow(EXPAND_JSON, saveResponse("0", "30"));
    const { editEffort } = await import("../api.js");
    const result = await editEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: TASK,
      description: "only text changed",
    });

    expect(result.success).toBe(true);
    const body = postedBody();
    expect(
      body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`),
    ).toBe("0");
    expect(
      body.get(
        `${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute`,
      ),
    ).toBe("30");
    expect(
      body.get(`${PSP},description,listeditoid_${EFFORT}.description`),
    ).toBe("only text changed");
  });

  it("preserves the existing description when only hours are changed", async () => {
    mockFlow(EXPAND_JSON, saveResponse("2", "30"));
    const { editEffort } = await import("../api.js");
    const result = await editEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: TASK,
      hours: 2,
    });

    expect(result.success).toBe(true);
    const body = postedBody();
    expect(
      body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`),
    ).toBe("2");
    expect(
      body.get(
        `${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute`,
      ),
    ).toBe("30");
    expect(
      body.get(`${PSP},description,listeditoid_${EFFORT}.description`),
    ).toBe("work");
  });

  it("submits the edited effort exactly once when page and AJAX fields overlap", async () => {
    // Day page HTML that ALREADY carries the effort row's fields — BCS remembers
    // tree expansion server-side, so the day page can ship the same effort
    // fields that expandTreeNode returns again. This is the overlap the dedup
    // filter exists to collapse.
    const DAY_HTML_WITH_EFFORT = `<form>
      <input type="hidden" name="pagetimestamp" value="1">
      <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
      <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
      <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="30">
      <input type="hidden" name="${PSP},recordType,listeditoid_${EFFORT}.recordType" value="effort">
      <input type="hidden" name="${PSP},recordOid,listeditoid_${EFFORT}.recordOid" value="${EFFORT}">
      <input type="hidden" name="${PSP},effortTargetOid,listeditoid_${EFFORT}.effortTargetOid" value="${TASK}">
      <input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour" value="0">
      <input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute" value="30">
      <input type="text" name="${PSP},description,listeditoid_${EFFORT}.description" value="work">
    </form>`;

    authenticatedFetch.mockReset();
    authenticatedFetch
      .mockResolvedValueOnce(new Response(DAY_HTML_WITH_EFFORT, { status: 200 }))
      .mockResolvedValueOnce(new Response(EXPAND_JSON, { status: 201 }))
      .mockResolvedValueOnce(new Response(saveResponse("1", "15"), { status: 200 }));

    const { editEffort } = await import("../api.js");
    const result = await editEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: EFFORT,
      hours: 1,
      minutes: 15,
      description: "updated",
    });

    expect(result.success).toBe(true);
    const body = postedBody();

    // Assert on recordType/recordOid/effortTargetOid — fields editEffort never
    // rewrites. If the dedup filter were removed, the page copy + the AJAX
    // copy would both survive and these getAll() calls would return two
    // entries.
    expect(
      body.getAll(`${PSP},recordType,listeditoid_${EFFORT}.recordType`),
    ).toEqual(["effort"]);
    expect(
      body.getAll(`${PSP},recordOid,listeditoid_${EFFORT}.recordOid`),
    ).toEqual([EFFORT]);
    expect(
      body.getAll(
        `${PSP},effortTargetOid,listeditoid_${EFFORT}.effortTargetOid`,
      ),
    ).toEqual([TASK]);
    expect(
      body.getAll(
        `${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`,
      ),
    ).toEqual(["1"]);
  });

  it("throws when neither hours, minutes, nor description are given", async () => {
    const { editEffort } = await import("../api.js");
    await expect(
      editEffort({ date: "2026-07-08", projectOid: PROJ, taskLineOid: TASK }),
    ).rejects.toThrow(/at least one/);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("throws when the OID matches neither a row nor an effortTargetOid", async () => {
    mockFlow(EXPAND_JSON, saveResponse("1", "15"));
    const { editEffort } = await import("../api.js");
    await expect(
      editEffort({
        date: "2026-07-08",
        projectOid: PROJ,
        taskLineOid: "UNKNOWN_JTask",
        hours: 1,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("throws when the task has no existing booked effort yet", async () => {
    mockFlow(EXPAND_JSON_EMPTY, saveResponse("0", "00"));
    const { editEffort } = await import("../api.js");
    await expect(
      editEffort({
        date: "2026-07-08",
        projectOid: PROJ,
        taskLineOid: TASK,
        hours: 1,
      }),
    ).rejects.toThrow(/no existing booked effort/);
  });

  it("reports success:false when the saved aggregate does not match the expected total", async () => {
    // Save response reports an aggregate that doesn't reflect the requested edit.
    mockFlow(EXPAND_JSON, saveResponse("0", "30"));
    const { editEffort } = await import("../api.js");
    const result = await editEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: TASK,
      hours: 1,
      minutes: 15,
      description: "updated",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
