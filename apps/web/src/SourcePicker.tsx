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
  // Map of sourceId → version token for user-uploaded logos (used for cache-busting).
  customIcons?: Record<string, string>;
}

// Each source ships an original, brand-coloured emblem at
// `/source-icons/<id>.svg` (NOT the trademarked band logos). A user-uploaded logo
// (served by the bridge at `/api/source-icons/<id>`) takes precedence. Unknown
// sources with no built-in emblem fall back to a generic glyph tile.
const KNOWN_ICONS = new Set(["youtube-music", "grateful-dead-archive", "phish-in", "live-music-archive", "podcasts", "tunein"]);

type IconStage = "custom" | "builtin" | "glyph";

export function ServiceIcon({ sourceId, customVersion }: { sourceId: string; customVersion?: string }) {
  const firstStage: IconStage = customVersion ? "custom" : KNOWN_ICONS.has(sourceId) ? "builtin" : "glyph";
  const [stage, setStage] = useState<IconStage>(firstStage);

  // Reset to the best available source whenever the inputs change (e.g. after upload).
  useEffect(() => { setStage(firstStage); }, [firstStage]);

  if (stage === "custom") {
    return (
      <img
        className="service-icon"
        src={`/api/source-icons/${encodeURIComponent(sourceId)}?v=${encodeURIComponent(customVersion ?? "")}`}
        alt=""
        aria-hidden="true"
        onError={() => setStage(KNOWN_ICONS.has(sourceId) ? "builtin" : "glyph")}
      />
    );
  }

  if (stage === "builtin") {
    return (
      <img
        className="service-icon"
        src={`/source-icons/${sourceId}.svg`}
        alt=""
        aria-hidden="true"
        onError={() => setStage("glyph")}
      />
    );
  }

  return (
    <span className="service-icon" aria-hidden="true" style={{ background: "#3a3f3d", color: "#e8efe9" }}>
      <span className="service-icon-glyph">♪</span>
    </span>
  );
}

export function SourcePicker({ sources, value, onChange, customIcons = {} }: SourcePickerProps) {
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
            <ServiceIcon sourceId={selected.id} customVersion={customIcons[selected.id]} />
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
                <ServiceIcon sourceId={source.id} customVersion={customIcons[source.id]} />
                <span className="source-picker-label">{source.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
