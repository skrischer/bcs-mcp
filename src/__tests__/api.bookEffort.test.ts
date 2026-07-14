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
    `<input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_hour" value="0">` +
    `<input type="text" name="${PSP},effortExpense,listeditoid_${TASK}.effortExpense_minute" value="00">` +
    `<input type="text" name="${PSP},description,listeditoid_${TASK}.description" value="">`,
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
