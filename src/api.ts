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

  // Use saved attendance OID if available, otherwise $new$
  const attendanceOid =
    savedAttendance.length > 0 ? savedAttendance[0]!.oid : newAttendanceOid;

  if (!attendanceOid) {
    throw new Error("No attendance row found on page");
  }

  // Filter out ALL $new$ attendance rows when updating existing saved rows,
  // or keep only the ones we need when creating new
  let filteredFields: [string, string][];
  if (savedAttendance.length > 0) {
    filteredFields = formFields.filter(
      ([name]) => !name.includes("daytimerecordingAttendance,$new$"),
    );
  } else {
    const keepOids = new Set<string>([attendanceOid]);
    if (newPauseOid && (params.pauseHour || params.pauseMinute)) {
      keepOids.add(newPauseOid);
    }
    filteredFields = formFields.filter(([name]) => {
      if (!name.includes("daytimerecordingAttendance,$new$")) return true;
      return [...keepOids].some((oid) => name.includes(oid));
    });
  }

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

  if (newPauseOid && (params.pauseHour || params.pauseMinute)) {
    setField(
      newPauseOid,
      "attandenceDuration",
      "attandenceDuration_hour",
      String(params.pauseHour ?? 0),
    );
    setField(
      newPauseOid,
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

  const taskLineOid = params.taskLineOid;
  const taskTypeKey = `${PSP_PREFIX},recordType,listeditoid_${taskLineOid}.recordType`;
  if (!taskMap.has(taskTypeKey)) {
    throw new Error(
      `Task ${taskLineOid} not found in project ${params.projectOid}`,
    );
  }

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
    const key = `${PSP_PREFIX},${col},listeditoid_${taskLineOid}.${field}`;
    body.set(key, "");
  }
  const descKey = `${PSP_PREFIX},description,listeditoid_${taskLineOid}.description`;
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
  const remaining =
    (parseInt(responseMap.get(afterHour) ?? "0", 10) || 0) * 60 +
    (parseInt(responseMap.get(afterMin) ?? "0", 10) || 0);

  return {
    success: remaining === 0,
    projects: parseProjectAggregates(responseHtml),
  };
}

export async function bookEffort(params: {
  date: string;
  projectOid: string;
  taskLineOid: string;
  hours: number;
  minutes: number;
  description: string;
}): Promise<{ success: boolean; projects: ProjectAggregate[] }> {
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
  const success = projectTotal >= requestedTotal;

  const projects = parseProjectAggregates(responseHtml);
  return { success, projects };
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
}

function parseGermanDecimal(value: string): number {
  return parseFloat(value.replace(",", ".")) || 0;
}

export function parseVacationTable(html: string): VacationStatus {
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

export async function getVacationStatus(): Promise<VacationStatus> {
  const config = getConfig();
  const params = new URLSearchParams({
    oid: config.BCS_USER_OID,
    "userbudgets,Choices,sourcechoice,tab": "budgets",
    "group,Choices,sourcechoice,tab": "vacationlist",
  });

  const url = `${config.BCS_URL}${VACATION_PATH}?${params.toString()}`;
  log("api:fetch", "Fetching vacation status", {
    userOid: config.BCS_USER_OID,
  });
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch vacation page: ${response.status}`);
  }

  const html = await response.text();
  log("api:fetch", "Vacation page received", { htmlLength: html.length });
  return parseVacationTable(html);
}
