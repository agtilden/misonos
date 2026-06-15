import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

interface SourceOption {
  id: string;
  name: string;
}

interface SourcePickerProps {
  sources: SourceOption[];
  value: string | null;
  onChange: (id: string) => void;
}

// Each source ships an original, brand-coloured emblem at
// `/source-icons/<id>.svg` (NOT the trademarked band logos). To use a real logo,
// replace that file in `apps/web/public/source-icons/`. Unknown sources fall back
// to a generic glyph tile.
const KNOWN_ICONS = new Set(["youtube-music", "grateful-dead-archive", "phish-in", "live-music-archive"]);

function ServiceIcon({ sourceId }: { sourceId: string }) {
  const [failed, setFailed] = useState(false);

  if (KNOWN_ICONS.has(sourceId) && !failed) {
    return (
      <img
        className="service-icon"
        src={`/source-icons/${sourceId}.svg`}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className="service-icon" aria-hidden="true" style={{ background: "#3a3f3d", color: "#e8efe9" }}>
      <span className="service-icon-glyph">♪</span>
    </span>
  );
}

export function SourcePicker({ sources, value, onChange }: SourcePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selected = sources.find((source) => source.id === value) ?? sources[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (sources.length === 0) {
    return <div className="source-picker-empty">No sources</div>;
  }

  return (
    <div className="source-picker" ref={containerRef}>
      <button
        type="button"
        className="source-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            <ServiceIcon sourceId={selected.id} />
            <span className="source-picker-label">{selected.name}</span>
          </>
        ) : (
          <span className="source-picker-label">Select source</span>
        )}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="source-picker-menu" role="listbox">
          {sources.map((source) => (
            <li key={source.id} className="source-picker-option">
              <button
                type="button"
                role="option"
                aria-selected={source.id === selected?.id}
                className={source.id === selected?.id ? "selected" : undefined}
                onClick={() => { onChange(source.id); setOpen(false); }}
              >
                <ServiceIcon sourceId={source.id} />
                <span className="source-picker-label">{source.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
