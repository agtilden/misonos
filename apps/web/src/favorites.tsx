import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Favorite } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";

export interface FavoriteInput {
  sourceId: string;
  itemId: string;
  kind: "track" | "album" | "radio";
  title: string;
  subtitle?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtUri?: string | null;
}

interface FavoritesApi {
  /** All favorites, newest first — backs the library and the presets strip. */
  favorites: Favorite[];
  /** Favorites flagged as one-tap presets. */
  presets: Favorite[];
  isFavorited: (sourceId: string, itemId: string) => boolean;
  isPreset: (sourceId: string, itemId: string) => boolean;
  /** Add/remove the favorite; resolves to the new favorited state. */
  toggle: (input: FavoriteInput) => Promise<boolean>;
  /**
   * Promote/demote a favorite as a preset; resolves to the new preset state.
   * Promoting auto-favorites first, so a preset always backs a favorite.
   */
  togglePreset: (input: FavoriteInput) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const FavoritesContext = createContext<FavoritesApi | null>(null);

const favKey = (sourceId: string, itemId: string) => `${sourceId}:${itemId}`;

// Shared favorites state so the browse screen, library, now-playing queue, and the
// presets strip all stay in sync when something is favorited/presetted anywhere.
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);

  const reload = useCallback(async () => {
    try {
      const list = await bridgeApi.favorites();
      setFavorites(Array.isArray(list) ? list : []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const byKey = useMemo(() => {
    const map = new Map<string, Favorite>();
    for (const fav of favorites) map.set(favKey(fav.sourceId, fav.itemId), fav);
    return map;
  }, [favorites]);

  const presets = useMemo(() => favorites.filter((fav) => fav.preset), [favorites]);

  const isFavorited = useCallback((sourceId: string, itemId: string) => byKey.has(favKey(sourceId, itemId)), [byKey]);
  const isPreset = useCallback((sourceId: string, itemId: string) => !!byKey.get(favKey(sourceId, itemId))?.preset, [byKey]);

  const addFavorite = useCallback((input: FavoriteInput) => bridgeApi.addFavorite({
    kind: input.kind,
    sourceId: input.sourceId,
    itemId: input.itemId,
    title: input.title,
    subtitle: input.subtitle,
    artist: input.artist,
    album: input.album,
    albumArtUri: input.albumArtUri
  }), []);

  const toggle = useCallback(async (input: FavoriteInput) => {
    const favorited = byKey.has(favKey(input.sourceId, input.itemId));
    if (favorited) {
      await bridgeApi.removeFavorite(input.sourceId, input.itemId);
    } else {
      await addFavorite(input);
    }
    await reload();
    return !favorited;
  }, [byKey, addFavorite, reload]);

  const togglePreset = useCallback(async (input: FavoriteInput) => {
    const next = !byKey.get(favKey(input.sourceId, input.itemId))?.preset;
    // A preset must back a favorite — ensure it exists before promoting.
    if (next && !byKey.has(favKey(input.sourceId, input.itemId))) await addFavorite(input);
    await bridgeApi.setFavoritePreset(input.sourceId, input.itemId, next);
    await reload();
    return next;
  }, [byKey, addFavorite, reload]);

  const api = useMemo<FavoritesApi>(
    () => ({ favorites, presets, isFavorited, isPreset, toggle, togglePreset, refresh: reload }),
    [favorites, presets, isFavorited, isPreset, toggle, togglePreset, reload]
  );
  return <FavoritesContext.Provider value={api}>{children}</FavoritesContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useFavorites(): FavoritesApi {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("useFavorites must be used within a FavoritesProvider");
  return ctx;
}
