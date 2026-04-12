import { parse as parseHtml } from "node-html-parser";
import { authenticatedFetch, getConfig } from "./auth.js";

const PAGE_PATH = "/bcs/mybcs/dayeffortrecording/display";
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

export interface DaySummary {
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

export async function fetchDayPage(date: string): Promise<string> {
  const config = getConfig();
  const dateParams = buildDateParams(date);
  const params = new URLSearchParams({
    ...dateParams,
    oid: config.BCS_USER_OID,
    transactionId: generateTransactionId(),
  });

  const url = `${config.BCS_URL}${PAGE_PATH}?${params.toString()}`;
  const response = await authenticatedFetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch day page: ${response.status}`);
  }

  return response.text();
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
  const formState = toFormMap(parseFormState(html));
  const entries: AttendanceEntry[] = [];
  const seenOids = new Set<string>();

  for (const [key, value] of formState) {
    if (
      key.includes(`${ATTENDANCE_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType")
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      const oid = m?.[1];
      if (!oid || seenOids.has(oid)) continue;
      if (oid.includes("$new$")) continue;
      seenOids.add(oid);

      const get = (field: string) =>
        parseInt(
          formState.get(
            `${ATTENDANCE_PREFIX},${field},listeditoid_${oid}.${field}`,
          ) ?? "0",
          10,
        ) || 0;

      entries.push({
        oid,
        startHour: get("attandenceStart_hour"),
        startMinute: get("attandenceStart_minute"),
        endHour: get("attandenceEnd_hour"),
        endMinute: get("attandenceEnd_minute"),
        durationHour: get("attandenceDuration_hour"),
        durationMinute: get("attandenceDuration_minute"),
        recordType: value,
      });
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

export async function getDaySummary(date: string): Promise<DaySummary> {
  const html = await fetchDayPage(date);
  const attendance = parseAttendance(html);
  const names = parsePspTreeNames(html);
  const projects = parseProjectAggregates(html, names);

  let bookedTotal = 0;
  for (const p of projects) {
    bookedTotal += p.hours * 60 + p.minutes;
  }

  let workingMinutes = 0;
  for (const a of attendance) {
    if (a.recordType === "unsavedPause") {
      workingMinutes -= a.durationHour * 60 + a.durationMinute;
    } else {
      // All non-pause types count as working time:
      // unsavedAttendance, distributed, undistributed, etc.
      workingMinutes += a.durationHour * 60 + a.durationMinute;
    }
  }

  const unbookedTotal = Math.max(0, workingMinutes - bookedTotal);

  return {
    attendance,
    projects,
    bookedHours: Math.floor(bookedTotal / 60),
    bookedMinutes: bookedTotal % 60,
    unbookedHours: Math.floor(unbookedTotal / 60),
    unbookedMinutes: unbookedTotal % 60,
  };
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

  // Check for existing saved attendance (non-$new$ rows)
  const existingAttendance = parseAttendance(html);

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

  // Use existing attendance OID if available, otherwise $new$
  const attendanceOid =
    existingAttendance.length > 0
      ? existingAttendance[0]!.oid
      : newAttendanceOid;

  if (!attendanceOid) {
    throw new Error("No attendance row found on page");
  }

  // Filter out ALL $new$ attendance rows when updating existing,
  // or keep only the ones we need when creating new
  let filteredFields: [string, string][];
  if (existingAttendance.length > 0) {
    // Existing attendance: filter out all $new$ rows
    filteredFields = formFields.filter(
      ([name]) => !name.includes("daytimerecordingAttendance,$new$"),
    );
  } else {
    // New attendance: keep only the OIDs we're using
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
  const setField = (oid: string, field: string, value: string) =>
    body.set(
      `${ATTENDANCE_PREFIX},${field},listeditoid_${oid}.${field}`,
      value,
    );

  setField(attendanceOid, "attandenceStart_hour", String(params.startHour));
  setField(
    attendanceOid,
    "attandenceStart_minute",
    String(params.startMinute).padStart(2, "0"),
  );
  setField(attendanceOid, "attandenceEnd_hour", String(params.endHour));
  setField(
    attendanceOid,
    "attandenceEnd_minute",
    String(params.endMinute).padStart(2, "0"),
  );

  // Set pause if provided (only for $new$ rows — existing pause handling TBD)
  if (newPauseOid && (params.pauseHour || params.pauseMinute)) {
    setField(
      newPauseOid,
      "attandenceDuration_hour",
      String(params.pauseHour ?? 0),
    );
    setField(
      newPauseOid,
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
