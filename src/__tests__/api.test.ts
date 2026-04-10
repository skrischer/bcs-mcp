import { describe, it, expect } from "vitest";
import {
  parseFormState,
  parseAttendance,
  parseProjectAggregates,
  parseExpandedTasks,
  parsePspTreeNames,
  getWeekDates,
} from "../api.js";

const SAMPLE_HTML = `
<html><body>
<form>
  <input type="hidden" name="transactionId" value="123-abc">
  <input type="hidden" name="daytimerecording,formsubmitted" value="">
  <input type="hidden" name="daytimerecording,Selections,effortRecordingDate,__calendar_state" value="D20260409">

  <!-- Attendance: existing row -->
  <input type="hidden" name="daytimerecording,Content,daytimerecordingAttendance,Columns,recordType,listeditoid_ATT1.recordType" value="unsavedAttendance">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceStart_hour,listeditoid_ATT1.attandenceStart_hour" value="8">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceStart_minute,listeditoid_ATT1.attandenceStart_minute" value="00">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceEnd_hour,listeditoid_ATT1.attandenceEnd_hour" value="17">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceEnd_minute,listeditoid_ATT1.attandenceEnd_minute" value="00">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceDuration_hour,listeditoid_ATT1.attandenceDuration_hour" value="9">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceDuration_minute,listeditoid_ATT1.attandenceDuration_minute" value="00">

  <!-- Attendance: $new$ row (should be skipped by parseAttendance) -->
  <input type="hidden" name="daytimerecording,Content,daytimerecordingAttendance,Columns,recordType,listeditoid_$new$1234_JTimeSpan.recordType" value="unsavedAttendance">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceStart_hour,listeditoid_$new$1234_JTimeSpan.attandenceStart_hour" value="">
  <input type="text" name="daytimerecording,Content,daytimerecordingAttendance,Columns,attandenceStart_minute,listeditoid_$new$1234_JTimeSpan.attandenceStart_minute" value="">

  <!-- Attendance: $new$ pause row -->
  <input type="hidden" name="daytimerecording,Content,daytimerecordingAttendance,Columns,recordType,listeditoid_$new$5678_JTimeSpan.recordType" value="unsavedPause">

  <!-- PSP Tree: projects (each row has hidden inputs + visible name in nested table) -->
  <table><tbody>
  <tr>
    <td><input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_USER1.recordOid" value="USER1">
    <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_USER1.recordType" value="root"></td>
    <td></td><td></td>
    <td><table><tbody><tr><td></td><td><table><tbody><tr><td><a><span>Max Mustermann</span></a></td></tr></tbody></table></td></tr></tbody></table></td>
  </tr>
  <tr>
    <td><input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_PROJ1.recordOid" value="PROJ1">
    <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_PROJ1.recordType" value="project">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ1.effortExpense_hour" value="4">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ1.effortExpense_minute" value="30"></td>
    <td></td><td></td>
    <td><table><tbody><tr><td></td><td><table><tbody><tr><td><a><span>Akquise</span></a></td></tr></tbody></table></td></tr></tbody></table></td>
  </tr>
  <tr>
    <td><input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_PROJ2.recordOid" value="PROJ2">
    <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_PROJ2.recordType" value="project">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ2.effortExpense_hour" value="0">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ2.effortExpense_minute" value="0"></td>
    <td></td><td></td>
    <td><table><tbody><tr><td></td><td><table><tbody><tr><td><a><span>Internes Projekt</span></a></td></tr></tbody></table></td></tr></tbody></table></td>
  </tr>
  </tbody></table>

  <select name="someSetting">
    <option value="a">A</option>
    <option value="b" selected>B</option>
  </select>
</form>
</body></html>
`;

// Simulates AJAX HTML returned by expandTreeNode (wrapped in <form>)
const EXPANDED_TASK_HTML = `<form>
<table><tbody>
<tr>
  <td>
    <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_TASK1.recordType" value="effort">
    <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_TASK1.recordOid" value="TASK1_RECORD">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_TASK1.effortExpense_hour" value="2">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_TASK1.effortExpense_minute" value="15">
    <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,description,listeditoid_TASK1.description" value="JIRA-42">
  </td>
  <td></td><td></td>
  <td><table><tbody><tr><td></td><td><table><tbody><tr><td><a><span>Neukundenakquise</span></a></td></tr></tbody></table></td></tr></tbody></table></td>
</tr>
</tbody></table>
</form>`;

// Flat field pairs (extracted from EXPANDED_TASK_HTML by parseFormState)
const EXPANDED_TASK_FIELDS: [string, string][] = [
  [
    "daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_TASK1.recordType",
    "effort",
  ],
  [
    "daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_TASK1.recordOid",
    "TASK1_RECORD",
  ],
  [
    "daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_TASK1.effortExpense_hour",
    "2",
  ],
  [
    "daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_TASK1.effortExpense_minute",
    "15",
  ],
  [
    "daytimerecording,Content,daytimerecordingPspTree,Columns,description,listeditoid_TASK1.description",
    "JIRA-42",
  ],
];

describe("api", () => {
  describe("parseFormState", () => {
    it("extracts all input, textarea, and select fields", () => {
      const state = new Map(parseFormState(SAMPLE_HTML));
      expect(state.get("transactionId")).toBe("123-abc");
      expect(state.get("daytimerecording,formsubmitted")).toBe("");
      expect(state.get("someSetting")).toBe("b");
    });

    it("returns empty array for empty html", () => {
      const state = parseFormState("<html><body></body></html>");
      expect(state).toHaveLength(0);
    });

    it("preserves duplicate field names", () => {
      const html = `<html><body><form>
        <input name="dup" value="first">
        <input name="dup" value="second">
      </form></body></html>`;
      const state = parseFormState(html);
      const dups = state.filter(([k]) => k === "dup");
      expect(dups).toHaveLength(2);
      expect(dups[0]?.[1]).toBe("first");
      expect(dups[1]?.[1]).toBe("second");
    });
  });

  describe("parseAttendance", () => {
    it("extracts existing attendance rows", () => {
      const entries = parseAttendance(SAMPLE_HTML);
      expect(entries).toHaveLength(1);
      const att = entries[0]!;
      expect(att.oid).toBe("ATT1");
      expect(att.startHour).toBe(8);
      expect(att.startMinute).toBe(0);
      expect(att.endHour).toBe(17);
      expect(att.endMinute).toBe(0);
      expect(att.durationHour).toBe(9);
      expect(att.durationMinute).toBe(0);
      expect(att.recordType).toBe("unsavedAttendance");
    });

    it("skips $new$ rows", () => {
      const entries = parseAttendance(SAMPLE_HTML);
      const newRows = entries.filter((e) => e.oid.includes("$new$"));
      expect(newRows).toHaveLength(0);
    });

    it("returns empty array for html without attendance", () => {
      const entries = parseAttendance("<html><body></body></html>");
      expect(entries).toHaveLength(0);
    });
  });

  describe("parsePspTreeNames", () => {
    it("extracts project names from PSP tree rows", () => {
      const names = parsePspTreeNames(SAMPLE_HTML);
      expect(names.get("PROJ1")).toBe("Akquise");
      expect(names.get("PROJ2")).toBe("Internes Projekt");
    });

    it("extracts root row name", () => {
      const names = parsePspTreeNames(SAMPLE_HTML);
      expect(names.get("USER1")).toBe("Max Mustermann");
    });

    it("extracts task names from AJAX expand HTML", () => {
      const names = parsePspTreeNames(EXPANDED_TASK_HTML);
      expect(names.get("TASK1")).toBe("Neukundenakquise");
    });

    it("returns empty map for html without PSP tree", () => {
      const names = parsePspTreeNames("<html><body></body></html>");
      expect(names.size).toBe(0);
    });
  });

  describe("parseProjectAggregates", () => {
    it("extracts project aggregates with names from PSP tree", () => {
      const names = parsePspTreeNames(SAMPLE_HTML);
      const projects = parseProjectAggregates(SAMPLE_HTML, names);
      expect(projects).toHaveLength(2);

      const proj1 = projects.find((p) => p.projectOid === "PROJ1");
      expect(proj1).toBeDefined();
      expect(proj1?.name).toBe("Akquise");
      expect(proj1?.hours).toBe(4);
      expect(proj1?.minutes).toBe(30);

      const proj2 = projects.find((p) => p.projectOid === "PROJ2");
      expect(proj2?.name).toBe("Internes Projekt");
      expect(proj2?.hours).toBe(0);
      expect(proj2?.minutes).toBe(0);
    });

    it("falls back to OID when no names provided", () => {
      const projects = parseProjectAggregates(SAMPLE_HTML);
      const proj1 = projects.find((p) => p.projectOid === "PROJ1");
      expect(proj1?.name).toBe("PROJ1");
    });

    it("skips root rows", () => {
      const projects = parseProjectAggregates(SAMPLE_HTML);
      const root = projects.find((p) => p.projectOid === "USER1");
      expect(root).toBeUndefined();
    });

    it("returns empty array for empty html", () => {
      const projects = parseProjectAggregates("<html><body></body></html>");
      expect(projects).toHaveLength(0);
    });
  });

  describe("parseExpandedTasks", () => {
    it("extracts tasks with names from expanded tree", () => {
      const names = parsePspTreeNames(EXPANDED_TASK_HTML);
      const tasks = parseExpandedTasks(EXPANDED_TASK_FIELDS, names);
      expect(tasks).toHaveLength(1);

      const task = tasks[0]!;
      expect(task.lineOid).toBe("TASK1");
      expect(task.name).toBe("Neukundenakquise");
      expect(task.recordOid).toBe("TASK1_RECORD");
      expect(task.hours).toBe(2);
      expect(task.minutes).toBe(15);
      expect(task.description).toBe("JIRA-42");
      expect(task.recordType).toBe("effort");
    });

    it("falls back to lineOid when no names provided", () => {
      const tasks = parseExpandedTasks(EXPANDED_TASK_FIELDS);
      expect(tasks[0]?.name).toBe("TASK1");
    });

    it("returns empty array for empty fields", () => {
      const tasks = parseExpandedTasks([]);
      expect(tasks).toHaveLength(0);
    });
  });

  describe("getWeekDates", () => {
    it("returns Mon-Fri for a Wednesday", () => {
      const dates = getWeekDates("2026-04-08"); // Wednesday
      expect(dates).toEqual([
        "2026-04-06",
        "2026-04-07",
        "2026-04-08",
        "2026-04-09",
        "2026-04-10",
      ]);
    });

    it("returns Mon-Fri for a Monday", () => {
      const dates = getWeekDates("2026-04-06"); // Monday
      expect(dates[0]).toBe("2026-04-06");
      expect(dates[4]).toBe("2026-04-10");
    });

    it("returns Mon-Fri for a Sunday", () => {
      const dates = getWeekDates("2026-04-12"); // Sunday
      expect(dates[0]).toBe("2026-04-06");
      expect(dates[4]).toBe("2026-04-10");
    });
  });
});
