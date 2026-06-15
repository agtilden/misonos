import { useEffect, useRef, useState } from "react";
import { AudioLines, ChevronDown, Pause, Play } from "lucide-react";
import { IconCategoryPlus } from "@tabler/icons-react";
import type { PlaybackState } from "@misonos/sonos-protocol";
import { hexToRgba, type GroupOption } from "./groupPalette.js";

interface GroupDropdownProps {
  options: GroupOption[];
  selectedId?: string;
  selectedOption?: GroupOption;
  onSelect: (groupId: string) => void;
  onEditGroups?: () => void;
  playback?: Record<string, PlaybackState>;
  onTogglePlay?: (groupId: string, playing: boolean) => void;
  onPauseAll?: () => void;
  onOpen?: () => void;
}

export function GroupDropdown({ options, selectedId, selectedOption, onSelect, onEditGroups, playback = {}, onTogglePlay, onPauseAll, onOpen }: GroupDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anyPlaying = Object.values(playback).some((state) => state === "PLAYING");

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      if (next) onOpen?.();
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (options.length === 0) {
    return <div className="topbar-group-empty">No groups</div>;
  }

  return (
    <div className="topbar-group" ref={containerRef}>
      <button
        type="button"
        className="topbar-group-trigger"
        style={selectedOption ? { background: hexToRgba(selectedOption.color, 0.18), borderColor: hexToRgba(selectedOption.color, 0.55) } : undefined}
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedOption ? (
          <>
            <span className="group-color-chip" style={{ background: selectedOption.color }} aria-hidden="true" />
            {selectedId && playback[selectedId] === "PLAYING" ? (
              <AudioLines size={15} className="group-playing-indicator playing" aria-label="Playing" />
            ) : null}
            <span className="topbar-group-label">
              <strong>{selectedOption.name}</strong>
              {selectedOption.zoneList ? <small>{selectedOption.zoneList}</small> : null}
            </span>
          </>
        ) : (
          <span className="topbar-group-label"><strong>Select group</strong></span>
        )}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="topbar-group-menu" role="listbox">
          {options.map((option) => {
            const playing = playback[option.id] === "PLAYING";
            return (
              <li key={option.key} className="topbar-group-option">
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === selectedId}
                  className={option.id === selectedId ? "selected" : undefined}
                  style={{ background: hexToRgba(option.color, 0.18), borderColor: hexToRgba(option.color, 0.55) }}
                  onClick={() => { onSelect(option.id); setOpen(false); }}
                >
                  <span className="group-color-chip" style={{ background: option.color }} aria-hidden="true" />
                  {playing ? <AudioLines size={15} className="group-playing-indicator playing" aria-label="Playing" /> : null}
                  <span className="topbar-group-label">
                    <strong>{option.name}</strong>
                    {option.zoneList ? <small>{option.zoneList}</small> : null}
                  </span>
                </button>
                {onTogglePlay ? (
                  <button
                    type="button"
                    className="group-play-toggle"
                    title={playing ? `Pause ${option.name}` : `Play ${option.name}`}
                    aria-label={playing ? `Pause ${option.name}` : `Play ${option.name}`}
                    onClick={(event) => { event.stopPropagation(); onTogglePlay(option.id, playing); }}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                ) : null}
              </li>
            );
          })}
          {onPauseAll || onEditGroups ? <li className="topbar-group-menu-separator" aria-hidden="true" /> : null}
          {onPauseAll ? (
            <li>
              <button
                type="button"
                className="topbar-group-menu-action"
                disabled={!anyPlaying}
                onClick={() => { onPauseAll(); setOpen(false); }}
              >
                <Pause size={16} aria-hidden="true" />
                <span className="topbar-group-label"><strong>Pause all zones</strong></span>
              </button>
            </li>
          ) : null}
          {onEditGroups ? (
            <li>
              <button
                type="button"
                className="topbar-group-menu-action"
                onClick={() => { onEditGroups(); setOpen(false); }}
              >
                <IconCategoryPlus size={16} aria-hidden="true" />
                <span className="topbar-group-label"><strong>Edit Groups</strong></span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
