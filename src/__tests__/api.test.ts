import { describe, it, expect } from "vitest";
import { parseFormState, parseBookings, parseTasks } from "../api.js";

const SAMPLE_HTML = `
<html><body>
<form>
  <input type="hidden" name="transactionId" value="123-abc">
  <input type="hidden" name="daytimerecording,formsubmitted" value="">
  <input type="hidden" name="daytimerecording,Selections,effortRecordingDate,__calendar_state" value="D20260409">

  <!-- Events table: actual effort entries -->
  <input type="hidden" name="daytimerecording,Content,daytimerecordingEvents,Columns,recordOid,listeditoid_EFFORT1.recordOid" value="EFFORT1">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingEvents,Columns,recordType,listeditoid_EFFORT1.recordType" value="effort">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingEvents,Columns,effortTargetOid,listeditoid_EFFORT1.effortTargetOid" value="TASK_OID_1">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingEvents,Columns,effortEventRefOid.name,listeditoid_EFFORT1.effortEventRefOid.name" value="Entwicklung">
  <input type="text" name="daytimerecording,Content,daytimerecordingEvents,Columns,effortExpense,listeditoid_EFFORT1.effortExpense_hour" value="4">
  <input type="text" name="daytimerecording,Content,daytimerecordingEvents,Columns,effortExpense,listeditoid_EFFORT1.effortExpense_minute" value="30">
  <textarea name="daytimerecording,Content,daytimerecordingEvents,Columns,description,listeditoid_EFFORT1.description">HYBRIS-1234</textarea>

  <!-- PSP Tree: projects for booking -->
  <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_USER1.recordOid" value="USER1">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_USER1.recordType" value="root">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_PROJ1.recordOid" value="PROJ1">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_PROJ1.recordType" value="project">
  <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ1.effortExpense_hour" value="4">
  <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ1.effortExpense_minute" value="30">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordOid,listeditoid_PROJ2.recordOid" value="PROJ2">
  <input type="hidden" name="daytimerecording,Content,daytimerecordingPspTree,Columns,recordType,listeditoid_PROJ2.recordType" value="project">
  <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ2.effortExpense_hour" value="0">
  <input type="text" name="daytimerecording,Content,daytimerecordingPspTree,Columns,effortExpense,listeditoid_PROJ2.effortExpense_minute" value="0">

  <select name="someSetting">
    <option value="a">A</option>
    <option value="b" selected>B</option>
  </select>
</form>
<script>
  Page.registerProjectExpense('x,listeditoid_PROJ1.effortExpense', 'PROJ1', 270);
  Page.registerProjectExpense('x,listeditoid_PROJ2.effortExpense', 'PROJ2', 0);
</script>
</body></html>
`;

describe("api", () => {
  describe("parseFormState", () => {
    it("extracts all input, textarea, and select fields", () => {
      const state = parseFormState(SAMPLE_HTML);

      expect(state.get("transactionId")).toBe("123-abc");
      expect(state.get("daytimerecording,formsubmitted")).toBe("");
      expect(state.get("someSetting")).toBe("b");
    });

    it("extracts textarea content", () => {
      const state = parseFormState(SAMPLE_HTML);
      const descKey =
        "daytimerecording,Content,daytimerecordingEvents,Columns,description,listeditoid_EFFORT1.description";
      expect(state.get(descKey)).toBe("HYBRIS-1234");
    });

    it("returns empty map for empty html", () => {
      const state = parseFormState("<html><body></body></html>");
      expect(state.size).toBe(0);
    });
  });

  describe("parseBookings", () => {
    it("extracts bookings from Events table fields", () => {
      const entries = parseBookings(SAMPLE_HTML);

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry?.oid).toBe("EFFORT1");
      expect(entry?.taskOid).toBe("TASK_OID_1");
      expect(entry?.eventName).toBe("Entwicklung");
      expect(entry?.hours).toBe(4);
      expect(entry?.minutes).toBe(30);
      expect(entry?.description).toBe("HYBRIS-1234");
    });

    it("returns empty array for html without events", () => {
      const entries = parseBookings("<html><body></body></html>");
      expect(entries).toHaveLength(0);
    });
  });

  describe("parseTasks", () => {
    it("extracts projects from PSP tree form fields", () => {
      const tasks = parseTasks(SAMPLE_HTML);

      expect(tasks.length).toBe(2);
      const proj1 = tasks.find((t) => t.oid === "PROJ1");
      expect(proj1).toBeDefined();
      expect(proj1?.recordType).toBe("project");
    });

    it("skips root nodes", () => {
      const tasks = parseTasks(SAMPLE_HTML);
      const root = tasks.find((t) => t.oid === "USER1");
      expect(root).toBeUndefined();
    });

    it("falls back to registerProjectExpense when no form tasks", () => {
      const htmlNoForm = `
        <html><body>
        <script>
          Page.registerProjectExpense('x,listeditoid_P1.effortExpense', 'PROJECT_1', 0);
          Page.registerProjectExpense('x,listeditoid_P2.effortExpense', 'PROJECT_2', 120);
        </script>
        </body></html>
      `;
      const tasks = parseTasks(htmlNoForm);
      expect(tasks.length).toBe(2);
      expect(tasks.map((t) => t.oid)).toContain("PROJECT_1");
      expect(tasks.map((t) => t.oid)).toContain("PROJECT_2");
    });
  });
});
