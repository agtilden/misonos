import { useCallback, useEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";

// A full-screen, vintage-hi-fi VU meter. It analyzes the SAME proxy stream the
// speaker is playing (same-origin /api/stream/...) with the Web Audio API on the
// displaying device — so the needles map to the actual audio content. Sonos
// exposes no output level, so this only works for MiSonos-played (proxied)
// sources; Sonos-native audio (Spotify/AirPlay/line-in) shows "No signal".

// --- VU spec (see en.wikipedia.org/wiki/VU_meter) -------------------------------
// Measures average/RMS (loudness), 300ms ballistics, scale -20..+3 with 0 VU and
// a red zone above it. 0 VU here = ZERO_VU_DBFS RMS, tuned so typical music sits
// near 0 without pegging (digital alignment is -18/-20; -14 dances better).
const ZERO_VU_DBFS = -14;
const SCALE_TICKS = [-20, -10, -7, -5, -3, -1, 0, 1, 2, 3];
const ANGLE_MIN = -52;
const ANGLE_MAX = 52;
const PIVOT_X = 200;
const PIVOT_Y = 206;
const ARC_R = 170;

// Needle ballistics: a near-critically-damped 2nd-order follower (~300ms to rest,
// a hair of overshoot — the characteristic lazy VU swing).
const OMEGA = 18; // rad/s
const ZETA = 0.9;
const STIFFNESS = OMEGA * OMEGA;
const DAMPING = 2 * ZETA * OMEGA;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ampOf = (vu: number) => Math.pow(10, vu / 20);
const A_MIN = ampOf(-20);
const A_MAX = ampOf(3);

// Needle deflection is linear in amplitude (voltage); the dB scale is therefore
// compressed at the low end, exactly like a real VU face.
function vuToAngle(vu: number): number {
  const t = clamp((ampOf(vu) - A_MIN) / (A_MAX - A_MIN), 0, 1);
  return ANGLE_MIN + t * (ANGLE_MAX - ANGLE_MIN);
}
function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [PIVOT_X + r * Math.sin(a), PIVOT_Y - r * Math.cos(a)];
}
function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(a0, r);
  const [x1, y1] = polar(a1, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

interface GaugeProps {
  label: string;
  needleRef: React.RefObject<SVGGElement | null>;
  ledRef: React.RefObject<SVGCircleElement | null>;
}

function Gauge({ label, needleRef, ledRef }: GaugeProps) {
  const restAngle = vuToAngle(-20);
  return (
    <svg className="vu-gauge" viewBox="0 0 400 248" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${label} channel VU meter`}>
      <defs>
        <radialGradient id={`vu-face-${label}`} cx="50%" cy="78%" r="90%">
          <stop offset="0%" stopColor="#fbf3dd" />
          <stop offset="70%" stopColor="#f3e6c4" />
          <stop offset="100%" stopColor="#e7d3a6" />
        </radialGradient>
      </defs>
      <rect x="6" y="6" width="388" height="236" rx="14" fill={`url(#vu-face-${label})`} stroke="#3a3226" strokeWidth="2" />
      {/* baseline arc */}
      <path d={arcPath(ARC_R, ANGLE_MIN, ANGLE_MAX)} fill="none" stroke="#3a3226" strokeWidth="2" />
      {/* red zone (0 .. +3 VU) */}
      <path d={arcPath(ARC_R, vuToAngle(0), vuToAngle(3))} fill="none" stroke="#c0241c" strokeWidth="6" strokeLinecap="round" />
      {/* ticks + labels */}
      {SCALE_TICKS.map((vu) => {
        const ang = vuToAngle(vu);
        const major = vu % 5 === 0 || vu === 0 || vu === 3 || vu === -3;
        const [xo, yo] = polar(ang, ARC_R);
        const [xi, yi] = polar(ang, ARC_R - (major ? 16 : 10));
        const [xl, yl] = polar(ang, ARC_R - 30);
        const over = vu >= 0;
        return (
          <g key={vu}>
            <line x1={xo} y1={yo} x2={xi} y2={yi} stroke={over ? "#c0241c" : "#3a3226"} strokeWidth={major ? 2.4 : 1.2} />
            {major ? (
              <text x={xl} y={yl} textAnchor="middle" dominantBaseline="middle" fontSize="15" fontWeight="600" fill={over ? "#c0241c" : "#2c251b"} fontFamily="'Helvetica Neue', Arial, sans-serif">
                {vu > 0 ? `+${vu}` : vu}
              </text>
            ) : null}
          </g>
        );
      })}
      <text x={PIVOT_X} y={PIVOT_Y - 86} textAnchor="middle" fontSize="20" fontWeight="700" letterSpacing="3" fill="#2c251b" fontFamily="'Helvetica Neue', Arial, sans-serif">VU</text>
      <text x={PIVOT_X} y="232" textAnchor="middle" fontSize="13" letterSpacing="2" fill="#6b6048" fontFamily="'Helvetica Neue', Arial, sans-serif">{label}</text>
      {/* peak LED */}
      <circle ref={ledRef} cx={PIVOT_X + 120} cy="58" r="7" fill="#ff3b30" opacity="0.12" />
      <text x={PIVOT_X + 120} y="82" textAnchor="middle" fontSize="9" letterSpacing="1" fill="#6b6048" fontFamily="'Helvetica Neue', Arial, sans-serif">PEAK</text>
      {/* needle */}
      <g ref={needleRef} transform={`rotate(${restAngle} ${PIVOT_X} ${PIVOT_Y})`}>
        <line x1={PIVOT_X} y1={PIVOT_Y + 14} x2={PIVOT_X} y2={PIVOT_Y - ARC_R + 6} stroke="#1c1812" strokeWidth="2.4" strokeLinecap="round" />
      </g>
      <circle cx={PIVOT_X} cy={PIVOT_Y} r="9" fill="#2c251b" />
      <circle cx={PIVOT_X} cy={PIVOT_Y} r="3.5" fill="#7a6f55" />
    </svg>
  );
}

interface VuMeterProps {
  // Local "this device" mode: tap the already-playing audio graph (perfect sync,
  // no second download).
  getAnalysers?: () => { left: AnalyserNode; right: AnalyserNode } | null;
  // Sonos mode: SSE endpoint streaming per-window levels the bridge decoded from
  // the bytes it's already sending the speaker.
  meterUrl?: string | null;
  // Sonos finite tracks: current playback position (seconds) for window indexing.
  getPosition?: () => number;
  isLive: boolean;
  // Speaker/local transport state — when not playing, the animation halts.
  isPlaying: boolean;
  title?: string;
  subtitle?: string;
  onClose: () => void;
}

interface Spring { angle: number; vel: number }
interface Channel { needle: React.RefObject<SVGGElement | null>; led: React.RefObject<SVGCircleElement | null>; spring: Spring; peakAt: number }
type Frame = { lr: number; rr: number; lp: number; rp: number };

export function VuMeter({ getAnalysers, meterUrl, getPosition, isLive, isPlaying, title, subtitle, onClose }: VuMeterProps) {
  const [active, setActive] = useState(false);
  const [nudge, setNudge] = useState(0);
  const [footerOpen, setFooterOpen] = useState(true);

  const local = !!getAnalysers;
  const noSignal = !local && !meterUrl;

  const needleL = useRef<SVGGElement | null>(null);
  const needleR = useRef<SVGGElement | null>(null);
  const ledL = useRef<SVGCircleElement | null>(null);
  const ledR = useRef<SVGCircleElement | null>(null);

  const sampleRef = useRef<(() => Frame | null) | null>(null);
  const nudgeRef = useRef(0);
  const getPositionRef = useRef(getPosition);
  const rafRef = useRef<number | null>(null);
  const channelsRef = useRef<[Channel, Channel] | null>(null);

  useEffect(() => { nudgeRef.current = nudge; }, [nudge]);
  useEffect(() => { getPositionRef.current = getPosition; });

  const ensureChannels = useCallback((): [Channel, Channel] => {
    if (!channelsRef.current) {
      channelsRef.current = [
        { needle: needleL, led: ledL, spring: { angle: vuToAngle(-20), vel: 0 }, peakAt: -Infinity },
        { needle: needleR, led: ledR, spring: { angle: vuToAngle(-20), vel: 0 }, peakAt: -Infinity }
      ];
    }
    return channelsRef.current;
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const restNeedles = useCallback(() => {
    const rest = vuToAngle(-20);
    for (const ch of ensureChannels()) {
      ch.spring.angle = rest;
      ch.spring.vel = 0;
      ch.needle.current?.setAttribute("transform", `rotate(${rest.toFixed(2)} ${PIVOT_X} ${PIVOT_Y})`);
      ch.led.current?.setAttribute("opacity", "0.12");
    }
  }, [ensureChannels]);

  const runLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const chans = ensureChannels();
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const frame = sampleRef.current?.() ?? null;
      const rms = [frame?.lr ?? 0, frame?.rr ?? 0];
      const peak = [frame?.lp ?? 0, frame?.rp ?? 0];
      for (let i = 0; i < 2; i++) {
        const ch = chans[i];
        const vu = 20 * Math.log10(Math.max(rms[i], 1e-7)) - ZERO_VU_DBFS;
        const target = vuToAngle(vu);
        const acc = STIFFNESS * (target - ch.spring.angle) - DAMPING * ch.spring.vel;
        ch.spring.vel += acc * dt;
        ch.spring.angle += ch.spring.vel * dt;
        ch.needle.current?.setAttribute("transform", `rotate(${ch.spring.angle.toFixed(2)} ${PIVOT_X} ${PIVOT_Y})`);
        const peakVu = 20 * Math.log10(Math.max(peak[i], 1e-7)) - ZERO_VU_DBFS;
        if (peakVu > 0) ch.peakAt = now;
        ch.led.current?.setAttribute("opacity", now - ch.peakAt < 900 ? "1" : "0.12");
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [ensureChannels]);

  // Local tap: read this device's already-playing audio graph.
  useEffect(() => {
    if (!getAnalysers) return;
    const nodes = getAnalysers();
    if (!nodes) { setActive(false); return; }
    const data = new Float32Array(nodes.left.fftSize);
    const read = (node: AnalyserNode) => {
      node.getFloatTimeDomainData(data as Float32Array<ArrayBuffer>);
      let sum = 0, peak = 0;
      for (let i = 0; i < data.length; i++) { const v = data[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
      return { rms: Math.sqrt(sum / data.length), peak };
    };
    sampleRef.current = () => {
      const l = read(nodes.left);
      const r = read(nodes.right);
      return { lr: l.rms, rr: r.rms, lp: l.peak, rp: r.peak };
    };
    setActive(true);
    return () => { sampleRef.current = null; };
  }, [getAnalysers]);

  // Sonos: consume bridge-decoded level windows over SSE; index by playback position.
  useEffect(() => {
    if (getAnalysers || !meterUrl) { if (!getAnalysers) setActive(false); return; }
    const es = new EventSource(meterUrl);
    let windowSec = 0.04;
    const windows: number[][] = [];
    es.addEventListener("init", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { windowMs: number; windows: number[][] };
        windowSec = (d.windowMs || 40) / 1000;
        windows.length = 0;
        windows.push(...d.windows);
        setActive(true);
      } catch { /* ignore */ }
    });
    es.addEventListener("w", (e) => {
      const p = (e as MessageEvent).data.split(",");
      windows.push([Number(p[0]), Number(p[1]), Number(p[2]), Number(p[3])]);
    });
    sampleRef.current = () => {
      if (windows.length === 0) return null;
      const idx = isLive
        ? windows.length - 1
        : Math.floor(Math.max(0, (getPositionRef.current?.() ?? 0) + nudgeRef.current) / windowSec);
      const w = windows[Math.max(0, Math.min(windows.length - 1, idx))];
      return w ? { lr: w[0], rr: w[1], lp: w[2], rp: w[3] } : null;
    };
    setActive(true);
    return () => { es.close(); sampleRef.current = null; };
  }, [getAnalysers, meterUrl, isLive]);

  // Run the animation while playing; halt + rest when paused/stopped.
  useEffect(() => {
    if (!active) { stopLoop(); return; }
    if (isPlaying) runLoop();
    else { stopLoop(); restNeedles(); }
  }, [active, isPlaying, runLoop, stopLoop, restNeedles]);

  useEffect(() => () => stopLoop(), [stopLoop]);

  return (
    <div className="vu-overlay" role="dialog" aria-label="VU meter">
      <div className="vu-topbar">
        {!footerOpen ? (
          <button type="button" className="vu-icon-btn" aria-label="Show info" title="Show info" onClick={() => setFooterOpen(true)}><Info size={20} /></button>
        ) : null}
        <button type="button" className="vu-icon-btn" aria-label="Close VU meter" title="Close" onClick={onClose}><X size={22} /></button>
      </div>
      <div className="vu-meters">
        <Gauge label="L" needleRef={needleL} ledRef={ledL} />
        <Gauge label="R" needleRef={needleR} ledRef={ledR} />
      </div>
      {footerOpen ? (
        <div className="vu-footer">
          {title ? <div className="vu-track"><strong>{title}</strong>{subtitle ? <span> — {subtitle}</span> : null}</div> : null}
          <div className="vu-controls">
            {noSignal ? (
              <p className="vu-status">No signal — the VU meter reads audio played through MiSonos. Sonos-native sources (Spotify, AirPlay, line-in) can’t be measured.</p>
            ) : local ? (
              <p className="vu-status">This device — perfectly in sync.</p>
            ) : isLive ? (
              <p className="vu-status">Live — needles follow the broadcast.</p>
            ) : (
              <label className="vu-nudge">
                <span>Sync nudge</span>
                <input type="range" min={-3} max={3} step={0.1} value={nudge} onChange={(e) => setNudge(Number(e.target.value))} />
                <span className="vu-nudge-value">{nudge > 0 ? `+${nudge.toFixed(1)}` : nudge.toFixed(1)}s</span>
              </label>
            )}
            <button type="button" className="vu-hide" aria-label="Hide info" title="Hide controls" onClick={() => setFooterOpen(false)}><X size={16} /></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
