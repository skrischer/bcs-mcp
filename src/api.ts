import { parse as parseHtml } from "node-html-parser";
import { authenticatedFetch, getConfig } from "./auth.js";

const PAGE_PATH = "/bcs/mybcs/dayeffortrecording/display";
const PSP_PREFIX = "daytimerecording,Content,daytimerecordingPspTree,Columns";
// BCS misspells "attendance" as "attandence" in all field names
const ATTENDANCE_PREFIX =
  "daytimerecording,Content,daytimerecordingAttendance,Columns";

export interface ProjectAggregate {
  projectOid: string;
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

export function parseProjectAggregates(html: string): ProjectAggregate[] {
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
        hours: parseInt(formState.get(hourKey) ?? "0", 10) || 0,
        minutes: parseInt(formState.get(minKey) ?? "0", 10) || 0,
      });
    }
  }

  return projects;
}

export function parseExpandedTasks(fields: [string, string][]): TaskDetail[] {
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
  const projects = parseProjectAggregates(html);

  let bookedTotal = 0;
  for (const p of projects) {
    bookedTotal += p.hours * 60 + p.minutes;
  }

  let workingMinutes = 0;
  for (const a of attendance) {
    if (a.recordType === "unsavedAttendance") {
      workingMinutes += a.durationHour * 60 + a.durationMinute;
    } else if (a.recordType === "unsavedPause") {
      workingMinutes -= a.durationHour * 60 + a.durationMinute;
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

  const taskFields = await expandTreeNode(projectOid);
  return parseExpandedTasks(taskFields);
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
  const formMap = toFormMap(formFields);

  // Find $new$ attendance OID
  let attendanceOid: string | undefined;
  let pauseOid: string | undefined;
  for (const [key, value] of formMap) {
    if (
      key.includes(`${ATTENDANCE_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType") &&
      key.includes("$new$")
    ) {
      const m = /listeditoid_([^.]+)/.exec(key);
      if (!m?.[1]) continue;
      if (value === "unsavedAttendance") attendanceOid = m[1];
      if (value === "unsavedPause") pauseOid = m[1];
    }
  }

  if (!attendanceOid) {
    throw new Error("No $new$ attendance row found on page");
  }

  // Filter out $new$ attendance rows we don't want to submit
  const keepOids = new Set<string>([attendanceOid]);
  if (pauseOid && (params.pauseHour || params.pauseMinute)) {
    keepOids.add(pauseOid);
  }

  const filteredFields = formFields.filter(([name]) => {
    if (!name.includes("daytimerecordingAttendance,$new$")) return true;
    return [...keepOids].some((oid) => name.includes(oid));
  });

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

  // Set pause if provided
  if (pauseOid && (params.pauseHour || params.pauseMinute)) {
    setField(
      pauseOid,
      "attandenceDuration_hour",
      String(params.pauseHour ?? 0),
    );
    setField(
      pauseOid,
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

export async function expandTreeNode(
  projectOid: string,
): Promise<[string, string][]> {
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
  if (!data || typeof data !== "object" || !("html" in data)) return [];
  const html = (data as { html: string }).html;
  return parseFormState(`<form>${html}</form>`);
}

export async function deleteEffort(params: {
  date: string;
  projectOid: string;
  taskLineOid: string;
}): Promise<{ success: boolean; projects: ProjectAggregate[] }> {
  const config = getConfig();
  const html = await fetchDayPage(params.date);
  const formFields = parseFormState(html);

  const taskFields = await expandTreeNode(params.projectOid);
  const taskMap = toFormMap(taskFields);

  const taskLineOid = params.taskLineOid;
  const taskTypeKey = `${PSP_PREFIX},recordType,listeditoid_${taskLineOid}.recordType`;
  if (!taskMap.has(taskTypeKey)) {
    throw new Error(
      `Task ${taskLineOid} not found in project ${params.projectOid}`,
    );
  }

  const filteredFields = formFields.filter(
    ([name]) => !name.includes("daytimerecordingAttendance,$new$"),
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
  const taskFields = await expandTreeNode(params.projectOid);
  const taskMap = toFormMap(taskFields);

  // Verify task exists in expanded tree
  const taskLineOid = params.taskLineOid;
  const taskTypeKey = `${PSP_PREFIX},recordType,listeditoid_${taskLineOid}.recordType`;
  if (!taskMap.has(taskTypeKey)) {
    const available = parseExpandedTasks(taskFields)
      .map((t) => t.lineOid)
      .join(", ");
    throw new Error(
      `Task ${taskLineOid} not found in project ${params.projectOid}. Available: ${available}`,
    );
  }

  // Step 4: Merge page fields + expanded task fields, set values.
  // Filter out $new$ attendance rows to avoid creating unintended attendance entries.
  const filteredFields = formFields.filter(
    ([name]) => !name.includes("daytimerecordingAttendance,$new$"),
  );
  const body = new URLSearchParams([...filteredFields, ...taskFields]);

  const hourKey = `${PSP_PREFIX},effortExpense,listeditoid_${taskLineOid}.effortExpense_hour`;
  const minuteKey = `${PSP_PREFIX},effortExpense,listeditoid_${taskLineOid}.effortExpense_minute`;
  body.set(hourKey, String(params.hours));
  body.set(minuteKey, String(params.minutes));

  const descKey = `${PSP_PREFIX},description,listeditoid_${taskLineOid}.description`;
  if (taskMap.has(descKey)) {
    body.set(descKey, params.description);
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
