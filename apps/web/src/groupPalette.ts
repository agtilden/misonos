import type { SonosGroup } from "@misonos/sonos-protocol";

export interface PaletteEntry {
  color: string;
  name: string;
}

export interface GroupOption {
  id: string;
  key: string;
  color: string;
  name: string;
  zoneList: string;
  // Synthetic "This device" target — rendered with an icon instead of a color chip,
  // and excluded from the group editor.
  device?: boolean;
}

/**
 * Assign a distinct palette entry to each group, keyed by coordinator id.
 *
 * Each group prefers the slot its coordinator hashes to (so colors stay stable across
 * membership changes), but when two groups would collide we linear-probe to the next
 * free slot — so distinct groups get distinct colors while the palette has room
 * (only > groupPalette.length groups can share). Priority order is sorted by coordinator
 * id, so the assignment is deterministic and independent of array order.
 */
export function assignGroupPalettes(groups: SonosGroup[]): Map<string, PaletteEntry> {
  const size = groupPalette.length;
  const used = new Set<number>();
  const result = new Map<string, PaletteEntry>();
  const ordered = [...groups].sort((a, b) => a.coordinatorId.localeCompare(b.coordinatorId));
  for (const group of ordered) {
    let slot = hashStrings([group.coordinatorId]) % size;
    if (used.size < size) {
      let steps = 0;
      while (used.has(slot) && steps < size) {
        slot = (slot + 1) % size;
        steps++;
      }
    }
    used.add(slot);
    result.set(group.coordinatorId, groupPalette[slot]);
  }
  return result;
}

/** Build the color-named group options shared by the topbar, Browse, and Library pickers. */
export function buildGroupOptions(groups: SonosGroup[]): GroupOption[] {
  const palettes = assignGroupPalettes(groups);
  return groups.map((group) => {
    const visible = group.zones.filter((zone) => zone.visible);
    const palette = palettes.get(group.coordinatorId) ?? paletteForGroup(group.coordinatorId);
    return {
      id: group.id,
      key: visible.map((zone) => zone.uuid).sort().join("|"),
      color: palette.color,
      name: palette.name,
      zoneList: visible.map((zone) => zone.name).join(" + ")
    };
  });
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const bigint = parseInt(value, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const groupPalette: PaletteEntry[] = [
  { color: "#91d3c4", name: "Mint" },
  { color: "#f1b555", name: "Amber" },
  { color: "#8fb8ff", name: "Sky" },
  { color: "#ff8a80", name: "Coral" },
  { color: "#c2a5ff", name: "Lilac" },
  { color: "#84d982", name: "Lime" },
  { color: "#f08ec4", name: "Pink" },
  { color: "#a8c66c", name: "Olive" }
];

export function paletteFor(index: number): PaletteEntry {
  return groupPalette[index % groupPalette.length];
}

export function paletteForMembers(memberIds: readonly string[]): PaletteEntry {
  return groupPalette[hashStrings(memberIds) % groupPalette.length];
}

// A group's color is keyed on its coordinator (Sonos's stable group identity), not its
// full membership. Pulling a satellite room out leaves the coordinator unchanged, so the
// group keeps its color; the room that left becomes its own group and shows the color tied
// to its own id. Without this, any membership change rehashes and recolors the whole group.
export function paletteForGroup(coordinatorId: string): PaletteEntry {
  return paletteForMembers([coordinatorId]);
}

function hashStrings(values: readonly string[]): number {
  const key = [...values].sort().join("|");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
