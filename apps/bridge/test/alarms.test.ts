import { describe, expect, it } from "vitest";
import { controlUrlForService, eventUrlForService } from "../src/sonosSoap.js";
import { decodeRecurrence, encodeRecurrence, formatClock, normalizeClock, parseAlarmList, programOfUri } from "../src/sonosService.js";

describe("alarm helpers", () => {
  it("wires AlarmClock control/event URLs", () => {
    expect(controlUrlForService("AlarmClock")).toBe("/AlarmClock/Control");
    expect(eventUrlForService("AlarmClock")).toBe("/AlarmClock/Event");
  });

  it("round-trips recurrence presets and custom days", () => {
    for (const r of ["once", "daily", "weekdays", "weekends"] as const) {
      expect(decodeRecurrence(encodeRecurrence(r))).toBe(r);
    }
    expect(encodeRecurrence({ days: [1, 3, 5] })).toBe("ON_135");
    expect(encodeRecurrence({ days: [5, 1, 1, 3] })).toBe("ON_135"); // sorted + deduped
    expect(decodeRecurrence("ON_135")).toEqual({ days: [1, 3, 5] });
    expect(decodeRecurrence(undefined)).toBe("once");
    expect(decodeRecurrence("SOMETHING_NEW")).toBe("once"); // unknown → safe default
  });

  it("formats and normalizes clock strings", () => {
    expect(formatClock(7200)).toBe("02:00:00");
    expect(formatClock(90)).toBe("00:01:30");
    expect(normalizeClock("7:5")).toBe("07:05:00");
    expect(normalizeClock("07:30")).toBe("07:30:00");
  });

  it("derives program from a ProgramURI", () => {
    expect(programOfUri("x-rincon-buzzer:0")).toBe("chime");
    expect(programOfUri("x-rincon-queue:RINCON_ABC#0")).toBe("queue");
    expect(programOfUri("x-sonosapi-radio:station")).toBe("other");
  });

  it("parses a self-closing alarm list", () => {
    const xml = `<Alarms>` +
      `<Alarm ID="7" StartTime="07:30:00" Duration="02:00:00" Recurrence="WEEKDAYS" Enabled="1" RoomUUID="RINCON_A" ProgramURI="x-rincon-buzzer:0" ProgramMetaData="" PlayMode="NORMAL" Volume="25" IncludeLinkedZones="0"/>` +
      `<Alarm ID="8" StartTime="09:00:00" Duration="01:00:00" Recurrence="ONCE" Enabled="0" RoomUUID="RINCON_B" ProgramURI="x-sonosapi-radio:abc?sid=1" ProgramMetaData="&lt;DIDL&gt;" PlayMode="SHUFFLE" Volume="150" IncludeLinkedZones="1"/>` +
      `</Alarms>`;
    const alarms = parseAlarmList(xml, new Map([["RINCON_A", "Kitchen"]]));
    expect(alarms).toHaveLength(2);

    expect(alarms[0]).toMatchObject({
      id: "7", startTime: "07:30:00", durationSeconds: 7200, recurrence: "weekdays",
      enabled: true, roomUuid: "RINCON_A", roomName: "Kitchen", program: "chime", volume: 25, includeLinkedZones: false
    });

    expect(alarms[1]).toMatchObject({
      id: "8", enabled: false, program: "other", recurrence: "once",
      programMetaData: "<DIDL>", // attrText decodes entities
      volume: 100, // clamped from 150
      includeLinkedZones: true
    });
    expect(alarms[1].roomName).toBeUndefined(); // room not in the map
  });
});
