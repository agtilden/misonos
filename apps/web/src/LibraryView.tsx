import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronUp, ChevronDown, ListEnd, ListPlus, Play, Plus, Trash2 } from "lucide-react";
import type { Favorite, Playlist, PlaylistItem, PlaybackMode, SonosGroup } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { GroupDropdown } from "./GroupDropdown.js";
import { buildGroupOptions } from "./groupPalette.js";

interface LibraryViewProps {
  groups: SonosGroup[];
  selectedGroupId?: string;
  onSelectGroup: (groupId: string) => void;
}

type OpenPlaylist = { playlist: Playlist; items: PlaylistItem[] };

export function LibraryView({ groups, selectedGroupId, onSelectGroup }: LibraryViewProps) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [open, setOpen] = useState<OpenPlaylist | null>(null);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const groupOptions = buildGroupOptions(groups);
  const selectedGroupOption = groupOptions.find((option) => option.id === selectedGroupId) ?? groupOptions[0];

  const refresh = useCallback(async () => {
    const [favs, lists] = await Promise.all([bridgeApi.favorites(), bridgeApi.playlists()]);
    setFavorites(favs);
    setPlaylists(lists);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
    await bridgeApi.removeFavorite(favorite.sourceId, favorite.itemId);
    setFavorites((current) => current.filter((entry) => entry.id !== favorite.id));
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
    if (!window.confirm(`Delete playlist “${playlist.name}”?`)) return;
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

  const playPlaylist = async (playlist: Playlist, mode: PlaybackMode) => {
    const groupId = requireGroup();
    if (!groupId) return;
    setBusy(true);
    try {
      await bridgeApi.playPlaylist(playlist.id, groupId, mode);
      setStatus({ ok: true, message: `${verb(mode)} “${playlist.name}”.` });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : "Could not play playlist" });
    } finally {
      setBusy(false);
    }
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
            <Play size={15} /> Play all
          </button>
          <button type="button" disabled={busy || open.items.length === 0} onClick={() => void playPlaylist(open.playlist, "end")}>
            <ListEnd size={15} /> Queue all
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

      <div className="library-section">
        <h3>Favorites</h3>
        {favorites.length === 0 ? (
          <div className="empty-panel">No favorites yet. Tap the ⋯ menu on a track or album to favorite it.</div>
        ) : (
          <ul className="library-track-list">
            {favorites.map((favorite) => (
              <li key={favorite.id} className="library-track">
                <div className="browse-track-meta">
                  <span>{favorite.title}{favorite.kind === "album" ? " (album)" : ""}</span>
                  {[favorite.artist, favorite.album, favorite.subtitle].filter(Boolean).length > 0
                    ? <small>{[favorite.artist, favorite.album ?? favorite.subtitle].filter(Boolean).join(" · ")}</small> : null}
                </div>
                <div className="browse-actions">
                  <button type="button" className="browse-action" title="Play now" aria-label="Play now" disabled={busy} onClick={() => void playFavorite(favorite, "replace")}><Play size={14} /></button>
                  <button type="button" className="browse-action" title="Add to end" aria-label="Add to end" disabled={busy} onClick={() => void playFavorite(favorite, "end")}><ListEnd size={14} /></button>
                  <button type="button" className="browse-action" title="Remove favorite" aria-label="Remove favorite" onClick={() => void unfavorite(favorite)}><Trash2 size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="library-section">
        <h3>Playlists</h3>
        <div className="add-to-playlist-new">
          <input type="text" placeholder="New playlist name…" value={newName} maxLength={60} disabled={busy}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void createPlaylist(); }} />
          <button type="button" disabled={busy || !newName.trim()} onClick={() => void createPlaylist()}><Plus size={14} /> New</button>
        </div>
        {playlists.length === 0 ? (
          <div className="empty-panel">No playlists yet.</div>
        ) : (
          <ul className="library-track-list">
            {playlists.map((playlist) => (
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
      </div>
    </section>
  );
}

function verb(mode: PlaybackMode): string {
  return mode === "replace" ? "Playing" : mode === "next" ? "Queued next:" : "Queued at end:";
}
