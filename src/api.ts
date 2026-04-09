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

export function parseFormState(html: string): Map<string, string> {
  const root = parseHtml(html);
  const fields = new Map<string, string>();

  for (const el of root.querySelectorAll("input[name]")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const type = el.getAttribute("type")?.toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (el.getAttribute("checked") !== null) {
        fields.set(name, el.getAttribute("value") ?? "on");
      }
    } else {
      fields.set(name, el.getAttribute("value") ?? "");
    }
  }

  for (const el of root.querySelectorAll("textarea[name]")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    fields.set(name, el.text ?? "");
  }

  for (const el of root.querySelectorAll("select[name]")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const selected = el.querySelector("option[selected]");
    fields.set(name, selected?.getAttribute("value") ?? "");
  }

  return fields;
}

export function parseBookings(html: string): BookingEntry[] {
  const formState = parseFormState(html);
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
  const formState = parseFormState(html);
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
  const formState = parseFormState(html);

  // Step 2: Find the matching line OID for the task
  const lineOid = findLineOidForTask(formState, params.taskOid);
  if (!lineOid) {
    throw new Error(
      `Task OID ${params.taskOid} not found on day page. Available tasks: ${getAvailableTaskOids(formState).join(", ")}`,
    );
  }

  // Step 3: Set effort fields
  const hourKey = `${PSP_PREFIX},effortExpense,listeditoid_${lineOid}.effortExpense_hour`;
  const minuteKey = `${PSP_PREFIX},effortExpense,listeditoid_${lineOid}.effortExpense_minute`;
  const descKey = `${PSP_PREFIX},description,listeditoid_${lineOid}.description`;

  formState.set(hourKey, String(params.hours));
  formState.set(minuteKey, String(params.minutes));
  formState.set(descKey, params.description);

  // Step 4: Set form submission flags
  formState.set("daytimerecording,formsubmitted", "true");

  // Step 5: POST the form
  const body = new URLSearchParams();
  for (const [key, value] of formState) {
    body.set(key, value);
  }

  const url = `${config.BCS_URL}${PAGE_PATH}`;
  const response = await authenticatedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to book effort: ${response.status}`);
  }

  // Step 6: Parse response to verify booking
  const responseHtml = await response.text();
  const entries = parseBookings(responseHtml);

  const bookedEntry = entries.find(
    (e) => e.oid === lineOid || e.taskOid === params.taskOid,
  );
  const success =
    bookedEntry !== undefined &&
    bookedEntry.hours === params.hours &&
    bookedEntry.minutes === params.minutes;

  return { success, entries };
}

function findLineOidForTask(
  formState: Map<string, string>,
  taskOid: string,
): string | undefined {
  // The taskOid might be the recordOid value or the listeditoid key itself
  for (const [key, value] of formState) {
    if (
      key.includes(`${PSP_PREFIX},recordOid,listeditoid_`) &&
      key.endsWith(".recordOid")
    ) {
      const lineMatch = /listeditoid_([^.]+)/.exec(key);
      const lineOid = lineMatch?.[1];
      if (!lineOid) continue;

      // Match by recordOid value
      if (value === taskOid) return lineOid;
      // Match by line OID directly
      if (lineOid === taskOid) return lineOid;
    }
  }
  return undefined;
}

function getAvailableTaskOids(formState: Map<string, string>): string[] {
  const oids: string[] = [];
  for (const [key, value] of formState) {
    if (
      key.includes(`${PSP_PREFIX},recordOid,listeditoid_`) &&
      key.endsWith(".recordOid") &&
      value
    ) {
      oids.push(value);
    }
  }
  return oids;
}
