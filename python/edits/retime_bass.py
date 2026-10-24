"""Edits: encaixa os CORTES de um video curto nos GRAVES de uma musica (e poe a musica por baixo).

Fluxo: acha os golpes de grave da musica (30-130 Hz), testa varios pontos de inicio da musica e, para cada um, planeja
onde cada corte vai parar (programacao dinamica: velocidade do trecho perto de 1, corte perto de onde estava, bonus grande
para cair num grave, bonus pequeno para cair numa batida da grade). Fica com o melhor ponto, corta o video nos cortes,
reajusta a velocidade de cada trecho (setpts) e junta a musica com fade e volume padrao.

    python python/edits/retime_bass.py --video clip.mp4 --music <arquivo|id da lista> --out edit.mp4 [--cuts 2.4 3.0 ...]

--music aceita um caminho ou o id de uma musica da lista em Configuracoes > Musicas (data/music/library.json).
Sem --cuts, os cortes sao detectados pelo ffmpeg. Precisa de um ffmpeg COMPLETO (filtros trim, setpts, concat, afade,
loudnorm, showinfo): o ffmpeg reduzido do Remotion nao serve; aponte com --ffmpeg ou EDITS_FFMPEG. Nada e publicado.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks, stft

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEED_MIN, SPEED_MAX = 0.7, 1.4  # nenhum trecho fica mais lento/rapido que isso
MIN_BASS_FLUX = 0.05              # subida minima de energia no grave para contar como golpe


@dataclass(frozen=True)
class BassAnalysis:
    hits: np.ndarray        # segundos na musica
    strengths: np.ndarray   # z-score do golpe
    period: float           # periodo da batida (s)
    phase: float            # instante de uma batida da grade (s)


def read_mono_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(float) / 32768
    return x, sr


def bass_flux(samples: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """Aumento de energia no grave (30-130 Hz) por quadro, e o passo de tempo de cada quadro."""
    nperseg, hop = 2048, 128
    f, _t, z = stft(samples, sr, nperseg=nperseg, noverlap=nperseg - hop)
    band = np.abs(z)[(f >= 30) & (f <= 130)].sum(0)
    env = np.log1p(band * 20)
    flux = np.convolve(np.maximum(env[1:] - env[:-1], 0), np.ones(3) / 3, mode="same")
    return flux, hop / sr


def analyze_bass(samples: np.ndarray, sr: int, min_z: float = 1.3) -> BassAnalysis:
    flux, step = bass_flux(samples, sr)
    z = (flux - flux.mean()) / (flux.std() + 1e-9)
    peaks, props = find_peaks(z, height=min_z, distance=max(1, int(0.12 / step)))
    real = flux[peaks] >= MIN_BASS_FLUX  # z-score alone would turn leakage from treble clicks into "hits"
    peaks, strengths = peaks[real], props["peak_heights"][real]
    hits = (peaks + 1) * step
    # periodo da batida: pico da autocorrelacao do fluxo entre 0,25 e 0,75 s
    ac = np.correlate(flux - flux.mean(), flux - flux.mean(), "full")[len(flux) - 1:]
    lags = np.arange(len(ac)) * step
    mask = (lags >= 0.25) & (lags <= 0.75)
    period = float(lags[mask][np.argmax(ac[mask])]) if mask.any() and ac[mask].max() > 0 else 0.5
    # fase: media circular dos golpes fortes em relacao a grade
    strong = hits[strengths >= np.percentile(strengths, 50)] if len(hits) else hits
    angle = 2 * math.pi * (strong % period) / period if len(strong) else np.array([0.0])
    phase = float((math.atan2(np.sin(angle).sum(), np.cos(angle).sum()) % (2 * math.pi)) / (2 * math.pi) * period)
    return BassAnalysis(hits, strengths, period, phase)


def plan_cuts(cuts: list[float], hits: np.ndarray, strengths: np.ndarray, grid_t0: float, period: float, *,
              max_shift: float = 0.32, w_speed: float = 3.0, w_shift: float = 5.0, bonus: float = 2.2, w_grid: float = 0.6
              ) -> tuple[list[float] | None, float]:
    """Onde cada corte vai parar (tempo de SAIDA). `hits` ja estao no tempo de saida. None se nao houver plano valido."""
    half = period / 2
    cand: list[list[tuple[float, float]]] = []
    for c in cuts:
        options: dict[float, float] = {}
        for h, s in zip(hits, strengths):
            if abs(h - c) <= max_shift and h > 0.05:
                options[round(float(h), 4)] = -bonus * min(1.0, 0.5 + float(s) / 12)
        k0 = round((c - grid_t0) / half)
        for k in range(k0 - 2, k0 + 3):
            b = grid_t0 + k * half
            if abs(b - c) <= max_shift and b > 0.05:
                options.setdefault(round(float(b), 4), -w_grid * (0.6 if k % 2 else 1.0))
        options.setdefault(round(float(c), 4), 0.0)
        cand.append(sorted(options.items()))
    bounds = [0.0, *cuts]
    best: list[dict[float, tuple[float, float | None]]] = [dict() for _ in cuts]
    for t, bonus_t in cand[0]:
        sp = bounds[1] / t
        if SPEED_MIN <= sp <= SPEED_MAX:
            best[0][t] = (bonus_t + w_speed * math.log(sp) ** 2 + w_shift * (t - cuts[0]) ** 2, None)
    if not best[0]:
        return None, math.inf
    for i in range(1, len(cuts)):
        for t, bonus_t in cand[i]:
            options = []
            for tp, (cost, _) in best[i - 1].items():
                if t <= tp + 0.12:
                    continue
                sp = (cuts[i] - cuts[i - 1]) / (t - tp)
                if SPEED_MIN <= sp <= SPEED_MAX:
                    options.append((cost + bonus_t + w_speed * math.log(sp) ** 2 + w_shift * (t - cuts[i]) ** 2, tp))
            if options:
                best[i][t] = min(options)
        if not best[i]:
            return None, math.inf
    t = min(best[-1], key=lambda k: best[-1][k][0])
    total = best[-1][t][0]
    out = [t]
    for i in range(len(cuts) - 1, 0, -1):
        t = best[i][t][1]  # type: ignore[assignment]
        out.append(t)
    out.reverse()
    return out, total


def best_start(cuts: list[float], analysis: BassAnalysis, start_min: float, start_max: float, step: float = 0.01
               ) -> tuple[float, list[float], float]:
    """Ponto da musica (s) em que ela deve comecar, onde cai cada corte e o custo do plano."""
    half = analysis.period / 2
    best: tuple[float, float, list[float]] | None = None
    for start in np.arange(start_min, start_max, step):
        g0 = (analysis.phase - start) % half
        targets, cost = plan_cuts(cuts, analysis.hits - start, analysis.strengths, g0, analysis.period)
        if targets is not None and (best is None or cost < best[0]):
            best = (cost, float(start), targets)
    if best is None:
        raise SystemExit("nao achei nenhum ponto da musica que encaixe os cortes sem esticar demais os trechos; tente outra musica ou outros cortes")
    return best[1], best[2], best[0]


def build_filtergraph(cuts: list[float], targets: list[float], total: float, fps: int = 30) -> tuple[str, list[float], float]:
    """Filtro do ffmpeg que corta o video nos cortes e reajusta a velocidade de cada trecho. Devolve (filtro, velocidades, duracao)."""
    bounds_in = [0.0, *cuts, total]
    bounds_out = [0.0, *targets, targets[-1] + (total - cuts[-1])]
    parts, speeds = [], []
    for i in range(len(bounds_in) - 1):
        speed = (bounds_in[i + 1] - bounds_in[i]) / (bounds_out[i + 1] - bounds_out[i])
        speeds.append(speed)
        parts.append(f"[0:v]trim=start={bounds_in[i]:.4f}:end={bounds_in[i + 1]:.4f},setpts=(PTS-STARTPTS)/{speed:.5f}[v{i}]")
    n = len(parts)
    parts.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]")
    return ";".join(parts), speeds, bounds_out[-1]


def resolve_music(value: str) -> str:
    """Caminho do arquivo, ou id de uma musica da lista (data/music/library.json)."""
    if os.path.isfile(value):
        return value
    library = REPO_ROOT / "data" / "music" / "library.json"
    if library.is_file():
        for track in json.loads(library.read_text(encoding="utf-8")):
            if track.get("id") == value or str(track.get("name", "")).lower() == value.lower():
                return str(library.parent / track["file"])
    raise SystemExit(f"musica nao encontrada: {value} (passe um arquivo ou o id/nome de uma musica de Configuracoes > Musicas)")


def find_ffmpeg(explicit: str | None) -> str:
    for candidate in (explicit, os.environ.get("EDITS_FFMPEG"), shutil.which("ffmpeg")):
        if candidate:
            return candidate
    raise SystemExit("ffmpeg nao encontrado: passe --ffmpeg ou EDITS_FFMPEG (precisa de um ffmpeg completo, nao o do Remotion)")


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise SystemExit(result.stderr[-1500:])
    return result.stderr


def video_duration(ffmpeg: str, video: str) -> float:
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", video], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if not m:
        raise SystemExit(f"nao consegui ler a duracao de {video}")
    return sum(float(x) * k for x, k in zip(m.groups(), (3600, 60, 1)))


def detect_cuts(ffmpeg: str, video: str, threshold: float = 0.3) -> list[float]:
    err = run([ffmpeg, "-hide_banner", "-i", video, "-vf", f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"])
    return sorted({round(float(t), 3) for t in re.findall(r"pts_time:([0-9.]+)", err)})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Encaixa os cortes de um video nos graves de uma musica.")
    ap.add_argument("--video", required=True)
    ap.add_argument("--music", required=True, help="arquivo ou id/nome da lista de musicas")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cuts", type=float, nargs="*", help="cortes em segundos (padrao: detectados)")
    ap.add_argument("--start-min", type=float, default=0.0, help="a musica nao pode comecar antes disso (s)")
    ap.add_argument("--start-max", type=float, default=None, help="nem depois disso (padrao: ate 6 s antes do fim)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--ffmpeg", default=None)
    args = ap.parse_args(argv)

    ffmpeg = find_ffmpeg(args.ffmpeg)
    music = resolve_music(args.music)
    total = video_duration(ffmpeg, args.video)
    cuts = [c for c in (args.cuts if args.cuts else detect_cuts(ffmpeg, args.video)) if 0.3 < c < total - 0.3]
    if not cuts:
        raise SystemExit("o video nao tem cortes para encaixar (passe --cuts)")

    work = Path(args.out).resolve().parent
    wav = work / "_music_mono.wav"
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", music, "-vn", "-ac", "1", "-ar", "22050", str(wav)])
    samples, sr = read_mono_wav(str(wav))
    wav.unlink(missing_ok=True)
    analysis = analyze_bass(samples, sr)
    song_len = len(samples) / sr
    start_max = args.start_max if args.start_max is not None else max(args.start_min + 0.5, song_len - total - 1)
    start, targets, _cost = best_start(cuts, analysis, args.start_min, start_max)

    on_hit = [bool(len(analysis.hits) and np.min(np.abs(analysis.hits - start - t)) < 0.03) for t in targets]
    graph, speeds, duration = build_filtergraph(cuts, targets, total, args.fps)
    print(f"batida {60 / analysis.period:.0f} bpm; musica comeca em {start:.2f}s; {sum(on_hit)}/{len(targets)} cortes caem num grave (<30 ms)")
    print("cortes:", ", ".join(f"{c:.2f}->{t:.2f}{'*' if h else ''}" for c, t, h in zip(cuts, targets, on_hit)), "(* = grave)")
    print("velocidades:", ", ".join(f"{s:.2f}" for s in speeds))
    fade_at = max(0.0, duration - 1.2)
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", args.video, "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", music,
         "-filter_complex", graph, "-map", "[v]", "-map", "1:a:0", "-r", str(args.fps), "-c:v", "libx264", "-crf", "17", "-preset", "medium",
         "-pix_fmt", "yuv420p", "-af", f"afade=t=in:st=0:d=0.15,afade=t=out:st={fade_at:.3f}:d=1.2,loudnorm=I=-14:TP=-1.5:LRA=11",
         "-c:a", "aac", "-b:a", "192k", args.out])
    print(f"{args.out}: {duration:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
