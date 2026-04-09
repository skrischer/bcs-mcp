import { authenticatedFetch, getConfig, refreshCsrfToken } from "./auth.js";

export interface BcsResponse<T> {
  ok: boolean;
  type: string;
  result: T;
  messages: unknown[];
  issues: unknown;
}

export class BcsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly messages: unknown[],
  ) {
    super(`BCS API error (status ${status}): ${JSON.stringify(messages)}`);
    this.name = "BcsApiError";
  }
}

export interface BookingEntry {
  oid: string;
  taskOid: string;
  taskName: string;
  effortExpense_hour: number;
  effortExpense_minute: number;
  description: string;
  [key: string]: unknown;
}

export interface BookingTask {
  oid: string;
  name: string;
  [key: string]: unknown;
}

export interface DaySummary {
  totalHours: number;
  totalMinutes: number;
  entries: BookingEntry[];
  unbooked: { hours: number; minutes: number };
}

async function bcsRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await authenticatedFetch(url, options);
  const body: unknown = await response.json();

  // Log first response for schema discovery
  console.error(
    `[BCS Response] ${options.method ?? "GET"} ${url}:`,
    JSON.stringify(body, null, 2),
  );

  if (typeof body !== "object" || body === null) {
    throw new BcsApiError(response.status, [
      { message: "Invalid response shape" },
    ]);
  }

  const envelope = body as Record<string, unknown>;

  if (envelope["ok"] === false) {
    const messages = Array.isArray(envelope["messages"])
      ? envelope["messages"]
      : [];
    throw new BcsApiError(response.status, messages);
  }

  return envelope["result"] as T;
}

export async function getBookings(date: string): Promise<BookingEntry[]> {
  const config = getConfig();
  const url = `${config.BCS_URL}/rest/frontend/timerecording/daybooking/bookings`;

  return bcsRequest<BookingEntry[]>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, oid: config.BCS_USER_OID }),
  });
}

export async function getBookingTasks(date?: string): Promise<BookingTask[]> {
  const config = getConfig();
  const params = new URLSearchParams({ oid: config.BCS_USER_OID });
  if (date) {
    params.set("date", date);
  }
  const url = `${config.BCS_URL}/rest/frontend/timerecording/daybooking/bookingTasks?${params.toString()}`;

  return bcsRequest<BookingTask[]>(url);
}

export async function bookEffort(params: {
  date: string;
  taskOid: string;
  hours: number;
  minutes: number;
  description: string;
}): Promise<unknown> {
  const config = getConfig();

  // Refresh CSRF token before booking
  await refreshCsrfToken();

  const url = `${config.BCS_URL}/rest/frontend/timerecording/daybooking/bookings`;

  return bcsRequest<unknown>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: params.date,
      oid: config.BCS_USER_OID,
      taskOid: params.taskOid,
      effortExpense_hour: params.hours,
      effortExpense_minute: params.minutes,
      description: params.description,
    }),
  });
}

export async function getDaySummary(date: string): Promise<DaySummary> {
  const entries = await getBookings(date);

  let totalMinutes = 0;
  for (const entry of entries) {
    totalMinutes += entry.effortExpense_hour * 60 + entry.effortExpense_minute;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const targetMinutes = 8 * 60;
  const unbookedTotal = Math.max(0, targetMinutes - totalMinutes);

  return {
    totalHours,
    totalMinutes: remainingMinutes,
    entries,
    unbooked: {
      hours: Math.floor(unbookedTotal / 60),
      minutes: unbookedTotal % 60,
    },
  };
}
