import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Playlist } from "@misonos/sonos-protocol";
import { bridgeApi, type AddPlaylistItemInput } from "./api.js";

interface AddToPlaylistModalProps {
  sourceId: string;
  item: AddPlaylistItemInput;
  onClose: () => void;
  onDone: (message: string) => void;
}

export function AddToPlaylistModal({ sourceId, item, onClose, onDone }: AddToPlaylistModalProps) {
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await bridgeApi.playlists();
        if (!cancelled) setPlaylists(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load playlists");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const addTo = async (playlistId: number, name: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await bridgeApi.addPlaylistItems(playlistId, sourceId, [item]);
      const added = result.added.length;
      const skip = result.skipped > 0 ? ` (${result.skipped} skipped)` : "";
      onDone(`Added ${added === 1 ? "1 track" : `${added} tracks`} to “${name}”${skip}.`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const playlist = await bridgeApi.createPlaylist(name);
      await addTo(playlist.id, playlist.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create playlist");
      setBusy(false);
    }
  };

  return (
    <div className="eq-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="eq-modal" role="dialog" aria-modal="true" aria-label="Add to playlist" onClick={(event) => event.stopPropagation()}>
        <div className="section-heading">
          <h2 className="eq-modal-title">Add to playlist</h2>
          <button type="button" className="icon-button compact" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="eq-modal-sub">{item.kind === "album" ? "Album" : "Track"}: {item.title}</p>

        {error ? <div className="empty-panel error-panel"><span>{error}</span></div> : null}

        <div className="add-to-playlist-new">
          <input
            type="text"
            placeholder="New playlist name…"
            value={newName}
            maxLength={60}
            disabled={busy}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void createAndAdd(); }}
          />
          <button type="button" disabled={busy || !newName.trim()} onClick={() => void createAndAdd()}>
            <Plus size={14} /> Create
          </button>
        </div>

        {playlists === null ? (
          <div className="empty-panel">Loading…</div>
        ) : playlists.length === 0 ? (
          <div className="empty-panel">No playlists yet — create one above.</div>
        ) : (
          <ul className="add-to-playlist-list">
            {playlists.map((playlist) => (
              <li key={playlist.id}>
                <button type="button" disabled={busy} onClick={() => void addTo(playlist.id, playlist.name)}>
                  <span>{playlist.name}</span>
                  <small>{playlist.itemCount} {playlist.itemCount === 1 ? "track" : "tracks"}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
