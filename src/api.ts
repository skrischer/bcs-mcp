import { parse as parseHtml } from "node-html-parser";
import { authenticatedFetch, getConfig } from "./auth.js";
import { log } from "./logger.js";

const PAGE_PATH = "/bcs/mybcs/dayeffortrecording/display";
const NOTIFICATION_PATH = "/bcs/mybcs/notificationoverview/display";
const VACATION_PATH = "/bcs/mybcs/vacation/display";
const PSP_PREFIX = "daytimerecording,Content,daytimerecordingPspTree,Columns";
// BCS misspells "attendance" as "attandence" in all field names
const ATTENDANCE_PREFIX =
  "daytimerecording,Content,daytimerecordingAttendance,Columns";

export interface ProjectAggregate {
  projectOid: string;
  name: string;
  hours: number;
  minutes: number;
}

export interface AttendanceEntry {
  oid: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  durationHour: number;
  durationMinute: number;
  recordType: string;
  label?: string;
}

export interface TaskDetail {
  lineOid: string;
  name: string;
  recordOid: string;
  hours: number;
  minutes: number;
  description: string;
  recordType: string;
}

export type DayType = "workday" | "holiday" | "absence";

export interface DaySummary {
  dayType: DayType;
  absenceReason?: string;
  attendance: AttendanceEntry[];
  projects: ProjectAggregate[];
  bookedHours: number;
  bookedMinutes: number;
  unbookedHours: number;
  unbookedMinutes: number;
}

export interface DaySummaryWithDate {
  date: string;
  summary: DaySummary;
}

export interface WeekSummary {
  days: DaySummaryWithDate[];
  totalBookedHours: number;
  totalBookedMinutes: number;
  totalUnbookedHours: number;
  totalUnbookedMinutes: number;
}

function buildDateParams(date: string): Record<string, string> {
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) throw new Error(`Invalid date: ${date}`);
  return {
    "daytimerecording,Selections,effortRecordingDate,year": year,
    "daytimerecording,Selections,effortRecordingDate,month": String(
      parseInt(month, 10),
    ),
    "daytimerecording,Selections,effortRecordingDate,day": String(
      parseInt(day, 10),
    ),
  };
}

function generateTransactionId(): string {
  const hex = Math.random().toString(16).substring(2, 10);
  return `${Date.now()}-${hex}`;
}

function validateDayPageHtml(html: string, date: string): void {
  if (html.includes('name="pwd"') && html.includes('name="user"')) {
    log("api:validate", "FAIL: received login page instead of day recording", {
      date,
    });
    throw new Error(
      "Session expired: received login page instead of day recording page",
    );
  }
  if (!html.includes("daytimerecording")) {
    log("api:validate", "FAIL: missing daytimerecording form structure", {
      date,
      htmlLength: html.length,
      htmlSnippet: html.slice(0, 200),
    });
    throw new Error(
      "Invalid page: missing daytimerecording form structure. Check BCS_USER_OID.",
    );
  }
}

export async function fetchDayPage(date: string): Promise<string> {
  const config = getConfig();
  const dateParams = buildDateParams(date);
  const params = new URLSearchParams({
    ...dateParams,
    oid: config.BCS_USER_OID,
    transactionId: generateTransactionId(),
  });

  log("api:fetch", "Fetching day page", { date, userOid: config.BCS_USER_OID });
  const url = `${config.BCS_URL}${PAGE_PATH}?${params.toString()}`;
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    log("api:fetch", "Day page fetch failed", {
      date,
      status: response.status,
    });
    throw new Error(`Failed to fetch day page: ${response.status}`);
  }

  const html = await response.text();
  log("api:fetch", "Day page received", { date, htmlLength: html.length });
  validateDayPageHtml(html, date);
  return html;
}

export function parseFormState(html: string): [string, string][] {
  const root = parseHtml(html);
  // Note: BCS has nested forms (invalid HTML), so we parse from root
  // to capture all fields. Non-submittable types are filtered below.
  const form = root;
  const fields: [string, string][] = [];

  for (const el of form.querySelectorAll("input[name]")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const type = el.getAttribute("type")?.toLowerCase();
    // Skip non-submittable types (only included when clicked)
    if (type === "submit" || type === "image" || type === "button") continue;
    if (type === "checkbox" || type === "radio") {
      if (el.getAttribute("checked") !== null) {
        fields.push([name, el.getAttribute("value") ?? "on"]);
      }
    } else {
      fields.push([name, el.getAttribute("value") ?? ""]);
    }
  }

  for (const el of form.querySelectorAll("textarea[name]")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    fields.push([name, el.text ?? ""]);
  }

  for (const el of form.querySelectorAll("select[name]")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const selected = el.querySelector("option[selected]");
    fields.push([name, selected?.getAttribute("value") ?? ""]);
  }

  return fields;
}

export function toFormMap(fields: [string, string][]): Map<string, string> {
  return new Map(fields);
}

// BCS reports save rejections in a `.messagedisplay.errors` block (each message
// in a `.msg` element). It still returns HTTP 200, so this is the only reliable
// signal that a POST was refused (e.g. booking deadline, validation errors).
export function parseBcsErrors(html: string): string[] {
  const root = parseHtml(html);
  const messages: string[] = [];
  for (const el of root.querySelectorAll(".messagedisplay.errors .msg")) {
    const text = el.text?.replace(/\s+/g, " ").trim();
    if (text) messages.push(text);
  }
  return messages;
}

export function parsePspTreeNames(html: string): Map<string, string> {
  const root = parseHtml(html);
  const names = new Map<string, string>();

  for (const input of root.querySelectorAll("input[name]")) {
    const name = input.getAttribute("name");
    if (!name) continue;
    if (!name.includes(`${PSP_PREFIX},recordType,listeditoid_`)) continue;
    if (!name.endsWith(".recordType")) continue;

    const oidMatch = /listeditoid_([^.]+)/.exec(name);
    const oid = oidMatch?.[1];
    if (!oid || oid.includes("$new$")) continue;

    // Walk up to <tr> ancestor
    let node = input.parentNode;
    while (node && node.tagName !== "TR") {
      node = node.parentNode;
    }
    if (!node) continue;

    // Extract full hierarchical path from all <a><span> elements in the row
    const spans = node.querySelectorAll("a span");
    const pathParts: string[] = [];
    for (const span of spans) {
      const text = span.text?.trim();
      if (text) pathParts.push(text);
    }
    if (pathParts.length > 0) {
      names.set(oid, pathParts.join(" > "));
    }
  }

  return names;
}

export function parseAttendance(html: string): AttendanceEntry[] {
  const root = parseHtml(html);
  const formState = toFormMap(parseFormState(html));
  const entries: AttendanceEntry[] = [];
  const seenOids = new Set<string>();

  // Pre-build event label map: OID -> label text from <a><span> in attandenceLabel cells
  const eventLabels = new Map<string, string>();
  for (const inp of root.querySelectorAll("input[name]")) {
    const name = inp.getAttribute("name") ?? "";
    if (!name.includes(`${ATTENDANCE_PREFIX},recordType,listeditoid_`)) continue;
    if (!name.endsWith(".recordType")) continue;
    const oidMatch = /listeditoid_([^.]+)/.exec(name);
    const oid = oidMatch?.[1];
    if (!oid) continue;
    const val = inp.getAttribute("value");
    if (val !== "event") continue;
    let tr = inp.parentNode;
    while (tr && tr.tagName !== "TR") tr = tr.parentNode;
    const labelTd = tr?.querySelector("td[name='attandenceLabel']");
    const spans = labelTd?.querySelectorAll("a span") ?? [];
    const text = [...spans].map((s) => s.text?.trim()).filter(Boolean).join(" ");
    if (text) eventLabels.set(oid, text);
  }

  for (const [key, value] of formState) {
    if (
      key.includes(`${ATTENDANCE_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType")
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      const oid = m?.[1];
      if (!oid || seenOids.has(oid)) continue;
      seenOids.add(oid);

      const get = (column: string, field: string) =>
        parseInt(
          formState.get(
            `${ATTENDANCE_PREFIX},${column},listeditoid_${oid}.${field}`,
          ) ?? "0",
          10,
        ) || 0;

      const entry: AttendanceEntry = {
        oid,
        startHour: get("attandenceStart", "attandenceStart_hour"),
        startMinute: get("attandenceStart", "attandenceStart_minute"),
        endHour: get("attandenceEnd", "attandenceEnd_hour"),
        endMinute: get("attandenceEnd", "attandenceEnd_minute"),
        durationHour: get("attandenceDuration", "attandenceDuration_hour"),
        durationMinute: get("attandenceDuration", "attandenceDuration_minute"),
        recordType: value,
      };
      const label = eventLabels.get(oid);
      if (label) entry.label = label;
      entries.push(entry);
    }
  }

  return entries;
}

export function parseProjectAggregates(
  html: string,
  names?: Map<string, string>,
): ProjectAggregate[] {
  const formState = toFormMap(parseFormState(html));
  const projects: ProjectAggregate[] = [];

  for (const [key, value] of formState) {
    if (
      key.includes(`${PSP_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType") &&
      value === "project"
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      const oid = m?.[1];
      if (!oid) continue;

      const hourKey = `${PSP_PREFIX},effortExpense,listeditoid_${oid}.effortExpense_hour`;
      const minKey = `${PSP_PREFIX},effortExpense,listeditoid_${oid}.effortExpense_minute`;
      projects.push({
        projectOid: oid,
        name: names?.get(oid) ?? oid,
        hours: parseInt(formState.get(hourKey) ?? "0", 10) || 0,
        minutes: parseInt(formState.get(minKey) ?? "0", 10) || 0,
      });
    }
  }

  return projects;
}

export function parseExpandedTasks(
  fields: [string, string][],
  names?: Map<string, string>,
): TaskDetail[] {
  const m = toFormMap(fields);
  const tasks: TaskDetail[] = [];

  for (const [key, value] of m) {
    if (
      key.includes(`${PSP_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType")
    ) {
      const match = /listeditoid_([^.]+)/.exec(key);
      const lineOid = match?.[1];
      if (!lineOid) continue;

      tasks.push({
        lineOid,
        name: names?.get(lineOid) ?? lineOid,
        recordOid:
          m.get(`${PSP_PREFIX},recordOid,listeditoid_${lineOid}.recordOid`) ??
          "",
        hours:
          parseInt(
            m.get(
              `${PSP_PREFIX},effortExpense,listeditoid_${lineOid}.effortExpense_hour`,
            ) ?? "0",
            10,
          ) || 0,
        minutes:
          parseInt(
            m.get(
              `${PSP_PREFIX},effortExpense,listeditoid_${lineOid}.effortExpense_minute`,
            ) ?? "0",
            10,
          ) || 0,
        description:
          m.get(
            `${PSP_PREFIX},description,listeditoid_${lineOid}.description`,
          ) ?? "",
        recordType: value,
      });
    }
  }

  return tasks;
}

export function deriveDayType(attendance: AttendanceEntry[]): {
  dayType: DayType;
  absenceReason?: string;
} {
  const event = attendance.find((a) => a.recordType === "event");
  if (event) {
    return { dayType: "absence", absenceReason: event.label };
  }

  // No event: check if any real attendance exists (saved or unsaved with values)
  const hasAttendance = attendance.some(
    (a) =>
      (a.recordType === "attendance" ||
        a.recordType === "unsavedAttendance") &&
      a.durationHour + a.durationMinute > 0,
  );
  if (!hasAttendance) {
    return { dayType: "holiday" };
  }

  return { dayType: "workday" };
}

export async function getDaySummary(date: string): Promise<DaySummary> {
  const html = await fetchDayPage(date);
  const attendance = parseAttendance(html);
  const names = parsePspTreeNames(html);
  const projects = parseProjectAggregates(html, names);

  log("api:parse", "getDaySummary", {
    date,
    attendanceEntries: attendance.length,
    projects: projects.length,
    projectNames: projects.map((p) => p.name),
    formFields: parseFormState(html).length,
  });

  const { dayType, absenceReason } = deriveDayType(attendance);

  let bookedTotal = 0;
  for (const p of projects) {
    bookedTotal += p.hours * 60 + p.minutes;
  }

  let workingMinutes = 0;
  if (dayType === "workday") {
    for (const a of attendance) {
      if (a.recordType === "distributed" || a.recordType === "undistributed") {
        continue;
      }
      if (a.recordType === "unsavedPause" || a.recordType === "pause") {
        workingMinutes -= a.durationHour * 60 + a.durationMinute;
      } else {
        workingMinutes += a.durationHour * 60 + a.durationMinute;
      }
    }
  }

  const unbookedTotal = Math.max(0, workingMinutes - bookedTotal);

  const summary: DaySummary = {
    dayType,
    attendance,
    projects,
    bookedHours: Math.floor(bookedTotal / 60),
    bookedMinutes: bookedTotal % 60,
    unbookedHours: Math.floor(unbookedTotal / 60),
    unbookedMinutes: unbookedTotal % 60,
  };
  if (absenceReason) summary.absenceReason = absenceReason;
  return summary;
}

function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getWeekDates(dateInWeek: string): string[] {
  const d = new Date(dateInWeek + "T12:00:00");
  const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(d);
  monday.setDate(d.getDate() + mondayOffset);

  const dates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    dates.push(formatDateLocal(day));
  }
  return dates;
}

export async function getWeekSummary(dateInWeek: string): Promise<WeekSummary> {
  const dates = getWeekDates(dateInWeek);
  // Sequential: BCS is stateful server-side, concurrent requests share date state
  const summaries: DaySummary[] = [];
  for (const d of dates) {
    summaries.push(await getDaySummary(d));
  }

  let totalBooked = 0;
  let totalUnbooked = 0;
  const days: DaySummaryWithDate[] = dates.map((date, i) => {
    const summary = summaries[i]!;
    totalBooked += summary.bookedHours * 60 + summary.bookedMinutes;
    totalUnbooked += summary.unbookedHours * 60 + summary.unbookedMinutes;
    return { date, summary };
  });

  return {
    days,
    totalBookedHours: Math.floor(totalBooked / 60),
    totalBookedMinutes: totalBooked % 60,
    totalUnbookedHours: Math.floor(totalUnbooked / 60),
    totalUnbookedMinutes: totalUnbooked % 60,
  };
}

export async function getTasksForProject(
  date: string,
  projectOid: string,
): Promise<TaskDetail[]> {
  const html = await fetchDayPage(date);
  const formMap = toFormMap(parseFormState(html));

  const typeKey = `${PSP_PREFIX},recordType,listeditoid_${projectOid}.recordType`;
  if (formMap.get(typeKey) !== "project") {
    throw new Error(
      `Project OID ${projectOid} not found. Available: ${getAvailableTaskOids(formMap).join(", ")}`,
    );
  }

  const { fields, names } = await expandTreeNode(projectOid);
  return parseExpandedTasks(fields, names);
}

export async function setAttendance(params: {
  date: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  pauseHour?: number;
  pauseMinute?: number;
}): Promise<{ success: boolean }> {
  const config = getConfig();
  const html = await fetchDayPage(params.date);
  const formFields = parseFormState(html);

  // Separate saved attendance (real OIDs) from $new$ template rows
  const allAttendance = parseAttendance(html);
  const savedAttendance = allAttendance.filter(
    (a) =>
      !a.oid.includes("$new$") &&
      a.recordType !== "distributed" &&
      a.recordType !== "undistributed",
  );

  // Find $new$ attendance and pause OIDs
  const formMap = toFormMap(formFields);
  let newAttendanceOid: string | undefined;
  let newPauseOid: string | undefined;
  for (const [key, value] of formMap) {
    if (
      key.includes(`${ATTENDANCE_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType") &&
      key.includes("$new$")
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      if (!m?.[1]) continue;
      if (value === "unsavedAttendance") newAttendanceOid = m[1];
      if (value === "unsavedPause") newPauseOid = m[1];
    }
  }

  // Prefer the saved row of each kind; fall back to the $new$ template row.
  // The pause has its own saved row (recordType "pause") that must be updated
  // on its own OID — writing only the $new$ pause leaves a saved pause untouched.
  const savedAttendanceRow = savedAttendance.find(
    (a) => a.recordType === "attendance",
  );
  const savedPauseRow = savedAttendance.find((a) => a.recordType === "pause");
  const attendanceOid = savedAttendanceRow?.oid ?? newAttendanceOid;
  const wantsPause =
    params.pauseHour !== undefined || params.pauseMinute !== undefined;
  const pauseOid = savedPauseRow?.oid ?? newPauseOid;

  if (!attendanceOid) {
    throw new Error("No attendance row found on page");
  }

  // Drop $new$ template rows, except the ones we still need to create a row
  // that has no saved counterpart yet (attendance and/or pause).
  const keepNewOids = new Set<string>();
  if (!savedAttendanceRow && newAttendanceOid)
    keepNewOids.add(newAttendanceOid);
  if (wantsPause && !savedPauseRow && newPauseOid) keepNewOids.add(newPauseOid);
  const filteredFields = formFields.filter(([name]) => {
    if (!name.includes("daytimerecordingAttendance,$new$")) return true;
    return [...keepNewOids].some((oid) => name.includes(oid));
  });

  const body = new URLSearchParams(filteredFields);

  // Set attendance start/end
  const setField = (
    oid: string,
    column: string,
    field: string,
    value: string,
  ) =>
    body.set(
      `${ATTENDANCE_PREFIX},${column},listeditoid_${oid}.${field}`,
      value,
    );

  setField(
    attendanceOid,
    "attandenceStart",
    "attandenceStart_hour",
    String(params.startHour),
  );
  setField(
    attendanceOid,
    "attandenceStart",
    "attandenceStart_minute",
    String(params.startMinute).padStart(2, "0"),
  );
  setField(
    attendanceOid,
    "attandenceEnd",
    "attandenceEnd_hour",
    String(params.endHour),
  );
  setField(
    attendanceOid,
    "attandenceEnd",
    "attandenceEnd_minute",
    String(params.endMinute).padStart(2, "0"),
  );

  // BCS validates the attendance row against its duration field, which it
  // expects to match end - start (gross, before pause). The web UI recomputes
  // this client-side on every edit; if we leave the old duration in place, BCS
  // keeps the previous times and silently ignores the new start/end (the POST
  // still returns 200). So recompute and send it ourselves.
  const grossMinutes =
    params.endHour * 60 +
    params.endMinute -
    (params.startHour * 60 + params.startMinute);
  setField(
    attendanceOid,
    "attandenceDuration",
    "attandenceDuration_hour",
    String(Math.floor(grossMinutes / 60)),
  );
  setField(
    attendanceOid,
    "attandenceDuration",
    "attandenceDuration_minute",
    String(grossMinutes % 60).padStart(2, "0"),
  );

  if (pauseOid && wantsPause) {
    setField(
      pauseOid,
      "attandenceDuration",
      "attandenceDuration_hour",
      String(params.pauseHour ?? 0),
    );
    setField(
      pauseOid,
      "attandenceDuration",
      "attandenceDuration_minute",
      String(params.pauseMinute ?? 0).padStart(2, "0"),
    );
  }

  // Submission flags
  body.set("daytimerecording,Apply", "Speichern");
  body.set("PageForm,formChangedIndicator", "true");

  const url = `${config.BCS_URL}${PAGE_PATH}`;
  const response = await authenticatedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: config.BCS_URL,
      Referer: `${config.BCS_URL}${PAGE_PATH}?oid=${config.BCS_USER_OID}`,
    },
    body: body.toString(),
  });

  return { success: response.ok };
}

export interface ExpandedTreeResult {
  fields: [string, string][];
  names: Map<string, string>;
}

export async function expandTreeNode(
  projectOid: string,
): Promise<ExpandedTreeResult> {
  const config = getConfig();
  const url =
    `${config.BCS_URL}${PAGE_PATH}` +
    `?object=daytimerecording,Content,daytimerecordingPspTree` +
    `&ajax_request=open` +
    `&ajax_oid=${encodeURIComponent(projectOid)}` +
    `&ajax_data=true&level=1&row_id=1&ajax_messageColumnAdded=true` +
    `&timestamp=${Date.now()}` +
    `&oid=${config.BCS_USER_OID}`;

  const response = await authenticatedFetch(url);
  const json = await response.text();

  const data: unknown = JSON.parse(json);
  if (!data || typeof data !== "object" || !("html" in data))
    return { fields: [], names: new Map() };
  const wrappedHtml = `<form>${(data as { html: string }).html}</form>`;
  const fields = parseFormState(wrappedHtml);

  return {
    fields,
    names: parsePspTreeNames(wrappedHtml),
  };
}

// bcs_get_tasks returns the _JTask OID for empty tasks but the _JEffort OID
// once effort exists (expandTreeNode swaps them). Accept either: if the passed
// OID is not a row in the expand, resolve it to the effort row whose
// effortTargetOid matches it.
function resolveEffortLineOid(
  taskFields: [string, string][],
  taskMap: Map<string, string>,
  taskLineOid: string,
  projectOid: string,
): string {
  const taskTypeKey = `${PSP_PREFIX},recordType,listeditoid_${taskLineOid}.recordType`;
  if (taskMap.has(taskTypeKey)) return taskLineOid;

  const effortEntry = parseExpandedTasks(taskFields).find(
    (t) =>
      taskMap.get(
        `${PSP_PREFIX},effortTargetOid,listeditoid_${t.lineOid}.effortTargetOid`,
      ) === taskLineOid,
  );
  if (!effortEntry) {
    const available = parseExpandedTasks(taskFields)
      .map((t) => `${t.lineOid} (target: ${t.recordOid})`)
      .join(", ");
    throw new Error(
      `Task ${taskLineOid} not found in project ${projectOid}. Available: ${available}`,
    );
  }
  return effortEntry.lineOid;
}

export async function deleteEffort(params: {
  date: string;
  projectOid: string;
  taskLineOid: string;
}): Promise<{ success: boolean; projects: ProjectAggregate[] }> {
  const config = getConfig();
  const html = await fetchDayPage(params.date);
  const formFields = parseFormState(html);

  const { fields: taskFields } = await expandTreeNode(params.projectOid);
  const taskMap = toFormMap(taskFields);

  const targetLineOid = resolveEffortLineOid(
    taskFields,
    taskMap,
    params.taskLineOid,
    params.projectOid,
  );

  // The project aggregate sums every task of the project on that day, so it
  // only reaches 0 when the deleted row was the project's last effort. Capture
  // the aggregate and the row's own effort up front and verify against the
  // delta instead — same approach as editEffort.
  const initialProject = parseProjectAggregates(html).find(
    (p) => p.projectOid === params.projectOid,
  );
  const initialProjectTotal = initialProject
    ? initialProject.hours * 60 + initialProject.minutes
    : 0;
  const deletedTotal =
    (parseInt(
      taskMap.get(
        `${PSP_PREFIX},effortExpense,listeditoid_${targetLineOid}.effortExpense_hour`,
      ) ?? "0",
      10,
    ) || 0) *
      60 +
    (parseInt(
      taskMap.get(
        `${PSP_PREFIX},effortExpense,listeditoid_${targetLineOid}.effortExpense_minute`,
      ) ?? "0",
      10,
    ) || 0);

  const taskFieldKeys = new Set(taskFields.map(([name]) => name));
  const filteredFields = formFields.filter(
    ([name]) =>
      !name.includes("daytimerecordingAttendance,$new$") &&
      !taskFieldKeys.has(name),
  );
  const body = new URLSearchParams([...filteredFields, ...taskFields]);

  // Clear all effort fields with empty strings (BCS interprets as "delete")
  const clearFields = [
    "effortExpense_hour",
    "effortExpense_minute",
    "effortStart_hour",
    "effortStart_minute",
    "effortEnd_hour",
    "effortEnd_minute",
  ];
  for (const field of clearFields) {
    const col = field.replace(/_(?:hour|minute)$/, "");
    const key = `${PSP_PREFIX},${col},listeditoid_${targetLineOid}.${field}`;
    body.set(key, "");
  }
  const descKey = `${PSP_PREFIX},description,listeditoid_${targetLineOid}.description`;
  body.set(descKey, "");

  body.set("daytimerecording,Apply", "Speichern");
  body.set("PageForm,formChangedIndicator", "true");

  const url = `${config.BCS_URL}${PAGE_PATH}`;
  const response = await authenticatedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: config.BCS_URL,
      Referer: `${config.BCS_URL}${PAGE_PATH}?oid=${config.BCS_USER_OID}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to delete effort: ${response.status}`);
  }

  const responseHtml = await response.text();
  const responseMap = toFormMap(parseFormState(responseHtml));
  const afterHour = `${PSP_PREFIX},effortExpense,listeditoid_${params.projectOid}.effortExpense_hour`;
  const afterMin = `${PSP_PREFIX},effortExpense,listeditoid_${params.projectOid}.effortExpense_minute`;
  const projectTotal =
    (parseInt(responseMap.get(afterHour) ?? "0", 10) || 0) * 60 +
    (parseInt(responseMap.get(afterMin) ?? "0", 10) || 0);

  return {
    success: projectTotal === initialProjectTotal - deletedTotal,
    projects: parseProjectAggregates(responseHtml),
  };
}

export async function editEffort(params: {
  date: string;
  projectOid: string;
  taskLineOid: string;
  hours?: number;
  minutes?: number;
  description?: string;
}): Promise<{ success: boolean; projects: ProjectAggregate[]; error?: string }> {
  if (
    params.hours === undefined &&
    params.minutes === undefined &&
    params.description === undefined
  ) {
    throw new Error(
      "editEffort requires at least one of hours, minutes, or description to update",
    );
  }

  const config = getConfig();
  const html = await fetchDayPage(params.date);
  const formFields = parseFormState(html);
  const formMap = toFormMap(formFields);

  const projectTypeKey = `${PSP_PREFIX},recordType,listeditoid_${params.projectOid}.recordType`;
  if (formMap.get(projectTypeKey) !== "project") {
    throw new Error(
      `Project OID ${params.projectOid} not found. Available: ${getAvailableTaskOids(formMap).join(", ")}`,
    );
  }

  const initialProject = parseProjectAggregates(html).find(
    (p) => p.projectOid === params.projectOid,
  );
  const initialProjectTotal = initialProject
    ? initialProject.hours * 60 + initialProject.minutes
    : 0;

  const { fields: taskFields } = await expandTreeNode(params.projectOid);
  const taskMap = toFormMap(taskFields);

  const targetLineOid = resolveEffortLineOid(
    taskFields,
    taskMap,
    params.taskLineOid,
    params.projectOid,
  );

  const recordType = taskMap.get(
    `${PSP_PREFIX},recordType,listeditoid_${targetLineOid}.recordType`,
  );
  if (recordType !== "effort") {
    throw new Error(
      `Task ${params.taskLineOid} has no existing booked effort to edit (recordType=${recordType}). Use bcs_book_effort to create a new booking.`,
    );
  }

  const currentHours =
    parseInt(
      taskMap.get(
        `${PSP_PREFIX},effortExpense,listeditoid_${targetLineOid}.effortExpense_hour`,
      ) ?? "0",
      10,
    ) || 0;
  const currentMinutes =
    parseInt(
      taskMap.get(
        `${PSP_PREFIX},effortExpense,listeditoid_${targetLineOid}.effortExpense_minute`,
      ) ?? "0",
      10,
    ) || 0;
  const currentDescription =
    taskMap.get(
      `${PSP_PREFIX},description,listeditoid_${targetLineOid}.description`,
    ) ?? "";

  const newHours = params.hours ?? currentHours;
  const newMinutes = params.minutes ?? currentMinutes;
  const newDescription = params.description ?? currentDescription;

  // A row created via the BCS UI can carry an explicit start/end time range
  // alongside its duration (bookEffort's own rows never set one). Changing
  // the duration without also reconciling that range would leave BCS with an
  // inconsistent entry, so reject rather than silently corrupt it.
  if (newHours !== currentHours || newMinutes !== currentMinutes) {
    const hasTimeRange = [
      `${PSP_PREFIX},effortStart,listeditoid_${targetLineOid}.effortStart_hour`,
      `${PSP_PREFIX},effortStart,listeditoid_${targetLineOid}.effortStart_minute`,
      `${PSP_PREFIX},effortEnd,listeditoid_${targetLineOid}.effortEnd_hour`,
      `${PSP_PREFIX},effortEnd,listeditoid_${targetLineOid}.effortEnd_minute`,
    ].some((key) => (taskMap.get(key) ?? "").trim() !== "");
    if (hasTimeRange) {
      throw new Error(
        `Task ${params.taskLineOid} has an explicit start/end time range that bcs_edit_effort does not maintain — changing the duration would leave the range inconsistent with it. Use bcs_delete_effort followed by bcs_book_effort instead.`,
      );
    }
  }

  const taskFieldKeys = new Set(taskFields.map(([name]) => name));
  const filteredFields = formFields.filter(
    ([name]) =>
      !name.includes("daytimerecordingAttendance,$new$") &&
      !taskFieldKeys.has(name),
  );
  const body = new URLSearchParams([...filteredFields, ...taskFields]);

  body.set(
    `${PSP_PREFIX},effortExpense,listeditoid_${targetLineOid}.effortExpense_hour`,
    String(newHours),
  );
  body.set(
    `${PSP_PREFIX},effortExpense,listeditoid_${targetLineOid}.effortExpense_minute`,
    String(newMinutes),
  );
  body.set(
    `${PSP_PREFIX},description,listeditoid_${targetLineOid}.description`,
    newDescription,
  );

  body.set("daytimerecording,Apply", "Speichern");
  body.set("PageForm,formChangedIndicator", "true");

  const url = `${config.BCS_URL}${PAGE_PATH}`;
  const response = await authenticatedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: config.BCS_URL,
      Referer: `${config.BCS_URL}${PAGE_PATH}?oid=${config.BCS_USER_OID}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to edit effort: ${response.status}`);
  }

  const responseHtml = await response.text();
  const responseMap = toFormMap(parseFormState(responseHtml));
  const afterHour = `${PSP_PREFIX},effortExpense,listeditoid_${params.projectOid}.effortExpense_hour`;
  const afterMin = `${PSP_PREFIX},effortExpense,listeditoid_${params.projectOid}.effortExpense_minute`;
  const projectTotal =
    (parseInt(responseMap.get(afterHour) ?? "0", 10) || 0) * 60 +
    (parseInt(responseMap.get(afterMin) ?? "0", 10) || 0);

  const expectedTotal =
    initialProjectTotal -
    (currentHours * 60 + currentMinutes) +
    (newHours * 60 + newMinutes);

  const bcsErrors = parseBcsErrors(responseHtml);
  const success = projectTotal === expectedTotal && bcsErrors.length === 0;

  log("api:edit", "save POST response", {
    status: response.status,
    finalUrl: response.url,
    redirected: response.redirected,
    currentTotal: currentHours * 60 + currentMinutes,
    expectedTotal,
    projectTotal,
    bcsErrors,
  });

  const projects = parseProjectAggregates(responseHtml);
  let error: string | undefined;
  if (!success) {
    error =
      bcsErrors.length > 0
        ? bcsErrors.join(" ")
        : `BCS accepted the POST (status ${response.status}) but the project aggregate does not match the expected total (booked ${Math.floor(projectTotal / 60)}h${projectTotal % 60}m, expected ${Math.floor(expectedTotal / 60)}h${expectedTotal % 60}m).`;
  }
  return { success, projects, error };
}

export async function bookEffort(params: {
  date: string;
  projectOid: string;
  taskLineOid: string;
  hours: number;
  minutes: number;
  description: string;
}): Promise<{ success: boolean; projects: ProjectAggregate[]; error?: string }> {
  const config = getConfig();

  // Step 1: GET page to obtain form state
  const html = await fetchDayPage(params.date);
  const formFields = parseFormState(html);
  const formMap = toFormMap(formFields);

  // Verify project exists
  const typeKey = `${PSP_PREFIX},recordType,listeditoid_${params.projectOid}.recordType`;
  if (formMap.get(typeKey) !== "project") {
    throw new Error(
      `Project OID ${params.projectOid} not found. Available: ${getAvailableTaskOids(formMap).join(", ")}`,
    );
  }

  // Step 2: AJAX expand project to get task rows
  const { fields: taskFields } = await expandTreeNode(params.projectOid);
  const taskMap = toFormMap(taskFields);

  const taskLineOid = params.taskLineOid;
  const taskTypeKey = `${PSP_PREFIX},recordType,listeditoid_${taskLineOid}.recordType`;
  const taskFoundInExpand = taskMap.has(taskTypeKey);

  // If task OID not directly in expand, verify it via effortTargetOid on an effort entry
  if (!taskFoundInExpand) {
    const hasEffortForTask = [...taskMap.entries()].some(
      ([key, value]) =>
        key.endsWith(".effortTargetOid") && value === taskLineOid,
    );
    if (!hasEffortForTask) {
      const available = parseExpandedTasks(taskFields)
        .map((t) => `${t.lineOid} (target: ${t.recordOid})`)
        .join(", ");
      throw new Error(
        `Task ${taskLineOid} not found in project ${params.projectOid}. Available: ${available}`,
      );
    }
  }

  // Step 4: Merge page fields + expanded task fields, set values.
  // Filter out $new$ attendance rows to avoid unintended entries.
  // Also filter out any page fields that overlap with expanded task fields —
  // BCS remembers tree expansion server-side, so page HTML may already contain
  // the task fields that expandTreeNode also returns. Duplicates confuse BCS.
  const taskFieldKeys = new Set(taskFields.map(([name]) => name));
  const filteredFields = formFields.filter(
    ([name]) =>
      !name.includes("daytimerecordingAttendance,$new$") &&
      !taskFieldKeys.has(name),
  );
  const body = new URLSearchParams([...filteredFields, ...taskFields]);

  const taskRecordType = taskFoundInExpand
    ? taskMap.get(taskTypeKey)
    : undefined;
  if (taskFoundInExpand && taskRecordType === "neweffort") {
    // Path A: Empty task (no existing effort) — set values directly on the row.
    // This matches browser behavior: fill in the neweffort row and submit.
    const lid = `listeditoid_${taskLineOid}`;
    body.set(
      `${PSP_PREFIX},effortExpense,${lid}.effortExpense_hour`,
      String(params.hours),
    );
    body.set(
      `${PSP_PREFIX},effortExpense,${lid}.effortExpense_minute`,
      String(params.minutes),
    );
    body.set(
      `${PSP_PREFIX},description,${lid}.description`,
      params.description,
    );
  } else {
    // Path B: Existing effort — create $new$ row alongside it.
    // parentOid = effort OID (for _helper key).
    // actualTaskOid = task OID (for effortTargetOid on the $new$ row).
    let parentOid: string;
    let actualTaskOid: string;

    if (taskFoundInExpand) {
      // taskLineOid is an effort OID (recordType=effort)
      parentOid = taskLineOid;
      actualTaskOid =
        taskMap.get(
          `${PSP_PREFIX},effortTargetOid,listeditoid_${taskLineOid}.effortTargetOid`,
        ) ?? taskLineOid;
    } else {
      // taskLineOid is a task OID — find the effort entry via effortTargetOid
      const effortEntry = parseExpandedTasks(taskFields).find(
        (t) =>
          taskMap.get(
            `${PSP_PREFIX},effortTargetOid,listeditoid_${t.lineOid}.effortTargetOid`,
          ) === taskLineOid,
      );
      if (!effortEntry) {
        throw new Error(`No effort entry found targeting task ${taskLineOid}`);
      }
      parentOid = effortEntry.lineOid;
      actualTaskOid = taskLineOid;
    }

    const newOid = `$new$${Date.now()}_JTask`;
    const newLid = `listeditoid_${newOid}`;
    const [y, m, d] = params.date.split("-");
    const bcsDate = `${d}.${m}.${y}`;
    const col = (column: string, field: string) =>
      `${PSP_PREFIX},${column},${newLid}.${field}`;

    // _helper: append as SECOND entry under the effort OID key.
    // BCS needs both: original _helper (for existing effort) + this one (for $new$).
    const helperKey = `daytimerecording,Content,daytimerecordingPspTree,${parentOid}_helper`;
    const helperPrefix = `daytimerecording,Content,daytimerecordingPspTree`;

    const existingHelper = taskMap.get(helperKey);
    let lastUpdate: number = Date.now();
    let subtyp = "Personal";
    if (existingHelper) {
      try {
        const parsed = JSON.parse(existingHelper) as Record<string, unknown>;
        const luKey = `${helperPrefix},${parentOid}_lastUpdate`;
        if (typeof parsed[luKey] === "number") lastUpdate = parsed[luKey];
        const stKey = `${helperPrefix},${parentOid}_subtyp`;
        if (typeof parsed[stKey] === "string") subtyp = parsed[stKey];
      } catch {
        // ignore parse errors, use defaults
      }
    }

    const helperValue = JSON.stringify({
      [`${helperPrefix},Columns,effortEnd,${newLid}.effortEnd.islisteditable`]:
        "y",
      [`${helperPrefix},Columns,[plusminus],duplicateEffortRow,${newLid}.duplicateEffortRow.islisteditable`]:
        "y",
      [`${helperPrefix},Columns,[plusminus],[plusminus].islisteditable`]: "y",
      [`${helperPrefix},${parentOid}_lastUpdate`]: lastUpdate,
      [`${helperPrefix},${parentOid}_subtyp`]: subtyp,
      [`${helperPrefix},Columns,effortStart,${newLid}.effortStart.islisteditable`]:
        "y",
      [`${helperPrefix},Columns,description,${newLid}.description.islisteditable`]:
        "y",
      [`${helperPrefix},Columns,effortChargeability,${newLid}.effortChargeability.islisteditable`]:
        "y",
      [`${helperPrefix},Columns,SELECTION,${newLid}.SELECTION.islisteditable`]:
        "y",
      [`${helperPrefix},Columns,effortExpense,${newLid}.effortExpense.islisteditable`]:
        "y",
    });

    body.append(helperKey, helperValue);

    body.append(col("recordOid", "recordOid"), "");
    body.append(col("recordType", "recordType"), "unsavedeffort");
    body.append(col("recordDate", "recordDate"), bcsDate);
    body.append(col("recordUserOid", "recordUserOid"), config.BCS_USER_OID);
    body.append(col("effortTargetOid", "effortTargetOid"), actualTaskOid);
    body.append(
      col("effortUserGroupReference", "effortUserGroupReference"),
      "",
    );
    body.append(
      col("indicatorSumDedicatedExpense", "indicatorSumDedicatedExpense"),
      "0",
    );
    body.append(
      col("indicatorSumForecastExpense", "indicatorSumForecastExpense"),
      "",
    );
    body.append(col("effortStart", "effortStart_hour"), "");
    body.append(col("effortStart", "effortStart_minute"), "");
    body.append(col("effortEnd", "effortEnd_hour"), "");
    body.append(col("effortEnd", "effortEnd_minute"), "");
    body.append(
      col("effortExpense", "effortExpense_hour"),
      String(params.hours),
    );
    body.append(
      col("effortExpense", "effortExpense_minute"),
      String(params.minutes),
    );
    body.append(col("description", "description"), params.description);
    body.append(
      `${PSP_PREFIX},[plusminus],${newLid}.[plusminus].editable_children`,
      "duplicateEffortRow",
    );
    body.append(
      col("effortChargeability", "effortChargeability"),
      "effortIsChargable_true+effortIsShown_true",
    );
  }

  // Step 5: Submission flags
  body.set("daytimerecording,Apply", "Speichern");
  body.set("PageForm,formChangedIndicator", "true");

  // Step 6: POST
  const url = `${config.BCS_URL}${PAGE_PATH}`;
  const response = await authenticatedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: config.BCS_URL,
      Referer: `${config.BCS_URL}${PAGE_PATH}?oid=${config.BCS_USER_OID}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to book effort: ${response.status}`);
  }

  // Step 7: Verify by checking PSP tree aggregate in response
  const responseHtml = await response.text();
  const responseMap = toFormMap(parseFormState(responseHtml));
  const afterHour = `${PSP_PREFIX},effortExpense,listeditoid_${params.projectOid}.effortExpense_hour`;
  const afterMin = `${PSP_PREFIX},effortExpense,listeditoid_${params.projectOid}.effortExpense_minute`;
  const projectHours = parseInt(responseMap.get(afterHour) ?? "0", 10);
  const projectMinutes = parseInt(responseMap.get(afterMin) ?? "0", 10);
  const projectTotal = projectHours * 60 + projectMinutes;
  const requestedTotal = params.hours * 60 + params.minutes;

  // BCS returns 200 even when it rejects the save (e.g. the daily booking
  // deadline "Tagesbuchungsfrist" locks past days). It reports the reason in an
  // error message block; surface it instead of a bare success:false.
  const bcsErrors = parseBcsErrors(responseHtml);
  const success = projectTotal >= requestedTotal && bcsErrors.length === 0;

  log("api:book", "save POST response", {
    status: response.status,
    finalUrl: response.url,
    redirected: response.redirected,
    path: taskRecordType === "neweffort" ? "A/neweffort" : "B/unsavedeffort",
    requestedTotal,
    projectTotal,
    bcsErrors,
  });

  const projects = parseProjectAggregates(responseHtml);
  let error: string | undefined;
  if (!success) {
    error =
      bcsErrors.length > 0
        ? bcsErrors.join(" ")
        : `BCS accepted the POST (status ${response.status}) but the project aggregate did not increase (booked ${projectHours}h${projectMinutes}m, requested ${params.hours}h${params.minutes}m). BCS silently discarded the effort.`;
  }
  return { success, projects, error };
}

function findProjectForTask(
  formState: Map<string, string>,
  taskOid: string,
): string | undefined {
  // Project-level rows have recordType "project" and their listeditoid IS the project OID.
  // The taskOid can be a project OID directly or a line OID in the tree.
  for (const [key, value] of formState) {
    if (
      key.includes(`${PSP_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType") &&
      value === "project"
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      const lineOid = m?.[1];
      if (!lineOid) continue;
      if (lineOid === taskOid) return lineOid;
    }
  }
  return undefined;
}

function findTaskLineOid(
  taskFields: Map<string, string>,
  taskOid: string,
): string | undefined {
  // After AJAX expand, task rows appear with their own listeditoid.
  // Match by listeditoid directly or by recordOid value.
  for (const [key, value] of taskFields) {
    if (
      key.includes(`${PSP_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType")
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      const lineOid = m?.[1];
      if (!lineOid) continue;
      if (lineOid === taskOid) return lineOid;
    }
    if (
      key.includes(`${PSP_PREFIX},recordOid,listeditoid_`) &&
      key.endsWith(".recordOid") &&
      value === taskOid
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      if (m?.[1]) return m[1];
    }
  }
  return undefined;
}

function getAvailableTaskOids(formState: Map<string, string>): string[] {
  const oids: string[] = [];
  for (const [key, value] of formState) {
    if (
      key.includes(`${PSP_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType") &&
      value === "project"
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      if (m?.[1]) oids.push(m[1]);
    }
  }
  return oids;
}

// --- Overtime Balance ---

export interface OvertimeBalance {
  balanceMinutes: number;
  targetMinutes: number;
  actualMinutes: number;
  saldoMinutes: number;
  attendanceMinutes: number;
}

interface OvertimeDataPoint {
  orgKey: string;
  deputatSummaryEffortSum: string;
  deputatSummaryItem: string;
  datatype: string;
}

interface OvertimeLoadEvent {
  event: {
    data: OvertimeDataPoint[];
  };
}

interface OvertimeAjaxResponse {
  loadEvents: OvertimeLoadEvent[];
}

function parseOvertimeMinutes(
  data: OvertimeDataPoint[],
  orgKey: string,
): number {
  const point = data.find((d) => d.orgKey === orgKey);
  if (!point) return 0;
  return parseInt(point.deputatSummaryEffortSum, 10) || 0;
}

export async function getOvertimeBalance(): Promise<OvertimeBalance> {
  const config = getConfig();
  const params = new URLSearchParams({
    bcs_ajax_type: "2",
    "bcs_ajax_component": "mybcsboard,Content,overtimeDiagram",
    oid: config.BCS_USER_OID,
    "bcs_ajax_additional_param,ListDisplayAJAXTrigger": "LazyLoad",
    "mybcsboard,__componentTitleComposed": "true",
    AjaxRequestUniqueId: String(Date.now()),
  });

  const url = `${config.BCS_URL}${NOTIFICATION_PATH}?${params.toString()}`;
  log("api:fetch", "Fetching overtime balance", { userOid: config.BCS_USER_OID });
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch overtime balance: ${response.status}`);
  }

  const json = (await response.json()) as OvertimeAjaxResponse;
  const data = json.loadEvents?.[0]?.event?.data;
  if (!data || !Array.isArray(data)) {
    throw new Error("Overtime data not found in AJAX response");
  }

  log("api:parse", "Overtime data points", { count: data.length });

  return {
    balanceMinutes: parseOvertimeMinutes(data, "preliminaryFlexiAccBalance"),
    targetMinutes: parseOvertimeMinutes(data, "deputatSummaryTargetSumExpense"),
    actualMinutes: parseOvertimeMinutes(
      data,
      "deputatSummaryRealSumExpenseWithoutOvertime",
    ),
    saldoMinutes: parseOvertimeMinutes(
      data,
      "deputatSummarySaldoWithoutOvertime",
    ),
    attendanceMinutes: parseOvertimeMinutes(
      data,
      "deputatSummaryRealAttendanceWork",
    ),
  };
}

// --- Vacation Status ---

export interface AbsenceEntry {
  startDate: string;
  endDate: string;
  subject: string;
  type: string;
  workDays: number;
  status: string;
}

export interface VacationStatus {
  year: number;
  totalDays: number;
  baseDays: number;
  extraDays: number;
  carryoverDays: number;
  usedDays: number;
  plannedDays: number;
  requestedDays: number;
  approvedDays: number;
  availableDays: number;
  absences: AbsenceEntry[];
}

function parseGermanDecimal(value: string): number {
  return parseFloat(value.replace(",", ".")) || 0;
}

export function parseGermanDate(dateStr: string): string {
  const cleaned = dateStr.replace(/^[A-Za-z]+\.\s*/, "");
  const [day, month, yearPart] = cleaned.split(".");
  const year =
    yearPart && yearPart.length === 2 ? `20${yearPart}` : yearPart ?? "2000";
  return `${year}-${month?.padStart(2, "0")}-${day?.padStart(2, "0")}`;
}

export function parseAbsenceTable(html: string): AbsenceEntry[] {
  const root = parseHtml(html);
  const rows = root.querySelectorAll(
    "tr.selectableRow",
  );

  const absences: AbsenceEntry[] = [];
  for (const row of rows) {
    const startCell = row.querySelector("td[name='eventStartDate']");
    if (!startCell) continue;

    const endCell = row.querySelector("td[name='eventEndDate']");
    const oidCell = row.querySelector("td[name='oid']");
    const typeCell = row.querySelector("td[name='eventType']");
    const durationCell = row.querySelector(
      "td[name='vacationDurationInPeriod']",
    );
    const stateCell = row.querySelector("td[name='state']");

    const subject =
      oidCell?.querySelector("span")?.text?.trim() ?? "";
    const rawDays = durationCell?.getAttribute("data-value-to-sum");
    const workDays = rawDays ? parseFloat(rawDays) : 0;

    absences.push({
      startDate: parseGermanDate(startCell.text.trim()),
      endDate: parseGermanDate(endCell?.text?.trim() ?? startCell.text.trim()),
      subject,
      type: typeCell?.text?.trim() ?? "",
      workDays,
      status: stateCell?.text?.trim() ?? "",
    });
  }

  return absences;
}

export function parseVacationTable(
  html: string,
): Omit<VacationStatus, "absences"> {
  const root = parseHtml(html);

  const tables = root.querySelectorAll("table");
  let targetTable;
  for (const table of tables) {
    const thead = table.querySelector("thead");
    if (thead && thead.text.includes("Urlaubsbudget")) {
      targetTable = table;
      break;
    }
  }

  if (!targetTable) {
    throw new Error("Vacation budget table not found");
  }

  // Find the data row with a year value
  const rows = targetTable.querySelectorAll("tr");
  let dataRow;
  for (const row of rows) {
    const yearCell = row.querySelector("td[name='vacationYear']");
    if (yearCell && yearCell.text.trim()) {
      dataRow = row;
      break;
    }
  }

  if (!dataRow) {
    throw new Error("No vacation data row found");
  }

  const cell = (name: string): string =>
    dataRow.querySelector(`td[name='${name}']`)?.text?.trim() ?? "0";

  return {
    year: parseInt(cell("vacationYear"), 10) || 0,
    totalDays: parseGermanDecimal(cell("vacationIndicatorTotalBudget")),
    baseDays: parseGermanDecimal(cell("vacationBaseBudget")),
    extraDays: parseGermanDecimal(cell("vacationExtraBudget")),
    carryoverDays: parseGermanDecimal(cell("vacationRemainingBudget")),
    usedDays: parseGermanDecimal(
      cell("vacationIndicatorUsedRemainingBudget"),
    ),
    plannedDays: parseGermanDecimal(
      cell("appointmentIndicatorSumVacationDurationPlanned"),
    ),
    requestedDays: parseGermanDecimal(
      cell("appointmentIndicatorSumVacationDurationSubmitted"),
    ),
    approvedDays: parseGermanDecimal(
      cell("appointmentIndicatorVacationDurationApprovedAndTaken"),
    ),
    availableDays: parseGermanDecimal(
      cell("appointmentIndicatorRemainingVacationToday"),
    ),
  };
}

export async function getVacationStatus(
  year?: number,
): Promise<VacationStatus> {
  const config = getConfig();
  const params = new URLSearchParams({
    oid: config.BCS_USER_OID,
    "userbudgets,Choices,sourcechoice,tab": "budgets",
    "group,Choices,sourcechoice,tab": "vacationlist",
  });

  if (year) {
    const calState = `Y${year}0101`;
    params.set(
      "userbudgets,Choices,budgets,Selections,vacationYearInterval,__calendar_state",
      calState,
    );
    params.set(
      "group,Choices,vacationlist,Selections,dateRange,__calendar_state",
      calState,
    );
  }

  const url = `${config.BCS_URL}${VACATION_PATH}?${params.toString()}`;
  log("api:fetch", "Fetching vacation status", {
    userOid: config.BCS_USER_OID,
    year,
  });
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch vacation page: ${response.status}`);
  }

  const html = await response.text();
  log("api:fetch", "Vacation page received", { htmlLength: html.length });
  const budget = parseVacationTable(html);
  const absences = parseAbsenceTable(html);
  return { ...budget, absences };
}
