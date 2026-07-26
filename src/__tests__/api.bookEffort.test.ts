import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth layer so bookEffort() runs against controlled HTTP responses.
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
// expandTreeNode returns a _JEffort OID (not _JTask) once a task has saved
// effort — bookEffort resolves the underlying task via effortTargetOid.
const EFFORT = "EFFORT1_JEffort";

// Minimal day page: one project row, aggregate 0.
const DAY_HTML = `<form>
  <input type="hidden" name="pagetimestamp" value="1">
  <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="00">
</form>`;

// AJAX tree-expand response: one empty (neweffort) task row -> Path A.
const EXPAND_JSON = JSON.stringify({
  html:
    `<input type="hidden" name="${PSP},recordType,listeditoid_${TASK}.recordType" value="neweffort">` +
    `<input type="hidden" name="${PSP},effortTargetOid,listeditoid_${TASK}.effortTargetOid" value="${TASK}">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_hour" value="0">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_minute" value="00">` +
    `<input type="text" name="${PSP},description,listeditoid_${TASK}.description" value="">`,
});

// AJAX tree-expand response whose task row carries a SAVED effort record
// (recordType=effort) with 1h00 already booked -> forces Path B, the $new$
// unsavedeffort append path. The effort row's effortTargetOid points back at the
// underlying task OID (which bookEffort uses for the $new$ row's target).
const EXPAND_JSON_PATH_B = JSON.stringify({
  html:
    `<input type="hidden" name="${PSP},recordType,listeditoid_${EFFORT}.recordType" value="effort">` +
    `<input type="hidden" name="${PSP},recordOid,listeditoid_${EFFORT}.recordOid" value="${EFFORT}">` +
    `<input type="hidden" name="${PSP},effortTargetOid,listeditoid_${EFFORT}.effortTargetOid" value="${TASK}">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour" value="1">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute" value="00">` +
    `<input type="text" name="${PSP},description,listeditoid_${EFFORT}.description" value="existing work">`,
});

// Save response when BCS rejects the booking (e.g. booking deadline). BCS still
// returns 200; the aggregate stays 0 and an error message block is present.
const LOCKED_RESPONSE = `<form>
  <div class="defaultMessageContainer">
    <div class="messagedisplay errors" id="EffortsService_RecordRestrictionBides">
      <div class="messageContainer">
        <div class="msg error"><a class="support"></a><span>Sie können keine Aufwände vor dem 08.07.2026 einfügen, ändern oder löschen (Tagesbuchungsfrist).</span></div>
      </div>
    </div>
  </div>
  <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="00">
</form>`;

// Save response for an accepted booking: aggregate rose to 0h30, no errors.
const OK_RESPONSE = `<form>
  <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
  <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="30">
</form>`;

function mockFlow(saveResponse: string): void {
  authenticatedFetch.mockReset();
  authenticatedFetch
    .mockResolvedValueOnce(new Response(DAY_HTML, { status: 200 }))
    .mockResolvedValueOnce(new Response(EXPAND_JSON, { status: 201 }))
    .mockResolvedValueOnce(new Response(saveResponse, { status: 200 }));
}

const params = {
  date: "2026-07-06",
  projectOid: PROJ,
  taskLineOid: TASK,
  hours: 0,
  minutes: 30,
  description: "test",
};

describe("bookEffort error passthrough", () => {
  beforeEach(() => authenticatedFetch.mockReset());

  it("surfaces the BCS error message when a booking is rejected", async () => {
    mockFlow(LOCKED_RESPONSE);
    const { bookEffort } = await import("../api.js");
    const result = await bookEffort(params);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Tagesbuchungsfrist");
  });

  it("returns success without error when the booking is accepted", async () => {
    mockFlow(OK_RESPONSE);
    const { bookEffort } = await import("../api.js");
    const result = await bookEffort(params);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe("bookEffort Path B (existing-effort append)", () => {
  beforeEach(() => authenticatedFetch.mockReset());

  it("appends a $new$ unsavedeffort row instead of overwriting the existing effort", async () => {
    authenticatedFetch
      .mockResolvedValueOnce(new Response(DAY_HTML, { status: 200 }))
      .mockResolvedValueOnce(new Response(EXPAND_JSON_PATH_B, { status: 201 }))
      .mockResolvedValueOnce(new Response(OK_RESPONSE, { status: 200 }));

    const { bookEffort } = await import("../api.js");
    await bookEffort({
      date: "2026-07-06",
      projectOid: PROJ,
      taskLineOid: EFFORT, // effort OID, as expandTreeNode returns for occupied tasks
      hours: 1,
      minutes: 30,
      description: "path b booking",
    });

    // The POST is the third authenticatedFetch call.
    const [, options] = authenticatedFetch.mock.calls[2] as [
      string,
      { body: string },
    ];
    const body = new URLSearchParams(options.body);
    const entries = [...body.entries()];

    // Path B signature: exactly one $new$ recordType row valued "unsavedeffort".
    // Matched by value (not a fixed key) — the $new$ OID embeds Date.now().
    const unsavedRows = entries.filter(([, value]) => value === "unsavedeffort");
    expect(unsavedRows).toHaveLength(1);
    const newRecordTypeKey = unsavedRows[0]?.[0] ?? "";
    expect(newRecordTypeKey).toMatch(/\.recordType$/);
    expect(newRecordTypeKey).toContain("$new$");

    // The pre-existing effort row is left intact — not overwritten.
    expect(
      body.getAll(`${PSP},recordType,listeditoid_${EFFORT}.recordType`),
    ).toEqual(["effort"]);
    expect(
      body.get(`${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_hour`),
    ).toBe("1");
    expect(
      body.get(
        `${PSP},effortExpense,listeditoid_${EFFORT}.effortExpense_minute`,
      ),
    ).toBe("00");

    // The $new$ row carries the booked time, an empty recordOid, and targets the
    // underlying task OID (resolved from the existing effort's effortTargetOid).
    const newOid = newRecordTypeKey.match(/listeditoid_(\$new\$[^.]+)\./)?.[1];
    expect(newOid).toBeDefined();
    const newLid = `listeditoid_${newOid}`;
    expect(
      body.get(`${PSP},effortExpense,${newLid}.effortExpense_hour`),
    ).toBe("1");
    expect(
      body.get(`${PSP},effortExpense,${newLid}.effortExpense_minute`),
    ).toBe("30");
    expect(body.get(`${PSP},recordOid,${newLid}.recordOid`)).toBe("");
    expect(body.get(`${PSP},effortTargetOid,${newLid}.effortTargetOid`)).toBe(
      TASK,
    );
    expect(body.get(`${PSP},description,${newLid}.description`)).toBe(
      "path b booking",
    );
  });
});

describe("bookEffort page-vs-AJAX field dedup", () => {
  beforeEach(() => authenticatedFetch.mockReset());

  // Day page HTML that ALREADY carries the (empty) task row's fields — BCS
  // remembers tree expansion server-side, so the day page can ship the same
  // task fields that expandTreeNode returns again. This is the overlap the
  // dedup filter exists to collapse.
  const DAY_HTML_WITH_TASK = `<form>
    <input type="hidden" name="pagetimestamp" value="1">
    <input type="hidden" name="${PSP},recordType,listeditoid_${PROJ}.recordType" value="project">
    <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_hour" value="0">
    <input type="text" name="${PSP},effortExpense,listeditoid_${PROJ}.effortExpense_minute" value="00">
    <input type="hidden" name="${PSP},recordType,listeditoid_${TASK}.recordType" value="neweffort">
    <input type="hidden" name="${PSP},effortTargetOid,listeditoid_${TASK}.effortTargetOid" value="${TASK}">
    <input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_hour" value="0">
    <input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_minute" value="00">
    <input type="text" name="${PSP},description,listeditoid_${TASK}.description" value="">
  </form>`;

  it("submits the effort exactly once when page and AJAX fields overlap", async () => {
    authenticatedFetch
      .mockResolvedValueOnce(new Response(DAY_HTML_WITH_TASK, { status: 200 }))
      .mockResolvedValueOnce(new Response(EXPAND_JSON, { status: 201 }))
      .mockResolvedValueOnce(new Response(OK_RESPONSE, { status: 200 }));

    const { bookEffort } = await import("../api.js");
    await bookEffort(params);

    const [, options] = authenticatedFetch.mock.calls[2] as [
      string,
      { body: string },
    ];
    const body = new URLSearchParams(options.body);

    // Assert on recordType / effortTargetOid — fields body.set() never rewrites
    // for Path A (only effortExpense_*/description are set). If the dedup filter
    // were removed, the page copy + the AJAX copy would both survive and these
    // getAll() calls would return two entries. body.set() would mask a duplicate
    // effortExpense field, so those would be a false-negative assertion.
    expect(
      body.getAll(`${PSP},recordType,listeditoid_${TASK}.recordType`),
    ).toEqual(["neweffort"]);
    expect(
      body.getAll(`${PSP},effortTargetOid,listeditoid_${TASK}.effortTargetOid`),
    ).toEqual([TASK]);
  });
});

describe("parseBcsErrors", () => {
  it("extracts messages from a .messagedisplay.errors block", async () => {
    const { parseBcsErrors } = await import("../api.js");
    const errors = parseBcsErrors(LOCKED_RESPONSE);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Tagesbuchungsfrist");
  });

  it("returns an empty array when there is no error block", async () => {
    const { parseBcsErrors } = await import("../api.js");
    expect(parseBcsErrors(OK_RESPONSE)).toEqual([]);
  });
});
