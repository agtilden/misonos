# Screenshots

Drop PNG screenshots here with these exact filenames so they show up in the
top-level `README.md`:

| File | View |
| --- | --- |
| `now-playing.jpg` | Main screen with a track playing (artwork + transport) |
| `now-playing-zones.jpg` | Now playing with the zones / group view |
| `music-browse.jpg` | The Music browser (a source's list of albums/episodes) |
| `zone-editor.jpg` | The group/zone editor |
| `eq-editor.jpg` | The EQ editor modal |

You can add more and reference them from the README the same way.

## How to capture

1. Run the app: `npm run dev` (then open `http://127.0.0.1:6173`) — or `npm start`
   for the production build.
2. Navigate to the view you want.
3. Capture it:
   - **macOS:** `⌘⇧4` then drag to select a region (or `⌘⇧5` for window/options).
     Screenshots save to your Desktop by default.
   - **Windows:** `Win+Shift+S` (Snipping Tool).
4. Rename the file to one of the names above and move it into this folder
   (`docs/screenshots/`).
5. Commit it. GitHub renders the README images from these relative paths.

Tip: keep images reasonably sized (e.g. ~1000px wide, < ~500 KB each) so the
README loads quickly. A phone-sized portrait capture also looks good since the
PWA is designed for mobile.
