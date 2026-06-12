export interface PaletteEntry {
  color: string;
  name: string;
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

function hashStrings(values: readonly string[]): number {
  const key = [...values].sort().join("|");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
