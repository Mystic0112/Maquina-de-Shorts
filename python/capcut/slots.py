"""Troca VARIAS midias (fotos ou videos) de um projeto-mestre do CapCut, espaco por espaco, mantendo a duracao de cada um.

Fluxo do "template por codigo": o dono monta UMA vez no CapCut um projeto a partir de um template (as fotos de teste
entram nos espacos) e a Maquina clona esse projeto trocando cada foto pela nova. Os cortes, a musica, os efeitos e as
transicoes continuam os do mestre porque os `material_id` e os tempos dos segmentos nao mudam; so o arquivo de cada
material muda. Tudo e dado JSON em texto (ver planejamento/capcut-templates-automacao.md); nada e publicado.

A parte pura (`swap_slots`) trabalha em dicionarios e e testada em test_slots.py sem o CapCut. `build_project` faz a
copia da pasta e grava os JSON; rode com o CapCut FECHADO e confira abrindo o projeto no editor (o formato nao e oficial).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field

import clone_draft as cd

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic", ".avif"}
PHOTO_DURATION_US = 10_800_000_000  # o CapCut guarda foto com 3 h de "duracao"


@dataclass
class Media:
    path: str            # caminho absoluto, com barra normal
    name: str
    kind: str            # "photo" | "video"
    width: int
    height: int
    duration_us: int | None = None  # so para video


@dataclass
class SwapReport:
    slots: int = 0
    swapped: list[tuple[int, str]] = field(default_factory=list)  # (indice do espaco, arquivo)
    warnings: list[str] = field(default_factory=list)


def media_kind(path: str) -> str:
    return "photo" if os.path.splitext(path)[1].lower() in IMAGE_EXT else "video"


def probe_media(path: str, ffprobe: str | None = None) -> Media:
    ffprobe = ffprobe or cd.find_ffprobe()
    out = subprocess.check_output(
        [ffprobe, "-v", "quiet", "-print_format", "json", "-show_entries",
         "stream=codec_type,width,height,duration:format=duration", path], text=True)
    info = json.loads(out)
    w = h = 0
    dur = None
    for s in info.get("streams", []):
        if s.get("codec_type") == "video":
            w, h = int(s.get("width") or 0), int(s.get("height") or 0)
            if s.get("duration"):
                dur = float(s["duration"])
            break
    if not (w and h):
        raise ValueError(f"nao consegui ler as dimensoes de: {path}")
    kind = media_kind(path)
    if kind == "video" and dur is None:
        dur = float(info.get("format", {}).get("duration") or 0)
    absolute = os.path.abspath(path).replace("\\", "/")
    return Media(absolute, os.path.basename(path), kind, w, h,
                 int(round(dur * 1_000_000)) if kind == "video" and dur else None)


def video_track_slots(content: dict, track_index: int = 0) -> list[dict]:
    """Segmentos da trilha de video `track_index`, na ordem em que aparecem na timeline."""
    tracks = [t for t in content.get("tracks", []) if t.get("type") == "video"]
    if track_index >= len(tracks):
        raise ValueError(f"o projeto tem {len(tracks)} trilha(s) de video; pedi a de indice {track_index}")
    return sorted(tracks[track_index].get("segments", []), key=lambda s: s["target_timerange"]["start"])


def swap_slots(content: dict, meta: dict, media: list[Media], *, track_index: int = 0,
               cycle: bool = False) -> SwapReport:
    """Troca, no lugar, o material de cada espaco pela midia de mesma posicao. Mantem `id`, efeitos e tempos."""
    report = SwapReport()
    slots = video_track_slots(content, track_index)
    report.slots = len(slots)
    if not slots:
        raise ValueError("a trilha de video escolhida nao tem segmentos")
    if not media:
        raise ValueError("nenhuma midia para colocar nos espacos")
    if len(media) < len(slots) and not cycle:
        raise ValueError(f"o mestre tem {len(slots)} espacos e so recebi {len(media)} midia(s); use cycle para repetir")
    if len(media) > len(slots):
        report.warnings.append(f"{len(media) - len(slots)} midia(s) a mais do que espacos: as ultimas foram ignoradas")

    by_id = {v["id"]: v for v in content["materials"].get("videos", [])}
    for i, seg in enumerate(slots):
        m = media[i % len(media)]
        mat = by_id.get(seg["material_id"])
        if mat is None:
            raise ValueError(f"o espaco {i} aponta para um material que nao existe: {seg['material_id']}")
        old_local_id, old_path = mat.get("local_material_id", ""), mat.get("path", "")
        slot_us = seg["target_timerange"]["duration"]

        mat["path"], mat["material_name"] = m.path, m.name
        mat["width"], mat["height"], mat["type"] = m.width, m.height, m.kind
        if m.kind == "photo":
            mat["duration"] = PHOTO_DURATION_US
            seg["source_timerange"] = {"start": 0, "duration": slot_us}
        else:
            mat["duration"] = m.duration_us
            usable = min(slot_us, m.duration_us or 0)
            if (m.duration_us or 0) < slot_us:
                report.warnings.append(
                    f"espaco {i}: {m.name} dura {(m.duration_us or 0) / 1e6:.1f}s e o espaco {slot_us / 1e6:.1f}s")
            seg["source_timerange"] = {"start": 0, "duration": usable}

        for group in meta.get("draft_materials", []):
            for item in group.get("value", []) or []:
                if (item.get("id") == old_local_id and old_local_id) or (old_path and item.get("file_Path") == old_path):
                    item["file_Path"], item["extra_info"] = m.path, m.name
                    item["width"], item["height"] = m.width, m.height
                    item["duration"] = mat["duration"]
        report.swapped.append((i, m.name))
    return report


def safe_folder_name(name: str) -> str:
    """O CapCut mostra o NOME DA PASTA como nome do projeto: tira so o que o Windows nao aceita."""
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "projeto"


def build_project(draft_root: str, src_id: str, media_paths: list[str], name: str, *,
                  track_index: int = 0, cycle: bool = False) -> tuple[str, SwapReport]:
    """Clona a pasta `src_id` como `name` e troca as midias dos espacos. O mestre fica intacto."""
    src_dir = os.path.join(draft_root, src_id)
    if not os.path.isdir(src_dir):
        raise FileNotFoundError(f"rascunho de origem nao existe: {src_dir}")
    media = [probe_media(p) for p in media_paths]
    dst_name = safe_folder_name(name)
    dst_dir = os.path.join(draft_root, dst_name)
    if os.path.exists(dst_dir):
        raise FileExistsError(f"ja existe um projeto com esse nome: {dst_dir} (escolha outro --name)")

    content = cd.load_json(os.path.join(src_dir, "draft_content.json"))
    meta = cd.load_json(os.path.join(src_dir, "draft_meta_info.json"))
    report = swap_slots(content, meta, media, track_index=track_index, cycle=cycle)  # valida antes de copiar a pasta

    shutil.copytree(src_dir, dst_dir)
    dst_fwd, src_fwd = dst_dir.replace("\\", "/"), src_dir.replace("\\", "/")
    now_us = int(time.time() * 1_000_000)
    content["id"] = cd.new_guid()
    cd.dump_json(os.path.join(dst_dir, "draft_content.json"), content)
    bak = os.path.join(dst_dir, "draft_content.json.bak")
    if os.path.exists(bak):
        cd.dump_json(bak, content)
    for tmp in ("template.tmp", "template-2.tmp"):
        p = os.path.join(dst_dir, tmp)
        if os.path.exists(p):
            os.remove(p)

    meta.update({"draft_fold_path": dst_fwd, "draft_id": cd.new_guid(), "draft_name": name,
                 "tm_duration": content.get("duration", meta.get("tm_duration", 0)),
                 "tm_draft_create": now_us, "tm_draft_modified": now_us})
    cd.dump_json(os.path.join(dst_dir, "draft_meta_info.json"), meta)

    for aux in ("draft.extra", "draft_virtual_store.json", "key_value.json", "attachment_editing.json"):
        p = os.path.join(dst_dir, aux)
        if not os.path.isfile(p):
            continue
        txt = open(p, "r", encoding="utf-8").read()
        new_txt = txt.replace(src_fwd, dst_fwd).replace(src_dir, dst_dir).replace(src_id, dst_name)
        if new_txt != txt:
            open(p, "w", encoding="utf-8").write(new_txt)
    return dst_dir, report
