import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronUp, ChevronDown, ListEnd, ListPlus, Play, Plus, RotateCcw, Star, Trash2 } from "lucide-react";
import type { Favorite, Playlist, PlaylistItem, PlaybackMode, RecentQueue, SonosGroup, SourceDescriptor } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { GroupDropdown } from "./GroupDropdown.js";
import { buildGroupOptions } from "./groupPalette.js";
import { useDialogs } from "./dialogs.js";
import { useFavorites, type FavoriteInput } from "./favorites.js";
import { ServiceIcon } from "./SourcePicker.js";

interface LibraryViewProps {
  groups: SonosGroup[];
  selectedGroupId?: string;
  onSelectGroup: (groupId: string) => void;
}

type OpenPlaylist = { playlist: Playlist; items: PlaylistItem[] };

export function LibraryView({ groups, selectedGroupId, onSelectGroup }: LibraryViewProps) {
  const dialogs = useDialogs();
  const favs = useFavorites();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [recentQueues, setRecentQueues] = useState<RecentQueue[]>([]);
  const [sources, setSources] = useState<SourceDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<OpenPlaylist | null>(null);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // Collapsed Library sections, persisted so the choice sticks across visits. Default
  // open; a section is collapsed when its key is truthy here.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(LIBRARY_COLLAPSE_KEY) ?? "{}"); } catch { return {}; }
  });
  const toggleSection = (key: string) => setCollapsed((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem(LIBRARY_COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  const groupOptions = buildGroupOptions(groups);
  const selectedGroupOption = groupOptions.find((option) => option.id === selectedGroupId) ?? groupOptions[0];
  // Recent queues are keyed by the coordinator's stable zone UUID (the queue lives on
  // the coordinator and follows it through grouping).
  const coordinatorUuid = groups.find((group) => group.id === selectedGroupId)?.coordinatorId;

  // Favorites come from the shared hook so preset changes here and in the player
  // stay in sync; only playlists are local to this view.
  const refresh = useCallback(async () => {
    setPlaylists(await bridgeApi.playlists());
  }, []);

  const refreshRecentQueues = useCallback(async () => {
    if (!coordinatorUuid) { setRecentQueues([]); return; }
    setRecentQueues(await bridgeApi.recentQueues(coordinatorUuid).catch(() => []));
  }, [coordinatorUuid]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshRecentQueues(); }, [refreshRecentQueues]);
  useEffect(() => { void bridgeApi.listSources().then(setSources).catch(() => { /* non-fatal */ }); }, []);

  const sourceName = useCallback(
    (sourceId: string) => sources.find((source) => source.id === sourceId)?.name ?? sourceId,
    [sources]
  );

  // Group favorites by provider; within a provider, radio (presettable) first, then by title.
  const trimmedQuery = query.trim().toLowerCase();

  const favoritesByProvider = useMemo(() => {
    const matches = (fav: Favorite) =>
      !trimmedQuery || [fav.title, fav.artist, fav.album, fav.subtitle, sourceName(fav.sourceId)]
        .some((field) => field?.toLowerCase().includes(trimmedQuery));
    const groups = new Map<string, Favorite[]>();
    for (const fav of favs.favorites) {
      if (!matches(fav)) continue;
      const list = groups.get(fav.sourceId) ?? [];
      list.push(fav);
      groups.set(fav.sourceId, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => Number(b.kind === "radio") - Number(a.kind === "radio") || a.title.localeCompare(b.title));
    }
    return [...groups.entries()].sort((a, b) => sourceName(a[0]).localeCompare(sourceName(b[0])));
  }, [favs.favorites, sourceName, trimmedQuery]);

  const filteredPlaylists = useMemo(
    () => (trimmedQuery ? playlists.filter((pl) => pl.name.toLowerCase().includes(trimmedQuery)) : playlists),
    [playlists, trimmedQuery]
  );

  const filteredRecentQueues = useMemo(
    () => (trimmedQuery ? recentQueues.filter((rq) => rq.title.toLowerCase().includes(trimmedQuery)) : recentQueues),
    [recentQueues, trimmedQuery]
  );

  const favoriteToInput = (favorite: Favorite): FavoriteInput => ({
    sourceId: favorite.sourceId, itemId: favorite.itemId, kind: favorite.kind, title: favorite.title,
    subtitle: favorite.subtitle, artist: favorite.artist, album: favorite.album, albumArtUri: favorite.albumArtUri
  });

  const togglePreset = async (favorite: Favorite) => {
    try {
      const nowPreset = await favs.togglePreset(favoriteToInput(favorite));
      setStatus({ ok: true, message: nowPreset ? `Added “${favorite.title}” to presets.` : `Removed “${favorite.title}” from presets.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Could not update preset" });
    }
  };

  useEffect(() => {
    if (!status) return undefined;
    const timeout = window.setTimeout(() => setStatus(null), status.ok ? 3500 : 6000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const requireGroup = (): string | null => {
    if (!selectedGroupId) { setStatus({ ok: false, message: "Pick a group first." }); return null; }
    return selectedGroupId;
  };

  const playFavorite = async (favorite: Favorite, mode: PlaybackMode) => {
    const groupId = requireGroup();
    if (!groupId) return;
    setBusy(true);
    try {
      let trackIds: string[];
      if (favorite.kind === "album") {
        const expansion = await bridgeApi.browseSource(favorite.sourceId, favorite.itemId);
        trackIds = expansion.items.filter((entry) => entry.kind === "playable").map((entry) => entry.id);
      } else {
        trackIds = [favorite.itemId];
      }
      if (trackIds.length === 0) { setStatus({ ok: false, message: "No playable tracks." }); return; }
      await bridgeApi.playSourceItems(favorite.sourceId, { trackIds, groupId, mode });
      setStatus({ ok: true, message: `${verb(mode)} “${favorite.title}”.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  };

  const unfavorite = async (favorite: Favorite) => {
    // toggle removes it (and any preset) since it's currently favorited, and keeps the shared state in sync.
    await favs.toggle(favoriteToInput(favorite));
  };

  const createPlaylist = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await bridgeApi.createPlaylist(name);
      setNewName("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const deletePlaylist = async (playlist: Playlist) => {
    const ok = await dialogs.confirm({ message: `Delete playlist “${playlist.name}”?`, confirmLabel: "Delete" });
    if (!ok) return;
    await bridgeApi.deletePlaylist(playlist.id);
    await refresh();
  };

  const commitRename = async (playlist: Playlist) => {
    const name = renameText.trim();
    setRenamingId(null);
    if (!name || name === playlist.name) return;
    await bridgeApi.renamePlaylist(playlist.id, name);
    await refresh();
  };

  const playPlaylist = async (playlist: Playlist, mode: PlaybackMode, fromStart = false) => {
    const groupId = requireGroup();
    if (!groupId) return;
    setBusy(true);
    try {
      await bridgeApi.playPlaylist(playlist.id, groupId, mode, fromStart);
      const resumed = mode === "replace" && !fromStart && playlist.resumeTrackNumber;
      setStatus({ ok: true, message: resumed ? `Resumed “${playlist.name}” at track ${playlist.resumeTrackNumber}.` : `${verb(mode)} “${playlist.name}”.` });
      // Resume point moved server-side — refresh the open view so the hint stays accurate.
      if (open?.playlist.id === playlist.id) setOpen(await bridgeApi.playlist(playlist.id));
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Could not play playlist" });
    } finally {
      setBusy(false);
    }
  };

  const restoreQueue = async (rq: RecentQueue) => {
    const groupId = requireGroup();
    if (!groupId) return;
    setBusy(true);
    try {
      await bridgeApi.restoreRecentQueue(rq.id, groupId);
      setStatus({ ok: true, message: `Restored “${rq.title}” (${rq.itemCount} ${rq.itemCount === 1 ? "track" : "tracks"}).` });
      await refreshRecentQueues();
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Could not restore queue" });
    } finally {
      setBusy(false);
    }
  };

  const dismissQueue = async (rq: RecentQueue) => {
    await bridgeApi.deleteRecentQueue(rq.id);
    await refreshRecentQueues();
  };

  const openPlaylist = async (id: number) => {
    setOpen(await bridgeApi.playlist(id));
  };

  const playTrack = async (item: PlaylistItem, mode: PlaybackMode) => {
    const groupId = requireGroup();
    if (!groupId) return;
    setBusy(true);
    try {
      await bridgeApi.playSourceItems(item.sourceId, { trackIds: [item.trackId], groupId, mode });
      setStatus({ ok: true, message: `${verb(mode)} “${item.title}”.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (item: PlaylistItem) => {
    if (!open) return;
    await bridgeApi.removePlaylistItem(open.playlist.id, item.id);
    setOpen(await bridgeApi.playlist(open.playlist.id));
    void refresh();
  };

  const moveItem = async (index: number, delta: number) => {
    if (!open) return;
    const target = index + delta;
    if (target < 0 || target >= open.items.length) return;
    const ids = open.items.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const items = await bridgeApi.reorderPlaylist(open.playlist.id, ids);
    setOpen({ playlist: open.playlist, items });
  };

  const groupSelect = groupOptions.length > 0 ? (
    <div className="library-group">
      <span>Play to</span>
      <GroupDropdown
        options={groupOptions}
        selectedId={selectedGroupId}
        selectedOption={selectedGroupOption}
        onSelect={onSelectGroup}
      />
    </div>
  ) : null;

  if (open) {
    return (
      <section className="queue-panel library" aria-label="Playlist">
        <div className="section-heading">
          <div className="heading-leading">
            <button className="icon-button compact" type="button" aria-label="Back to library" onClick={() => setOpen(null)}>
              <ArrowLeft size={16} />
            </button>
            <h2>{open.playlist.name}</h2>
          </div>
          {groupSelect}
        </div>
        <div className="library-playlist-actions">
          <button type="button" disabled={busy || open.items.length === 0} onClick={() => void playPlaylist(open.playlist, "replace")}>
            <Play size={15} /> {open.playlist.resumeTrackNumber ? `Resume (track ${open.playlist.resumeTrackNumber})` : "Play all"}
          </button>
          {open.playlist.resumeTrackNumber ? (
            <button type="button" className="ghost" title="Play from the first track" disabled={busy} onClick={() => void playPlaylist(open.playlist, "replace", true)}>
              <RotateCcw size={15} /> From start
            </button>
          ) : null}
          <button type="button" title="Play after the current track (keeps the queue)" disabled={busy || open.items.length === 0} onClick={() => void playPlaylist(open.playlist, "next")}>
            <ListPlus size={15} /> Play next
          </button>
          <button type="button" title="Add to the end of the queue (keeps the queue)" disabled={busy || open.items.length === 0} onClick={() => void playPlaylist(open.playlist, "end")}>
            <ListEnd size={15} /> Add to end
          </button>
        </div>
        {status ? <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div> : null}
        {open.items.length === 0 ? (
          <div className="empty-panel">This playlist is empty.</div>
        ) : (
          <ol className="library-track-list">
            {open.items.map((item, index) => (
              <li key={item.id} className="library-track">
                <div className="library-reorder">
                  <button type="button" aria-label="Move up" disabled={busy || index === 0} onClick={() => void moveItem(index, -1)}><ChevronUp size={14} /></button>
                  <button type="button" aria-label="Move down" disabled={busy || index === open.items.length - 1} onClick={() => void moveItem(index, 1)}><ChevronDown size={14} /></button>
                </div>
                <div className="browse-track-meta">
                  <span>{item.title}</span>
                  {[item.artist, item.album].filter(Boolean).length > 0 ? <small>{[item.artist, item.album].filter(Boolean).join(" · ")}</small> : null}
                </div>
                <div className="browse-actions">
                  <button type="button" className="browse-action" title="Play now" aria-label="Play now" disabled={busy} onClick={() => void playTrack(item, "replace")}><Play size={14} /></button>
                  <button type="button" className="browse-action" title="Play next" aria-label="Play next" disabled={busy} onClick={() => void playTrack(item, "next")}><ListPlus size={14} /></button>
                  <button type="button" className="browse-action" title="Add to end" aria-label="Add to end" disabled={busy} onClick={() => void playTrack(item, "end")}><ListEnd size={14} /></button>
                  <button type="button" className="browse-action" title="Remove from playlist" aria-label="Remove" disabled={busy} onClick={() => void removeItem(item)}><Trash2 size={14} /></button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  }

  return (
    <section className="queue-panel library" aria-label="Library">
      <div className="section-heading"><h2>Library</h2>{groupSelect}</div>
      {status ? <div className={status.ok ? "service-result ok" : "service-result error"}>{status.message}</div> : null}

      <input
        className="library-search"
        type="search"
        placeholder="Search favorites and playlists…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {recentQueues.length > 0 ? (
        <CollapsibleSection title="Recent queues" count={recentQueues.length} open={!collapsed.recentQueues} onToggle={() => toggleSection("recentQueues")}>
          {filteredRecentQueues.length === 0 ? (
            <div className="empty-panel">No recent queues match “{query.trim()}”.</div>
          ) : (
            <ul className="library-track-list">
              {filteredRecentQueues.map((rq) => (
                <li key={rq.id} className="library-track">
                  <div className="browse-track-meta">
                    <span>{rq.title}</span>
                    <small>
                      {rq.itemCount} {rq.itemCount === 1 ? "track" : "tracks"} · {relativeTime(rq.capturedAt)}
                      {rq.startTrack && rq.startTrack > 1 ? ` · was on track ${rq.startTrack}` : ""}
                    </small>
                  </div>
                  <div className="browse-actions">
                    <button type="button" className="browse-action" title="Restore this queue" aria-label="Restore queue" disabled={busy} onClick={() => void restoreQueue(rq)}><RotateCcw size={14} /></button>
                    <button type="button" className="browse-action" title="Remove" aria-label="Remove recent queue" onClick={() => void dismissQueue(rq)}><Trash2 size={14} /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CollapsibleSection>
      ) : null}

      <CollapsibleSection title="Favorites" count={favs.favorites.length} open={!collapsed.favorites} onToggle={() => toggleSection("favorites")}>
        {favs.favorites.length === 0 ? (
          <div className="empty-panel">No favorites yet. Tap the ⋯ menu on a track or album to favorite it.</div>
        ) : favoritesByProvider.length === 0 ? (
          <div className="empty-panel">No favorites match “{query.trim()}”.</div>
        ) : (
          favoritesByProvider.map(([sourceId, list]) => (
            <div className="library-provider" key={sourceId}>
              <div className="library-provider-heading">
                <ServiceIcon sourceId={sourceId} />
                <h4>{sourceName(sourceId)}</h4>
              </div>
              <ul className="library-track-list">
                {list.map((favorite) => (
                  <li key={favorite.id} className="library-track">
                    {favorite.albumArtUri
                      ? <img className="browse-thumb" src={favorite.albumArtUri} alt="" loading="lazy" />
                      : <span className="browse-thumb browse-thumb-empty" aria-hidden="true">♪</span>}
                    <div className="browse-track-meta">
                      <span>{favorite.title}{favorite.kind === "album" ? " (album)" : favorite.kind === "radio" ? " (radio)" : ""}</span>
                      {[favorite.artist, favorite.album, favorite.subtitle].filter(Boolean).length > 0
                        ? <small>{[favorite.artist, favorite.album ?? favorite.subtitle].filter(Boolean).join(" · ")}</small> : null}
                    </div>
                    <div className="browse-actions">
                      <button type="button" className="browse-action" title="Play now" aria-label="Play now" disabled={busy} onClick={() => void playFavorite(favorite, "replace")}><Play size={14} /></button>
                      <button type="button" className="browse-action" title="Add to end" aria-label="Add to end" disabled={busy} onClick={() => void playFavorite(favorite, "end")}><ListEnd size={14} /></button>
                      {favorite.kind === "radio" ? (
                        <button type="button" className={`browse-action${favorite.preset ? " pinned" : ""}`} title={favorite.preset ? "Remove preset" : "Save as preset"} aria-label="Toggle preset" onClick={() => void togglePreset(favorite)}>
                          <Star size={14} fill={favorite.preset ? "currentColor" : "none"} />
                        </button>
                      ) : null}
                      <button type="button" className="browse-action" title="Remove favorite" aria-label="Remove favorite" onClick={() => void unfavorite(favorite)}><Trash2 size={14} /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Playlists" count={playlists.length} open={!collapsed.playlists} onToggle={() => toggleSection("playlists")}>
        <div className="add-to-playlist-new">
          <input type="text" placeholder="New playlist name…" value={newName} maxLength={60} disabled={busy}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void createPlaylist(); }} />
          <button type="button" disabled={busy || !newName.trim()} onClick={() => void createPlaylist()}><Plus size={14} /> New</button>
        </div>
        {playlists.length === 0 ? (
          <div className="empty-panel">No playlists yet.</div>
        ) : filteredPlaylists.length === 0 ? (
          <div className="empty-panel">No playlists match “{query.trim()}”.</div>
        ) : (
          <ul className="library-track-list">
            {filteredPlaylists.map((playlist) => (
              <li key={playlist.id} className="library-track">
                {renamingId === playlist.id ? (
                  <input className="library-rename" type="text" autoFocus value={renameText} maxLength={60}
                    onChange={(event) => setRenameText(event.target.value)}
                    onBlur={() => void commitRename(playlist)}
                    onKeyDown={(event) => { if (event.key === "Enter") void commitRename(playlist); if (event.key === "Escape") setRenamingId(null); }} />
                ) : (
                  <button type="button" className="browse-drill-inline" onClick={() => void openPlaylist(playlist.id)}>
                    <span>{playlist.name}</span>
                    <small>{playlist.itemCount} {playlist.itemCount === 1 ? "track" : "tracks"}</small>
                  </button>
                )}
                <div className="browse-actions">
                  <button type="button" className="browse-action" title="Play all" aria-label="Play all" disabled={busy} onClick={() => void playPlaylist(playlist, "replace")}><Play size={14} /></button>
                  <button type="button" className="browse-action" title="Rename" aria-label="Rename" onClick={() => { setRenamingId(playlist.id); setRenameText(playlist.name); }}>✎</button>
                  <button type="button" className="browse-action" title="Delete playlist" aria-label="Delete playlist" onClick={() => void deletePlaylist(playlist)}><Trash2 size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>
    </section>
  );
}

const LIBRARY_COLLAPSE_KEY = "misonos.library.collapsed";

// A Library top-level section with a click-to-collapse header. Sections are
// independent (collapse Favorites to focus on Playlists, etc.); add future sections
// — e.g. Recently played, radio Presets — by dropping another <CollapsibleSection>.
function CollapsibleSection({ title, count, open, onToggle, children }: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`library-section${open ? "" : " collapsed"}`}>
      <button type="button" className="library-section-header" aria-expanded={open} onClick={onToggle}>
        <ChevronDown size={16} className={`library-section-chevron${open ? " open" : ""}`} aria-hidden="true" />
        <h3>{title}</h3>
        {typeof count === "number" ? <span className="library-section-count">{count}</span> : null}
      </button>
      {open ? children : null}
    </div>
  );
}

function verb(mode: PlaybackMode): string {
  return mode === "replace" ? "Playing" : mode === "next" ? "Queued next:" : "Queued at end:";
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
