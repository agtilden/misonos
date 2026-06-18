import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

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
  // Same-origin proxy path for the active track, or null if the current audio
  // isn't something MiSonos streams (so we can't analyze it).
  streamPath: string | null;
  startPositionSeconds: number;
  isLive: boolean;
  title?: string;
  subtitle?: string;
  onClose: () => void;
}

interface Spring { angle: number; vel: number }
type Phase = "nostream" | "running" | "blocked" | "error";

export function VuMeter({ streamPath, startPositionSeconds, isLive, title, subtitle, onClose }: VuMeterProps) {
  const [phase, setPhase] = useState<Phase>(streamPath ? "blocked" : "nostream");
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);

  const needleL = useRef<SVGGElement | null>(null);
  const needleR = useRef<SVGGElement | null>(null);
  const ledL = useRef<SVGCircleElement | null>(null);
  const ledR = useRef<SVGCircleElement | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const analysersRef = useRef<{ node: AnalyserNode; data: Float32Array; spring: Spring; led: React.RefObject<SVGCircleElement | null>; needle: React.RefObject<SVGGElement | null>; peakAt: number }[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastNudgeRef = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    elRef.current?.pause();
    if (elRef.current) elRef.current.src = "";
    void ctxRef.current?.close();
    ctxRef.current = null;
    elRef.current = null;
    analysersRef.current = [];
  }, []);

  const runLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const a of analysersRef.current) {
        a.node.getFloatTimeDomainData(a.data as Float32Array<ArrayBuffer>);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < a.data.length; i++) {
          const v = a.data[i];
          sum += v * v;
          const abs = v < 0 ? -v : v;
          if (abs > peak) peak = abs;
        }
        const rms = Math.sqrt(sum / a.data.length);
        const vu = 20 * Math.log10(Math.max(rms, 1e-7)) - ZERO_VU_DBFS;
        const target = vuToAngle(vu);
        const acc = STIFFNESS * (target - a.spring.angle) - DAMPING * a.spring.vel;
        a.spring.vel += acc * dt;
        a.spring.angle += a.spring.vel * dt;
        a.needle.current?.setAttribute("transform", `rotate(${a.spring.angle.toFixed(2)} ${PIVOT_X} ${PIVOT_Y})`);
        const peakVu = 20 * Math.log10(Math.max(peak, 1e-7)) - ZERO_VU_DBFS;
        if (peakVu > 0) a.peakAt = now;
        a.led.current?.setAttribute("opacity", now - a.peakAt < 900 ? "1" : "0.12");
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Resume the (already-built) audio graph and begin metering. Called both
  // automatically (effect) and from the Start button when autoplay was blocked.
  // play()/resume() are kicked off synchronously so a user gesture still counts.
  const begin = useCallback(() => {
    const ctx = ctxRef.current;
    const el = elRef.current;
    if (!ctx || !el) return;
    Promise.all([ctx.resume(), el.play()])
      .then(() => {
        if (!ctxRef.current) return; // torn down meanwhile
        if (!isLive && Number.isFinite(startPositionSeconds) && startPositionSeconds > 0) {
          const seek = () => { try { el.currentTime = startPositionSeconds; } catch { /* not seekable yet */ } };
          if (el.readyState >= 1) seek(); else el.addEventListener("loadedmetadata", seek, { once: true });
        }
        lastNudgeRef.current = 0;
        setError(null);
        setPhase("running");
        runLoop();
      })
      .catch((err: unknown) => {
        if (!ctxRef.current) return;
        const name = err instanceof Error ? err.name : "";
        // Autoplay gating (no gesture yet) isn't an error — fall back to Start.
        if (name === "NotAllowedError" || name === "AbortError") {
          setPhase("blocked");
        } else {
          setError(err instanceof Error ? err.message : "Couldn't start the meter");
          setPhase("error");
        }
      });
  }, [isLive, startPositionSeconds, runLoop]);

  // Build the audio graph for the current track and try to auto-start. The effect
  // owns the lifecycle so a track change (or StrictMode remount) tears down and
  // re-creates cleanly. Auto-start succeeds where the browser allows (e.g. after
  // the click that opened the meter); otherwise it surfaces the Start button.
  useEffect(() => {
    if (!streamPath) { setPhase("nostream"); return; }
    setError(null);
    try {
      const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;
      const el = new Audio();
      el.src = streamPath;
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      elRef.current = el;
      const source = ctx.createMediaElementSource(el);
      const splitter = ctx.createChannelSplitter(2);
      source.connect(splitter);
      // Intentionally NOT connected to ctx.destination — the speakers play the
      // audio; this device only measures it (stays silent).
      const make = (channel: number, needle: typeof needleL, led: typeof ledL) => {
        const node = ctx.createAnalyser();
        node.fftSize = 2048;
        node.smoothingTimeConstant = 0; // our own ballistics
        splitter.connect(node, channel);
        return { node, data: new Float32Array(node.fftSize), spring: { angle: vuToAngle(-20), vel: 0 }, led, needle, peakAt: -Infinity };
      };
      analysersRef.current = [make(0, needleL, ledL), make(1, needleR, ledR)];
      begin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the meter");
      setPhase("error");
    }
    return () => teardown();
  }, [streamPath, begin, teardown]);

  // Re-seek finite tracks when the nudge slider moves (live streams can't seek).
  useEffect(() => {
    const el = elRef.current;
    if (!el || isLive) return;
    const delta = nudge - lastNudgeRef.current;
    lastNudgeRef.current = nudge;
    if (delta !== 0 && Number.isFinite(el.currentTime)) {
      try { el.currentTime = clamp(el.currentTime + delta, 0, el.duration || el.currentTime + delta); } catch { /* ignore */ }
    }
  }, [nudge, isLive]);

  return (
    <div className="vu-overlay" role="dialog" aria-label="VU meter">
      <button type="button" className="vu-close" aria-label="Close VU meter" onClick={onClose}><X size={22} /></button>
      <div className="vu-meters">
        <Gauge label="L" needleRef={needleL} ledRef={ledL} />
        <Gauge label="R" needleRef={needleR} ledRef={ledR} />
      </div>
      <div className="vu-footer">
        {title ? <div className="vu-track"><strong>{title}</strong>{subtitle ? <span> — {subtitle}</span> : null}</div> : null}
        {phase === "nostream" ? (
          <p className="vu-status">No signal — the VU meter reads audio played through MiSonos. Sonos-native sources (Spotify, AirPlay, line-in) can’t be measured.</p>
        ) : phase === "error" ? (
          <p className="vu-status vu-error">{error}</p>
        ) : phase === "blocked" ? (
          <button type="button" className="vu-start" onClick={begin}>▶ Start meter</button>
        ) : !isLive ? (
          <label className="vu-nudge">
            <span>Sync nudge</span>
            <input type="range" min={-3} max={3} step={0.1} value={nudge} onChange={(e) => setNudge(Number(e.target.value))} />
            <span className="vu-nudge-value">{nudge > 0 ? `+${nudge.toFixed(1)}` : nudge.toFixed(1)}s</span>
          </label>
        ) : (
          <p className="vu-status">Live — needles follow the broadcast (a beat ahead of the speaker’s buffer).</p>
        )}
      </div>
    </div>
  );
}
