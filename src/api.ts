import { parse as parseHtml } from "node-html-parser";
import { authenticatedFetch, getConfig } from "./auth.js";

const PAGE_PATH = "/bcs/mybcs/dayeffortrecording/display";
const PSP_PREFIX = "daytimerecording,Content,daytimerecordingPspTree,Columns";
const EVENTS_PREFIX = "daytimerecording,Content,daytimerecordingEvents,Columns";

export interface BookingEntry {
  oid: string;
  taskOid: string;
  eventName: string;
  hours: number;
  minutes: number;
  description: string;
}

export interface TaskEntry {
  oid: string;
  name: string;
  recordType: string;
}

export interface DaySummary {
  totalHours: number;
  totalMinutes: number;
  entries: BookingEntry[];
  tasks: TaskEntry[];
  unbooked: { hours: number; minutes: number };
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

function toFormMap(fields: [string, string][]): Map<string, string> {
  return new Map(fields);
}

export function parseBookings(html: string): BookingEntry[] {
  const formState = toFormMap(parseFormState(html));
  const entries: BookingEntry[] = [];
  const seenOids = new Set<string>();

  // Primary: extract from Events table (actual effort entries)
  for (const [key, value] of formState) {
    if (
      key.includes(`${EVENTS_PREFIX},effortExpense,listeditoid_`) &&
      key.endsWith(".effortExpense_hour")
    ) {
      const oidMatch = /listeditoid_([^.]+)/.exec(key);
      const oid = oidMatch?.[1];
      if (!oid || seenOids.has(oid)) continue;
      seenOids.add(oid);

      const hours = parseInt(value, 10) || 0;
      const minuteKey = key.replace("_hour", "_minute");
      const minutes = parseInt(formState.get(minuteKey) ?? "0", 10) || 0;
      const descKey = `${EVENTS_PREFIX},description,listeditoid_${oid}.description`;
      const taskOidKey = `${EVENTS_PREFIX},effortTargetOid,listeditoid_${oid}.effortTargetOid`;
      const eventNameKey = `${EVENTS_PREFIX},effortEventRefOid.name,listeditoid_${oid}.effortEventRefOid.name`;

      entries.push({
        oid,
        taskOid: formState.get(taskOidKey) ?? "",
        eventName: formState.get(eventNameKey) ?? "",
        hours,
        minutes,
        description: formState.get(descKey) ?? "",
      });
    }
  }

  return entries;
}

export function parseTasks(html: string): TaskEntry[] {
  const formState = toFormMap(parseFormState(html));
  const tasks: TaskEntry[] = [];
  const seenOids = new Set<string>();

  // Extract from PSP tree form fields (listeditoid = line OID in the tree)
  for (const [key] of formState) {
    if (
      key.includes(`${PSP_PREFIX},recordType,listeditoid_`) &&
      key.endsWith(".recordType")
    ) {
      const oidMatch = /listeditoid_([^.]+)/.exec(key);
      const oid = oidMatch?.[1];
      if (!oid || seenOids.has(oid)) continue;
      seenOids.add(oid);

      const recordType = formState.get(key) ?? "";
      if (recordType === "root") continue;

      tasks.push({
        oid,
        name: oid,
        recordType,
      });
    }
  }

  // Fallback: extract from Page.registerProjectExpense
  if (tasks.length === 0) {
    const projectRegex =
      /Page\.registerProjectExpense\('[^']*listeditoid_([^.]+)\.effortExpense',\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = projectRegex.exec(html)) !== null) {
      const lineOid = m[1];
      const projectOid = m[2];
      if (!lineOid || !projectOid || seenOids.has(lineOid)) continue;
      seenOids.add(lineOid);

      tasks.push({
        oid: projectOid,
        name: projectOid,
        recordType: "project",
      });
    }
  }

  return tasks;
}

export async function getDaySummary(date: string): Promise<DaySummary> {
  const html = await fetchDayPage(date);
  const entries = parseBookings(html);
  const tasks = parseTasks(html);

  let totalMinutes = 0;
  for (const entry of entries) {
    totalMinutes += entry.hours * 60 + entry.minutes;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const targetMinutes = 8 * 60;
  const unbookedTotal = Math.max(0, targetMinutes - totalMinutes);

  return {
    totalHours,
    totalMinutes: remainingMinutes,
    entries,
    tasks,
    unbooked: {
      hours: Math.floor(unbookedTotal / 60),
      minutes: unbookedTotal % 60,
    },
  };
}

export async function getBookings(date: string): Promise<BookingEntry[]> {
  const html = await fetchDayPage(date);
  return parseBookings(html);
}

export async function getBookingTasks(date?: string): Promise<TaskEntry[]> {
  const today = date ?? new Date().toISOString().split("T")[0] ?? "";
  const html = await fetchDayPage(today);
  return parseTasks(html);
}

async function expandTreeNode(projectOid: string): Promise<[string, string][]> {
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

export async function bookEffort(params: {
  date: string;
  taskOid: string;
  hours: number;
  minutes: number;
  description: string;
}): Promise<{ success: boolean; entries: BookingEntry[] }> {
  const config = getConfig();

  // Step 1: GET page to obtain form state
  const html = await fetchDayPage(params.date);
  const formFields = parseFormState(html);
  const formMap = toFormMap(formFields);

  // Step 2: Find the project that contains the task, then expand it via AJAX
  const projectOid = findProjectForTask(formMap, params.taskOid);
  if (!projectOid) {
    throw new Error(
      `Task OID ${params.taskOid} not found on day page. Available: ${getAvailableTaskOids(formMap).join(", ")}`,
    );
  }

  const taskFields = await expandTreeNode(projectOid);
  const taskMap = toFormMap(taskFields);

  // Step 3: Find the task-level OID in the expanded tree
  const taskLineOid = findTaskLineOid(taskMap, params.taskOid);
  if (!taskLineOid) {
    throw new Error(
      `Task OID ${params.taskOid} not found in expanded tree for project ${projectOid}`,
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
  const afterHour = `${PSP_PREFIX},effortExpense,listeditoid_${projectOid}.effortExpense_hour`;
  const afterMin = `${PSP_PREFIX},effortExpense,listeditoid_${projectOid}.effortExpense_minute`;
  const projectHours = parseInt(responseMap.get(afterHour) ?? "0", 10);
  const projectMinutes = parseInt(responseMap.get(afterMin) ?? "0", 10);
  const projectTotal = projectHours * 60 + projectMinutes;
  const requestedTotal = params.hours * 60 + params.minutes;
  const success = projectTotal >= requestedTotal;

  const entries = parseBookings(responseHtml);
  return { success, entries };
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
