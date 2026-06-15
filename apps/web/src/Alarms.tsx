import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { Alarm, AlarmInput, AlarmProgram, AlarmRecurrence, SonosZone } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";

interface AlarmsProps {
  zones: SonosZone[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Alarms({ zones }: AlarmsProps) {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Alarm | "new" | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      setAlarms(await bridgeApi.alarms());
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alarms");
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mutate = useCallback(async (fn: () => Promise<Alarm[]>) => {
    setBusy(true);
    setError("");
    try {
      setAlarms(await fn());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = (alarm: Alarm) =>
    mutate(() => bridgeApi.updateAlarm(alarm.id, { ...alarmToInput(alarm), enabled: !alarm.enabled }));

  const submit = async (input: AlarmInput) => {
    const ok = await mutate(() => (editing === "new" || editing === null
      ? bridgeApi.createAlarm(input)
      : bridgeApi.updateAlarm(editing.id, input)));
    if (ok) setEditing(null);
  };

  return (
    <section className="queue-panel" aria-label="Alarms">
      <div className="section-heading">
        <h2>Alarms</h2>
        {editing === null ? (
          <button className="icon-button compact" type="button" title="Add alarm" aria-label="Add alarm" disabled={busy || zones.length === 0} onClick={() => setEditing("new")}>
            <Plus size={16} />
          </button>
        ) : null}
      </div>

      {error ? <div className="empty-panel error-panel"><span>{error}</span></div> : null}

      {state === "loading" && alarms.length === 0 ? (
        <div className="empty-panel">Loading…</div>
      ) : zones.length === 0 ? (
        <div className="empty-panel">No speakers found.</div>
      ) : (
        <>
          {alarms.length === 0 && state === "ready" ? (
            <div className="empty-panel">No alarms yet.</div>
          ) : (
            <ul className="alarm-list">
              {alarms.map((alarm) => (
                <li key={alarm.id} className="alarm-row">
                  <input type="checkbox" role="switch" checked={alarm.enabled} disabled={busy} aria-label={`Enable alarm at ${alarm.startTime.slice(0, 5)}`} onChange={() => void toggle(alarm)} />
                  <span className="alarm-time">{alarm.startTime.slice(0, 5)}</span>
                  <span className="alarm-meta">
                    <span>{alarm.roomName ?? alarm.roomUuid}</span>
                    <small>{recurrenceLabel(alarm.recurrence)} · {programLabel(alarm.program)} · {alarm.volume}%</small>
                  </span>
                  <button type="button" className="browse-action" title="Edit" aria-label="Edit alarm" disabled={busy} onClick={() => setEditing(alarm)}>✎</button>
                  <button type="button" className="browse-action" title="Delete" aria-label="Delete alarm" disabled={busy} onClick={() => void mutate(() => bridgeApi.deleteAlarm(alarm.id))}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}

        </>
      )}

      {editing !== null ? (
        <div className="eq-modal-backdrop" role="presentation" onClick={() => setEditing(null)}>
          <div className="eq-modal" role="dialog" aria-modal="true" aria-label={editing === "new" ? "New alarm" : "Edit alarm"} onClick={(event) => event.stopPropagation()}>
            <AlarmForm
              key={editing === "new" ? "new" : editing.id}
              zones={zones}
              alarm={editing === "new" ? null : editing}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={(input) => void submit(input)}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface AlarmFormProps {
  zones: SonosZone[];
  alarm: Alarm | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: AlarmInput) => void;
}

type RecurrenceKind = "once" | "daily" | "weekdays" | "weekends" | "custom";

function AlarmForm({ zones, alarm, busy, onCancel, onSubmit }: AlarmFormProps) {
  const initial = recurrenceToForm(alarm?.recurrence ?? "daily");
  const [time, setTime] = useState(alarm ? alarm.startTime.slice(0, 5) : "07:00");
  const [roomUuid, setRoomUuid] = useState(alarm?.roomUuid ?? zones[0]?.id ?? "");
  const [kind, setKind] = useState<RecurrenceKind>(initial.kind);
  const [days, setDays] = useState<boolean[]>(initial.days);
  const [volume, setVolume] = useState(alarm?.volume ?? 25);
  const [durationMin, setDurationMin] = useState(Math.max(1, Math.round((alarm?.durationSeconds ?? 7200) / 60)));
  const [program, setProgram] = useState<AlarmProgram>(alarm?.program ?? "chime");
  const [includeLinked, setIncludeLinked] = useState(alarm?.includeLinkedZones ?? false);

  const isCustomProgram = program === "other";
  const roomInZones = zones.some((zone) => zone.id === roomUuid);

  const handleSubmit = () => {
    onSubmit({
      startTime: time,
      durationSeconds: durationMin * 60,
      recurrence: formToRecurrence(kind, days),
      enabled: alarm?.enabled ?? true,
      roomUuid,
      program,
      // Preserve a Sonos-app alarm's content on edit.
      programUri: isCustomProgram ? alarm?.programUri : undefined,
      programMetaData: isCustomProgram ? alarm?.programMetaData : undefined,
      playMode: alarm?.playMode,
      volume,
      includeLinkedZones: includeLinked
    });
  };

  return (
    <div className="alarm-form">
      <div className="section-heading">
        <h2 className="eq-modal-title">{alarm ? "Edit alarm" : "New alarm"}</h2>
        <button type="button" className="icon-button compact" aria-label="Close" onClick={onCancel}><X size={16} /></button>
      </div>

      <label className="pref-row">
        <span className="pref-label"><strong>Time</strong></span>
        <input type="time" value={time} disabled={busy} onChange={(event) => setTime(event.target.value)} />
      </label>

      <label className="pref-row">
        <span className="pref-label"><strong>Room</strong></span>
        <select value={roomUuid} disabled={busy} onChange={(event) => setRoomUuid(event.target.value)}>
          {!roomInZones && alarm ? <option value={alarm.roomUuid}>{alarm.roomName ?? alarm.roomUuid}</option> : null}
          {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
        </select>
      </label>

      <div className="pref-row alarm-recurrence">
        <span className="pref-label"><strong>Repeat</strong></span>
        <div className="alarm-recur-presets">
          {(["once", "daily", "weekdays", "weekends", "custom"] as RecurrenceKind[]).map((option) => (
            <button key={option} type="button" className={`eq-chip${kind === option ? " selected-chip" : ""}`} disabled={busy} onClick={() => setKind(option)}>
              {option === "once" ? "Once" : option === "daily" ? "Daily" : option === "weekdays" ? "Weekdays" : option === "weekends" ? "Weekends" : "Custom"}
            </button>
          ))}
        </div>
      </div>

      {kind === "custom" ? (
        <div className="alarm-days">
          {DAY_LABELS.map((label, index) => (
            <button key={label} type="button" className={`alarm-day${days[index] ? " on" : ""}`} disabled={busy} aria-pressed={days[index]} onClick={() => setDays((current) => current.map((value, i) => (i === index ? !value : value)))}>
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="pref-row">
        <span className="pref-label"><strong>Plays</strong></span>
        {isCustomProgram ? (
          <span className="alarm-custom-program">Custom (Sonos app)</span>
        ) : (
          <div className="alarm-program">
            <label><input type="radio" name="alarm-program" checked={program === "chime"} disabled={busy} onChange={() => setProgram("chime")} /> Chime</label>
            <label><input type="radio" name="alarm-program" checked={program === "queue"} disabled={busy} onChange={() => setProgram("queue")} /> This room's queue</label>
          </div>
        )}
      </div>

      <div className="eq-slider">
        <span className="eq-slider-label">Volume</span>
        <input type="range" min="0" max="100" step="1" value={volume} disabled={busy} onChange={(event) => setVolume(Number.parseInt(event.currentTarget.value, 10))} />
        <output>{volume}</output>
      </div>

      <label className="pref-row">
        <span className="pref-label"><strong>Duration</strong><small>Minutes before it stops</small></span>
        <input type="number" min="1" max="1440" value={durationMin} disabled={busy} onChange={(event) => setDurationMin(Math.max(1, Number.parseInt(event.target.value, 10) || 1))} />
      </label>

      <label className="pref-row">
        <span className="pref-label"><strong>Also play on grouped rooms</strong></span>
        <input type="checkbox" role="switch" checked={includeLinked} disabled={busy} onChange={(event) => setIncludeLinked(event.target.checked)} />
      </label>

      <div className="alarm-form-actions">
        <button type="button" disabled={busy || !roomUuid} onClick={handleSubmit}>{alarm ? "Save" : "Create"}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function alarmToInput(alarm: Alarm): AlarmInput {
  return {
    startTime: alarm.startTime,
    durationSeconds: alarm.durationSeconds,
    recurrence: alarm.recurrence,
    enabled: alarm.enabled,
    roomUuid: alarm.roomUuid,
    program: alarm.program,
    programUri: alarm.programUri,
    programMetaData: alarm.programMetaData,
    playMode: alarm.playMode,
    volume: alarm.volume,
    includeLinkedZones: alarm.includeLinkedZones
  };
}

function recurrenceToForm(recurrence: AlarmRecurrence): { kind: RecurrenceKind; days: boolean[] } {
  const empty = [false, false, false, false, false, false, false];
  if (recurrence === "once" || recurrence === "daily" || recurrence === "weekdays" || recurrence === "weekends") {
    return { kind: recurrence, days: empty };
  }
  return { kind: "custom", days: empty.map((_, index) => recurrence.days.includes(index)) };
}

function formToRecurrence(kind: RecurrenceKind, days: boolean[]): AlarmRecurrence {
  if (kind !== "custom") return kind;
  const selected = days.map((on, index) => (on ? index : -1)).filter((index) => index >= 0);
  return selected.length > 0 ? { days: selected } : "once";
}

function recurrenceLabel(recurrence: AlarmRecurrence): string {
  if (recurrence === "once") return "Once";
  if (recurrence === "daily") return "Every day";
  if (recurrence === "weekdays") return "Weekdays";
  if (recurrence === "weekends") return "Weekends";
  return recurrence.days.map((day) => DAY_LABELS[day]).join(", ") || "Once";
}

function programLabel(program: AlarmProgram): string {
  return program === "chime" ? "Chime" : program === "queue" ? "Queue" : "Custom";
}
