import { bridgeApi } from "./api";

// Hybrid preferences: localStorage is a synchronous, instant-paint cache; the
// bridge store (~/.misonos/misonos.db) is the shared, cross-device source of truth.
// Writes go to both (bridge best-effort so the app still works offline / bridge-down).
// Reads prefer the bridge but fall back to the local cache.

export interface PrefDef<T> {
  /** Key in the bridge `preference` table. */
  bridgeKey: string;
  /** Key in localStorage (kept namespaced for back-compat with older builds). */
  localKey: string;
  decode: (raw: string) => T | null;
  encode: (value: T) => string;
}

function stringPref(bridgeKey: string, localKey: string): PrefDef<string> {
  return { bridgeKey, localKey, decode: (raw) => raw, encode: (value) => value };
}

function boolPref(bridgeKey: string, localKey: string): PrefDef<boolean> {
  return { bridgeKey, localKey, decode: (raw) => raw === "true", encode: (value) => (value ? "true" : "false") };
}

function numberPref(bridgeKey: string, localKey: string): PrefDef<number> {
  return {
    bridgeKey,
    localKey,
    decode: (raw) => { const parsed = Number.parseInt(raw, 10); return Number.isFinite(parsed) ? parsed : null; },
    encode: (value) => String(value)
  };
}

export const LAST_GROUP_PREF = stringPref("lastGroupKey", "misonos:lastGroupKey");
export const LAST_SOURCE_PREF = stringPref("lastSourceId", "misonos:lastSourceId");
export const SHOW_DEV_PANELS_PREF = boolPref("showDevPanels", "misonos:showDevPanels");
// "No chrome" — hide every control (even the close X) on the full-screen cover-art
// and VU-meter views, so a purist gets the visual undisturbed; a tap dismisses.
export const FULLSCREEN_NO_CHROME_PREF = boolPref("fullscreenNoChrome", "misonos:fullscreenNoChrome");
// Caps how high the volume sliders can go (0–100). The slider keeps its full width
// but represents 0..maxVolume, so the controller never sends a higher value.
export const MAX_VOLUME_PREF = numberPref("maxVolume", "misonos:maxVolume");

export function readLocalPref<T>(pref: PrefDef<T>): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(pref.localKey);
    return raw === null ? null : pref.decode(raw);
  } catch {
    return null;
  }
}

function writeLocalPref<T>(pref: PrefDef<T>, value: T): void {
  try {
    window.localStorage.setItem(pref.localKey, pref.encode(value));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Write-through: update the instant local cache now, mirror to the shared bridge store best-effort. */
export function setPref<T>(pref: PrefDef<T>, value: T): void {
  writeLocalPref(pref, value);
  void bridgeApi.setPreference(pref.bridgeKey, pref.encode(value)).catch(() => {
    /* bridge unreachable: local cache still holds the value */
  });
}

/** Read the shared value from the bridge (refreshing the local cache); fall back to local when unavailable or unset. */
export async function loadPref<T>(pref: PrefDef<T>): Promise<T | null> {
  try {
    const remote = await bridgeApi.getPreference(pref.bridgeKey);
    if (remote && typeof remote.value === "string") {
      const decoded = pref.decode(remote.value);
      if (decoded !== null) {
        writeLocalPref(pref, decoded);
        return decoded;
      }
    }
  } catch {
    /* 404 (unset) or bridge down: fall through to the local cache */
  }
  return readLocalPref(pref);
}
