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

const TASK2 = "TASK2_JTask";
const EFFORT2 = "EFF2_JEffort";

// Day page where the project carries TWO efforts (0h30 + 1h30 = 2h00), so its
// aggregate cannot reach 0 by deleting just one of them.
const DAY_HTML_TWO_EFFORTS = `<form>
  <input type="hidden" name="pagetimestamp" value="1">
  <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="2">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="00">
</form>`;

const EXPAND_JSON_TWO_EFFORTS = JSON.stringify({
  html:
    `<input type="hidden" name="${PSP},recordType,listeditoid_${EFFORT}.recordType" value="effort">` +
    `<input type="hidden" name="${PSP},recordOid,listeditoid_${EFFORT}.recordOid" value="${EFFORT}">` +
    `<input type="hidden" name="${PSP},effortTargetOid,listeditoid_${EFFORT}.effortTargetOid" value="${TASK}">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour" value="0">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute" value="30">` +
    `<input type="text" name="${PSP},description,listeditoid_${EFFORT}.description" value="work">` +
    `<input type="hidden" name="${PSP},recordType,listeditoid_${EFFORT2}.recordType" value="effort">` +
    `<input type="hidden" name="${PSP},recordOid,listeditoid_${EFFORT2}.recordOid" value="${EFFORT2}">` +
    `<input type="hidden" name="${PSP},effortTargetOid,listeditoid_${EFFORT2}.effortTargetOid" value="${TASK2}">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT2}.effortExpense_hour" value="1">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT2}.effortExpense_minute" value="30">` +
    `<input type="text" name="${PSP},description,listeditoid_${EFFORT2}.description" value="other work">`,
});

function projectAggregateResponse(hour: string, minute: string): string {
  return `<form>
    <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
    <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="${hour}">
    <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="${minute}">
  </form>`;
}

function mockFlowTwoEfforts(saveHtml: string): void {
  authenticatedFetch.mockReset();
  authenticatedFetch
    .mockResolvedValueOnce(new Response(DAY_HTML_TWO_EFFORTS, { status: 200 }))
    .mockResolvedValueOnce(
      new Response(EXPAND_JSON_TWO_EFFORTS, { status: 201 }),
    )
    .mockResolvedValueOnce(new Response(saveHtml, { status: 200 }));
}

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

  it("submits the cleared effort exactly once when page and AJAX fields overlap", async () => {
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

    authenticatedFetch
      .mockResolvedValueOnce(new Response(DAY_HTML_WITH_EFFORT, { status: 200 }))
      .mockResolvedValueOnce(new Response(EXPAND_JSON, { status: 201 }))
      .mockResolvedValueOnce(new Response(CLEARED_RESPONSE, { status: 200 }));

    const { deleteEffort } = await import("../api.js");
    const result = await deleteEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: EFFORT,
    });

    expect(result.success).toBe(true);
    const body = postedBody();

    // Assert on recordType / recordOid / effortTargetOid — fields body.set()
    // never rewrites (delete only clears effortExpense_*/effortStart_*/
    // effortEnd_*/description). If the dedup filter were removed, the page copy +
    // the AJAX copy would both survive and these getAll() calls would return two
    // entries. The cleared fields would be a false-negative assertion because
    // body.set() collapses their duplicates automatically.
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
  });

  it("reports success when one of several efforts in the same project is deleted", async () => {
    // The project keeps 1h30 from the second effort, so its aggregate never
    // reaches 0 — which the old check mistook for a failed delete.
    mockFlowTwoEfforts(projectAggregateResponse("1", "30"));
    const { deleteEffort } = await import("../api.js");
    const result = await deleteEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: EFFORT,
    });

    expect(result.success).toBe(true);
    const body = postedBody();
    expect(
      body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`),
    ).toBe("");
    // The untouched second effort still carries its value.
    expect(
      body.get(`${PSP},effortExpense,listeditoid_${EFFORT2}.effortExpense_hour`),
    ).toBe("1");
  });

  it("reports failure when the project aggregate does not match the expected delta", async () => {
    // The aggregate drops to 0 although only the 0h30 row was targeted — BCS
    // cleared more than asked. Deliberately the case the old === 0 check read
    // as success, so this pins the delta rather than just "not blanket true".
    mockFlowTwoEfforts(projectAggregateResponse("0", "00"));
    const { deleteEffort } = await import("../api.js");
    const result = await deleteEffort({
      date: "2026-07-08",
      projectOid: PROJ,
      taskLineOid: EFFORT,
    });

    expect(result.success).toBe(false);
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
