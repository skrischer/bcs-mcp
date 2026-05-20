import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth layer so setAttendance() runs against controlled HTTP responses.
const authenticatedFetch = vi.fn();
vi.mock("../auth.js", () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  getConfig: () => ({
    BCS_URL: "https://bcs.example.test",
    BCS_USER_OID: "USER1_JUser",
  }),
}));

const ATT = "daytimerecording,Content,daytimerecordingAttendance,Columns";

// A day page with a *saved* attendance row (08:00-17:00, 9h) and a *saved*
// pause row (1h), plus the usual $new$ template rows.
const SAVED_DAY_HTML = `<form>
  <input type="hidden" name="pagetimestamp" value="123">
  <input type="hidden" name="${ATT},recordType,listeditoid_ATT1.recordType" value="attendance">
  <input type="text" name="${ATT},attandenceStart,listeditoid_ATT1.attandenceStart_hour" value="8">
  <input type="text" name="${ATT},attandenceStart,listeditoid_ATT1.attandenceStart_minute" value="00">
  <input type="text" name="${ATT},attandenceEnd,listeditoid_ATT1.attandenceEnd_hour" value="17">
  <input type="text" name="${ATT},attandenceEnd,listeditoid_ATT1.attandenceEnd_minute" value="00">
  <input type="text" name="${ATT},attandenceDuration,listeditoid_ATT1.attandenceDuration_hour" value="9">
  <input type="text" name="${ATT},attandenceDuration,listeditoid_ATT1.attandenceDuration_minute" value="00">

  <input type="hidden" name="${ATT},recordType,listeditoid_PAU1.recordType" value="pause">
  <input type="text" name="${ATT},attandenceDuration,listeditoid_PAU1.attandenceDuration_hour" value="1">
  <input type="text" name="${ATT},attandenceDuration,listeditoid_PAU1.attandenceDuration_minute" value="00">

  <input type="hidden" name="${ATT},recordType,listeditoid_$new$1234_JTimeSpan.recordType" value="unsavedAttendance">
  <input type="text" name="${ATT},attandenceStart,listeditoid_$new$1234_JTimeSpan.attandenceStart_hour" value="8">
  <input type="text" name="${ATT},attandenceEnd,listeditoid_$new$1234_JTimeSpan.attandenceEnd_hour" value="17">
  <input type="text" name="${ATT},attandenceDuration,listeditoid_$new$1234_JTimeSpan.attandenceDuration_hour" value="9">
  <input type="hidden" name="${ATT},recordType,listeditoid_$new$5678_JTimeSpan.recordType" value="unsavedPause">
  <input type="text" name="${ATT},attandenceDuration,listeditoid_$new$5678_JTimeSpan.attandenceDuration_hour" value="1">
</form>`;

function postedBody(): URLSearchParams {
  // The second authenticatedFetch call is the POST; grab its body.
  const postCall = authenticatedFetch.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "POST",
  );
  if (!postCall) throw new Error("no POST call captured");
  return new URLSearchParams((postCall[1] as RequestInit).body as string);
}

describe("setAttendance (saved rows)", () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    authenticatedFetch
      .mockResolvedValueOnce(new Response(SAVED_DAY_HTML, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
  });

  it("recomputes the attendance duration from start/end", async () => {
    const { setAttendance } = await import("../api.js");
    const result = await setAttendance({
      date: "2026-05-20",
      startHour: 8,
      startMinute: 0,
      endHour: 18,
      endMinute: 0,
      pauseHour: 1,
      pauseMinute: 0,
    });
    expect(result.success).toBe(true);

    const body = postedBody();
    expect(body.get(`${ATT},attandenceEnd,listeditoid_ATT1.attandenceEnd_hour`)).toBe("18");
    // 08:00–18:00 gross = 10:00, not the stale 9:00 from the page.
    expect(body.get(`${ATT},attandenceDuration,listeditoid_ATT1.attandenceDuration_hour`)).toBe("10");
    expect(body.get(`${ATT},attandenceDuration,listeditoid_ATT1.attandenceDuration_minute`)).toBe("00");
  });

  it("writes the pause onto the saved pause row, not the $new$ row", async () => {
    const { setAttendance } = await import("../api.js");
    await setAttendance({
      date: "2026-05-20",
      startHour: 9,
      startMinute: 0,
      endHour: 16,
      endMinute: 0,
      pauseHour: 0,
      pauseMinute: 30,
    });

    const body = postedBody();
    expect(body.get(`${ATT},attandenceDuration,listeditoid_PAU1.attandenceDuration_hour`)).toBe("0");
    expect(body.get(`${ATT},attandenceDuration,listeditoid_PAU1.attandenceDuration_minute`)).toBe("30");
    // attendance duration recomputed to 7h
    expect(body.get(`${ATT},attandenceDuration,listeditoid_ATT1.attandenceDuration_hour`)).toBe("7");
  });

  it("strips $new$ rows when a saved counterpart exists", async () => {
    const { setAttendance } = await import("../api.js");
    await setAttendance({
      date: "2026-05-20",
      startHour: 8,
      startMinute: 0,
      endHour: 18,
      endMinute: 0,
      pauseHour: 1,
      pauseMinute: 0,
    });

    const body = postedBody();
    const hasNewRow = [...body.keys()].some((k) =>
      k.includes("daytimerecordingAttendance,$new$"),
    );
    expect(hasNewRow).toBe(false);
  });
});
