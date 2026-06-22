import { useState } from "react";
import { ArrowRightCircle, MapPin, Plus, Trash2 } from "lucide-react";
import { isCurrent, loadServers, normalizeUrl, saveServers, switchToServer, type MisonosServer } from "./servers.js";

// Switch the app between MiSonos hosts on different networks (e.g. a different house).
// "Switching" repoints the API at the chosen host's bridge and reloads in place — the
// browser stays on the origin it was opened from, so an installed PWA never leaves its
// scope (which is what triggers Chrome's out-of-scope banner). See servers.ts.
export function Locations() {
  const [servers, setServers] = useState<MisonosServer[]>(() => loadServers());
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const add = () => {
    const origin = normalizeUrl(url);
    if (!origin) { setError("Enter a valid address, e.g. http://shore-host:4317"); return; }
    setError("");
    setServers(saveServers([...servers, { name: name.trim() || new URL(origin).hostname, url: origin }]));
    setName("");
    setUrl("");
  };

  const remove = (server: MisonosServer) => setServers(saveServers(servers.filter((s) => s.url !== server.url)));

  const startRename = (server: MisonosServer) => { setEditingUrl(server.url); setEditName(server.name); };
  const commitRename = () => {
    if (editingUrl === null) return;
    const trimmed = editName.trim();
    if (trimmed) setServers(saveServers(servers.map((s) => (s.url === editingUrl ? { ...s, name: trimmed } : s))));
    setEditingUrl(null);
  };

  return (
    <section className="queue-panel" aria-label="MiSonos locations">
      <div className="section-heading"><h2>Locations</h2></div>
      <p className="settings-hint">
        Point the app at a MiSonos server on another network — a different house, say.
      </p>
      <ul className="locations-list">
        {servers.map((server) => (
          <li key={server.url} className={`location-row${isCurrent(server) ? " current" : ""}`}>
            <MapPin size={16} aria-hidden="true" />
            <div className="location-meta">
              {editingUrl === server.url ? (
                <input
                  className="location-name-edit"
                  autoFocus
                  value={editName}
                  maxLength={40}
                  onChange={(event) => setEditName(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => { if (event.key === "Enter") commitRename(); if (event.key === "Escape") setEditingUrl(null); }}
                />
              ) : (
                <button type="button" className="location-name" title="Rename" onClick={() => startRename(server)}>{server.name}</button>
              )}
              <small>{server.url}</small>
            </div>
            {isCurrent(server) ? (
              <span className="location-badge">Connected</span>
            ) : (
              <>
                <button type="button" className="location-switch" onClick={() => switchToServer(server)} title={`Switch to ${server.name}`}>
                  <ArrowRightCircle size={16} /> Switch
                </button>
                <button type="button" className="icon-button compact" aria-label={`Remove ${server.name}`} onClick={() => remove(server)}>
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="location-add">
        <input type="text" placeholder="Name (e.g. Shore)" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
        <input
          type="text"
          placeholder="Address (e.g. http://shore-host:4317)"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") add(); }}
        />
        <button type="button" disabled={!url.trim()} onClick={add}><Plus size={14} /> Add</button>
      </div>
      {error ? <div className="service-result error">{error}</div> : null}
    </section>
  );
}
