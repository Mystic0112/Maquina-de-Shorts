// "Terminal" format: no footage; each scene is one animated card inside a terminal window, over a dark grid.
// Our own look (amber accent of the captions, Anton for big text, monospace for the shell), not a copy of any
// creator's template. Frame 0 shows the title card whole (it doubles as the platform's default cover).
import type React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { TerminalCard } from "../../orchestrator/types.js";
import type { TerminalProps, TerminalSceneProps } from "../shared.js";

const ACCENT = "#FFE11A";
const MONO = 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Courier New", monospace';
const BIG = 'Anton, Impact, "Arial Narrow", sans-serif';
const PROMPT = "curiosidades@maquina:~$";
const WINDOW = { left: 60, top: 250, width: 960, height: 1150 };
const TYPE_SECONDS = 0.6;
const SWITCH_FRAMES = 6;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = (frame * 0.6) % 80;
  return (
    <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 35%, #1d1a08 0%, #0a0b0d 55%, #050506 100%)" }}>
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,225,26,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,225,26,0.07) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
          backgroundPosition: `0 ${drift}px`,
          maskImage: "linear-gradient(to bottom, transparent 0%, black 30%, black 80%, transparent 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

/** Characters of `text` typed by `frame` (whole at frame >= duration). */
function typed(text: string, frame: number, durationFrames: number): string {
  if (durationFrames <= 0) return text;
  return text.slice(0, Math.round(interpolate(frame, [0, durationFrames], [0, text.length], clamp)));
}

const Cursor: React.FC<{ frame: number }> = ({ frame }) => (
  <span style={{ display: "inline-block", width: 18, height: 34, marginLeft: 4, verticalAlign: "-4px", background: ACCENT, opacity: Math.floor(frame / 15) % 2 ? 0 : 1 }} />
);

const Window: React.FC<{ file: string; children: React.ReactNode; switchIn: number }> = ({ file, children, switchIn }) => (
  <div
    style={{
      position: "absolute",
      ...WINDOW,
      borderRadius: 28,
      border: "2px solid rgba(255,225,26,0.30)",
      background: "rgba(12,13,16,0.94)",
      boxShadow: "0 0 80px rgba(255,225,26,0.12), 0 30px 80px rgba(0,0,0,0.6)",
      overflow: "hidden",
      opacity: switchIn,
      filter: `blur(${(1 - switchIn) * 8}px)`,
    }}
  >
    <div style={{ height: 70, display: "flex", alignItems: "center", gap: 14, padding: "0 28px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span key={c} style={{ width: 22, height: 22, borderRadius: 11, background: c }} />
      ))}
      <span style={{ flex: 1, textAlign: "center", fontFamily: MONO, fontSize: 28, color: "rgba(255,255,255,0.55)", marginRight: 100 }}>{file}</span>
    </div>
    <div style={{ padding: "36px 48px", height: WINDOW.height - 70, boxSizing: "border-box", display: "flex", flexDirection: "column" }}>{children}</div>
  </div>
);

const PromptLine: React.FC<{ command: string; frame: number; fps: number }> = ({ command, frame, fps }) => {
  const total = Math.round(TYPE_SECONDS * fps);
  const shown = typed(command, frame, total);
  return (
    <div style={{ fontFamily: MONO, fontSize: 32, color: "#f2f2f2", whiteSpace: "nowrap", overflow: "hidden" }}>
      <span style={{ color: ACCENT }}>{PROMPT}</span> ./{shown}
      {frame < total + fps ? <Cursor frame={frame} /> : null}
    </div>
  );
};

/**
 * Font size that keeps the longest word (or, with `whole`, the whole text on one line) inside `width`. 0.6 em per
 * glyph: Anton needs ~0.5, the Impact fallback ~0.56, so a missing font never pushes a word out of the window.
 */
function fitSize(text: string, width: number, max: number, whole = false): number {
  const longest = whole ? text.length : Math.max(...text.split(/\s+/).map((w) => w.length), 1);
  return Math.min(max, Math.floor(width / (Math.max(longest, 1) * 0.6)));
}

const Headline: React.FC<{ card: Extract<TerminalCard, { kind: "headline" }>; frame: number; frames: number }> = ({ card, frame, frames }) => {
  const words = card.text.split(/\s+/);
  const size = fitSize(card.text, 860, 132);
  const revealEnd = Math.max(1, frames * 0.35);
  const hl = card.highlight?.toLowerCase();
  return (
    <div style={{ fontFamily: BIG, fontSize: size, lineHeight: 1.08, color: "#fff", textTransform: "uppercase", display: "flex", flexWrap: "wrap", gap: `0 ${size * 0.28}px` }}>
      {words.map((w, i) => {
        const at = (i / words.length) * revealEnd;
        const t = interpolate(frame, [at, at + 6], [0, 1], clamp);
        const isHl = !!hl && w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").includes(hl.replace(/[^\p{L}\p{N}]/gu, ""));
        return (
          <span key={`${w}-${i}`} style={{ opacity: t, transform: `translateY(${(1 - t) * 30}px)`, color: isHl ? ACCENT : "#fff", position: "relative" }}>
            {w}
            {isHl ? (
              <span style={{ position: "absolute", left: 0, bottom: -6, height: 10, width: `${interpolate(frame, [at + 6, at + 18], [0, 100], clamp)}%`, background: ACCENT }} />
            ) : null}
          </span>
        );
      })}
    </div>
  );
};

/** "1.500 m/s" -> counts 0..1500 then shows the original text. */
function countUp(value: string, progress: number): string {
  const m = /\d+(?:[.,]\d+)*/.exec(value);
  if (!m || progress >= 1) return value;
  const target = Number(m[0].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  if (!Number.isFinite(target)) return value;
  const now = target * progress;
  const decimals = m[0].includes(",") ? 1 : 0;
  const shown = now.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return value.replace(m[0], shown);
}

const NumberCard: React.FC<{ card: Extract<TerminalCard, { kind: "number" }>; frame: number; fps: number }> = ({ card, frame, fps }) => {
  const progress = interpolate(frame, [4, 4 + fps * 0.9], [0, 1], { ...clamp, easing: (t) => 1 - (1 - t) ** 3 });
  const pop = spring({ frame, fps, config: { damping: 12 } });
  return (
    <div>
      <div style={{ fontFamily: BIG, fontSize: fitSize(card.value, 860, 300, true), whiteSpace: "nowrap", color: ACCENT, lineHeight: 1, transform: `scale(${0.8 + 0.2 * pop})`, transformOrigin: "left center", textShadow: "0 0 60px rgba(255,225,26,0.35)" }}>
        {countUp(card.value, progress)}
      </div>
      <div style={{ fontFamily: BIG, fontSize: 64, color: "#fff", textTransform: "uppercase", marginTop: 24, opacity: interpolate(frame, [10, 20], [0, 1], clamp) }}>{card.label}</div>
    </div>
  );
};

const ListCard: React.FC<{ card: Extract<TerminalCard, { kind: "list" }>; frame: number; frames: number }> = ({ card, frame, frames }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
    {card.items.map((item, i) => {
      const at = frames * (0.08 + (0.7 * i) / card.items.length);
      const t = interpolate(frame, [at, at + 8], [0, 1], clamp);
      const checked = frame >= at + 10;
      return (
        <div key={`${item}-${i}`} style={{ display: "flex", alignItems: "center", gap: 28, opacity: 0.25 + 0.75 * t, transform: `translateX(${(1 - t) * 40}px)` }}>
          <span style={{ width: 64, height: 64, flex: "0 0 64px", borderRadius: 12, border: `4px solid ${ACCENT}`, background: checked ? ACCENT : "transparent", color: "#0a0b0d", fontFamily: MONO, fontSize: 44, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {checked ? "✓" : ""}
          </span>
          <span style={{ fontFamily: BIG, fontSize: 70, color: "#fff", textTransform: "uppercase", lineHeight: 1.05 }}>{item}</span>
        </div>
      );
    })}
  </div>
);

const numberOf = (v?: string): number | null => {
  const m = v ? /\d+(?:[.,]\d+)*/.exec(v) : null;
  return m ? Number(m[0].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".")) : null;
};

const CompareCard: React.FC<{ card: Extract<TerminalCard, { kind: "compare" }>; frame: number; fps: number }> = ({ card, frame, fps }) => {
  const a = numberOf(card.leftValue);
  const b = numberOf(card.rightValue);
  const max = a !== null && b !== null && Math.max(a, b) > 0 ? Math.max(a, b) : null;
  const rows = [
    { name: card.left, value: card.leftValue, share: max ? a! / max : 0.55, delay: 0 },
    { name: card.right, value: card.rightValue, share: max ? b! / max : 1, delay: fps * 0.5 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 70 }}>
      {rows.map((r, i) => {
        const grow = interpolate(frame, [r.delay, r.delay + fps * 0.8], [0, 1], { ...clamp, easing: (t) => 1 - (1 - t) ** 3 });
        return (
          <div key={i}>
            <div style={{ fontFamily: BIG, fontSize: 66, color: "#fff", textTransform: "uppercase", marginBottom: 18 }}>{r.name}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ height: 54, width: `${Math.max(4, r.share * 70 * grow)}%`, borderRadius: 10, background: i === 1 ? ACCENT : "rgba(255,225,26,0.35)" }} />
              {r.value ? <span style={{ fontFamily: MONO, fontSize: 40, color: i === 1 ? ACCENT : "#ccc", opacity: grow }}>{r.value}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Card: React.FC<{ card: TerminalCard; frame: number; frames: number; fps: number }> = ({ card, frame, frames, fps }) => {
  switch (card.kind) {
    case "headline":
      return <Headline card={card} frame={frame} frames={frames} />;
    case "number":
      return <NumberCard card={card} frame={frame} fps={fps} />;
    case "list":
      return <ListCard card={card} frame={frame} frames={frames} />;
    case "compare":
      return <CompareCard card={card} frame={frame} fps={fps} />;
  }
};

const fileOf = (command: string): string => `${command.split(/\s+/)[0] || "curiosidade"}.sh`;

const SceneCard: React.FC<{ scene: TerminalSceneProps; frame: number; fps: number }> = ({ scene, frame, fps }) => {
  const local = frame - scene.startFrame;
  const switchIn = interpolate(local, [0, SWITCH_FRAMES], [0, 1], clamp);
  const typeFrames = Math.round(TYPE_SECONDS * fps);
  const cardFrame = local - typeFrames * 0.5;
  return (
    <Window file={fileOf(scene.command)} switchIn={switchIn}>
      <PromptLine command={scene.command} frame={local} fps={fps} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: 60 }}>
        {cardFrame >= 0 ? <Card card={scene.card} frame={cardFrame} frames={scene.durationInFrames - typeFrames * 0.5} fps={fps} /> : null}
      </div>
      {scene.comment ? (
        <div style={{ fontFamily: MONO, fontSize: 30, color: "rgba(255,255,255,0.5)" }}>
          {"// "}
          {typed(scene.comment, local - scene.durationInFrames * 0.45, fps * 0.8)}
        </div>
      ) : null}
    </Window>
  );
};

/** Title card over the hook: whole at frame 0 (cover), the big "?" fades behind. */
const TitleCard: React.FC<{ title: string; frame: number }> = ({ title, frame }) => (
  <Window file="curiosidade.sh" switchIn={1}>
    <div style={{ fontFamily: MONO, fontSize: 32, color: "#f2f2f2" }}>
      <span style={{ color: ACCENT }}>{PROMPT}</span> ./curiosidade --hoje
      <Cursor frame={frame} />
    </div>
    <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
      <span style={{ position: "absolute", right: -20, bottom: 0, fontFamily: BIG, fontSize: 620, color: "rgba(255,225,26,0.07)", lineHeight: 1 }}>?</span>
      <div style={{ fontFamily: BIG, fontSize: fitSize(title, 860, 150), lineHeight: 1.05, color: "#fff", textTransform: "uppercase" }}>{title}</div>
    </div>
  </Window>
);

const Chapters: React.FC<{ scenes: TerminalSceneProps[]; frame: number }> = ({ scenes, frame }) => (
  <div style={{ position: "absolute", left: WINDOW.left, width: WINDOW.width, top: WINDOW.top + WINDOW.height + 40, display: "flex", gap: 12 }}>
    {scenes.map((s) => {
      const fill = interpolate(frame, [s.startFrame, s.startFrame + s.durationInFrames], [0, 100], clamp);
      return (
        <div key={s.sceneIndex} style={{ flex: 1, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
          <div style={{ width: `${fill}%`, height: "100%", background: ACCENT }} />
        </div>
      );
    })}
  </div>
);

export const TerminalLayer: React.FC<{ terminal: TerminalProps }> = ({ terminal }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const current = [...terminal.scenes].reverse().find((s) => frame >= s.startFrame);
  return (
    <AbsoluteFill>
      <Background />
      {frame < terminal.titleEndFrame || !current ? <TitleCard title={terminal.title} frame={frame} /> : <SceneCard key={current.sceneIndex} scene={current} frame={frame} fps={fps} />}
      <Chapters scenes={terminal.scenes} frame={frame} />
    </AbsoluteFill>
  );
};
