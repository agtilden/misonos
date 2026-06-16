import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { bridgeApi } from "./api.js";

export interface FavoriteInput {
  sourceId: string;
  itemId: string;
  kind: "track" | "album";
  title: string;
  subtitle?: string | null;
  artist?: string | null;
  album?: string | null;
}

interface FavoritesApi {
  isFavorited: (sourceId: string, itemId: string) => boolean;
  /** Add/remove the favorite; resolves to the new favorited state. */
  toggle: (input: FavoriteInput) => Promise<boolean>;
}

const FavoritesContext = createContext<FavoritesApi | null>(null);

// Shared favorites state so the browse screen and the now-playing queue (and anything
// else) stay in sync when a track/album is favorited from either place.
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void bridgeApi.favorites()
      .then((favs) => { if (!cancelled) setKeys(new Set(favs.map((fav) => `${fav.sourceId}:${fav.itemId}`))); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  const isFavorited = useCallback((sourceId: string, itemId: string) => keys.has(`${sourceId}:${itemId}`), [keys]);

  const toggle = useCallback(async (input: FavoriteInput) => {
    const key = `${input.sourceId}:${input.itemId}`;
    if (keys.has(key)) {
      await bridgeApi.removeFavorite(input.sourceId, input.itemId);
      setKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
      return false;
    }
    await bridgeApi.addFavorite({
      kind: input.kind,
      sourceId: input.sourceId,
      itemId: input.itemId,
      title: input.title,
      subtitle: input.subtitle,
      artist: input.artist,
      album: input.album
    });
    setKeys((prev) => new Set(prev).add(key));
    return true;
  }, [keys]);

  const api = useMemo<FavoritesApi>(() => ({ isFavorited, toggle }), [isFavorited, toggle]);
  return <FavoritesContext.Provider value={api}>{children}</FavoritesContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useFavorites(): FavoritesApi {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error("useFavorites must be used within a FavoritesProvider");
  return ctx;
}
