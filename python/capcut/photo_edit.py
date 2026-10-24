"""Gera um projeto CapCut (slideshow de FOTOS) do zero, em texto aberto.

Pega uma pasta de imagens e monta um draft 1080x1920 com uma foto por segmento, cada uma
com zoom (keyframe de escala tipo Ken Burns) e cortes secos. Transicoes com recurso baixado
ficam de fora (parte fragil); adicionar depois que confirmar que abre.

Para garantir que abra nesta versao do CapCut, reusa o rascunho `0116` (que sabidamente abre)
como SCAFFOLD: copia a pasta dele e reaproveita o formato exato de segmento/material desta
versao, trocando o conteudo por fotos. Ver `planejamento/capcut-templates-automacao.md`.

Formato confirmado na fonte do pyJianYingDraft:
  - material foto: type="photo", duration=10800000000 us, width/height da imagem.
  - keyframe de escala: common_keyframes -> property_type "UNIFORM_SCALE", pontos com
    time_offset (us, relativo ao segmento) e values=[escala].

Uso (rodar com o CapCut FECHADO):
    python python/capcut/photo_edit.py --images-dir "C:/fotos/meu carro" --name "Meu Edit"
    python python/capcut/photo_edit.py --per-sec 2.0 --zoom 0.15
"""
from __future__ import annotations

import argparse
import copy
import glob
import json
import os
import shutil
import subprocess
import sys
import time

# reusa helpers do modulo irmao (mesma pasta entra no sys.path ao rodar o arquivo)
from clone_draft import (DEFAULT_USER_DATA, PROJECT_DIR, dump_json, find_ffprobe,
                         load_json, new_guid)

CANVAS_W, CANVAS_H = 1080, 1920
IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
PHOTO_DURATION_US = 10_800_000_000  # padrao de material foto (≈3h); o corte vem do timerange

# categorias "inofensivas" por segmento que a gente clona do 0116 (shape correto da versao)
BENIGN = {
    "speeds": "speed",
    "canvases": "canvas",
    "sound_channel_mappings": "scm",
    "material_colors": "color",
    "vocal_separations": "vocal",
    "placeholder_infos": "ph",
}


def probe_image(ffprobe: str, path: str) -> tuple[int, int]:
    out = subprocess.check_output([
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_entries", "stream=width,height", path,
    ], text=True)
    for s in json.loads(out).get("streams", []):
        if s.get("width") and s.get("height"):
            return int(s["width"]), int(s["height"])
    sys.exit(f"Nao consegui ler dimensoes da imagem: {path}")


def cover_scale(iw: int, ih: int) -> float:
    """Multiplicador (sobre o 'fit' do CapCut) para a imagem COBRIR o frame 1080x1920."""
    sx, sy = CANVAS_W / iw, CANVAS_H / ih
    return max(sx, sy) / min(sx, sy)


def kf_point(t_us: int, value: float) -> dict:
    return {
        "curveType": "Line", "graphID": "",
        "left_control": {"x": 0.0, "y": 0.0}, "right_control": {"x": 0.0, "y": 0.0},
        "id": new_guid(), "time_offset": int(t_us), "values": [round(value, 6)],
    }


def first_video_track(content: dict) -> dict:
    for tr in content.get("tracks", []):
        if tr.get("type") == "video" and tr.get("segments"):
            return tr
    sys.exit("Scaffold sem trilha de video.")


def build(images: list[str], src_dir: str, name: str, per_us: int, zoom: float,
          ffprobe: str) -> tuple[dict, dict, list[dict]]:
    """Monta (draft_content, lista_materiais_meta) a partir do scaffold em src_dir."""
    src = load_json(os.path.join(src_dir, "draft_content.json"))
    base_track = first_video_track(src)
    base_seg = copy.deepcopy(base_track["segments"][0])
    base_video_mat = next(v for v in src["materials"]["videos"]
                          if v["id"] == base_seg["material_id"])

    # templates das categorias inofensivas (shape desta versao do CapCut)
    tmpl = {}
    for cat in BENIGN:
        arr = src["materials"].get(cat) or []
        tmpl[cat] = copy.deepcopy(arr[0]) if arr else None

    out_mat: dict = {k: [] for k in src["materials"]}  # mesmas chaves, listas vazias
    segments = []
    meta_items = []
    now_s = int(time.time())
    offset = 0

    for i, img in enumerate(images):
        iw, ih = probe_image(ffprobe, img)
        img_fwd = img.replace("\\", "/")
        base = os.path.basename(img)
        cov = cover_scale(iw, ih)
        local_id = new_guid()

        # ----- material foto (deriva do material de video real -> campos completos) -----
        photo = copy.deepcopy(base_video_mat)
        photo["id"] = new_guid()
        photo["type"] = "photo"
        photo["path"] = img_fwd
        photo["material_name"] = base
        photo["width"], photo["height"] = iw, ih
        photo["duration"] = PHOTO_DURATION_US
        photo["has_audio"] = False
        photo["local_material_id"] = local_id
        photo["crop"] = {"upper_left_x": 0.0, "upper_left_y": 0.0, "upper_right_x": 1.0,
                         "upper_right_y": 0.0, "lower_left_x": 0.0, "lower_left_y": 1.0,
                         "lower_right_x": 1.0, "lower_right_y": 1.0}
        photo["crop_ratio"] = "free"
        photo["crop_scale"] = 1.0
        out_mat["videos"].append(photo)

        # ----- materiais inofensivos proprios do segmento -----
        refs = []
        for cat in BENIGN:
            if not tmpl[cat]:
                continue
            obj = copy.deepcopy(tmpl[cat])
            obj["id"] = new_guid()
            out_mat[cat].append(obj)
            refs.append(obj["id"])

        # ----- segmento (reusa o shape do 0116) -----
        seg = copy.deepcopy(base_seg)
        seg["id"] = new_guid()
        seg["material_id"] = photo["id"]
        seg["extra_material_refs"] = refs
        seg["source_timerange"] = {"start": 0, "duration": per_us}
        seg["target_timerange"] = {"start": offset, "duration": per_us}
        seg["render_timerange"] = {"start": 0, "duration": 0}
        seg["speed"] = 1.0
        seg["volume"] = 1.0
        seg["last_nonzero_volume"] = 1.0
        seg["render_index"] = i
        seg["track_render_index"] = 0
        seg["keyframe_refs"] = []

        # zoom: alterna entrar/sair pra dar ritmo
        s0, s1 = (cov, cov * (1 + zoom)) if i % 2 == 0 else (cov * (1 + zoom), cov)
        seg["clip"] = {"scale": {"x": s0, "y": s0}, "rotation": 0.0,
                       "transform": {"x": 0.0, "y": 0.0},
                       "flip": {"vertical": False, "horizontal": False}, "alpha": 1.0}
        seg["uniform_scale"] = {"on": True, "value": s0}
        seg["common_keyframes"] = [{
            "id": new_guid(), "material_id": "", "property_type": "UNIFORM_SCALE",
            "keyframe_list": [kf_point(0, s0), kf_point(per_us, s1)],
        }]
        segments.append(seg)

        meta_items.append({
            "ai_group_type": "", "create_time": now_s, "duration": per_us, "extra_info": base,
            "file_Path": img_fwd, "height": ih, "id": local_id, "import_time": now_s,
            "import_time_ms": now_s * 1_000_000, "item_source": 1, "md5": "",
            "metetype": "photo", "roughcut_time_range": {"start": 0, "duration": per_us},
            "sub_time_range": {"start": -1, "duration": -1}, "type": 0, "width": iw,
        })
        offset += per_us

    total = offset
    content = copy.deepcopy(src)
    content["id"] = new_guid()
    content["duration"] = total
    content["name"] = ""
    content["canvas_config"] = {"ratio": "original", "width": CANVAS_W, "height": CANVAS_H,
                                "background": None}
    content["materials"] = out_mat
    track = copy.deepcopy(base_track)
    track["id"] = new_guid()
    track["segments"] = segments
    content["tracks"] = [track]
    content["keyframes"] = {k: [] for k in content.get("keyframes", {})} or {
        "videos": [], "audios": [], "texts": [], "stickers": [], "filters": [],
        "adjusts": [], "handwrites": [], "effects": []}
    return content, {"items": meta_items, "total": total}, segments


def write_draft(user_data: str, src_id: str, content: dict, metapack: dict,
                segments: list[dict], name: str) -> str:
    draft_root = os.path.join(user_data, "Projects", "com.lveditor.draft")
    src_dir = os.path.join(draft_root, src_id)
    if not os.path.isdir(src_dir):
        sys.exit(f"Scaffold nao existe: {src_dir}")

    now_us = int(time.time() * 1_000_000)
    dst_name = f"edit_{int(time.time())}"
    dst_dir = os.path.join(draft_root, dst_name)
    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    dst_fwd = dst_dir.replace("\\", "/")
    new_draft_id = new_guid()

    # draft_content.json (+ .bak) e remove .tmp obsoletos
    cp = os.path.join(dst_dir, "draft_content.json")
    dump_json(cp, content)
    if os.path.exists(cp + ".bak"):
        dump_json(cp + ".bak", content)
    for tmp in ("template.tmp", "template-2.tmp"):
        p = os.path.join(dst_dir, tmp)
        if os.path.exists(p):
            os.remove(p)

    # draft_meta_info.json
    mp = os.path.join(dst_dir, "draft_meta_info.json")
    meta = load_json(mp)
    meta["draft_fold_path"] = dst_fwd
    meta["draft_id"] = new_draft_id
    meta["draft_name"] = name
    meta["tm_duration"] = metapack["total"]
    meta["tm_draft_create"] = now_us
    meta["tm_draft_modified"] = now_us
    meta["draft_materials"] = [{"type": 0, "value": metapack["items"]},
                               {"type": 1, "value": []}, {"type": 2, "value": []},
                               {"type": 3, "value": []}, {"type": 6, "value": []},
                               {"type": 7, "value": []}, {"type": 8, "value": []}]
    meta["draft_segment_extra_info"] = [
        {"extra_mask_aspect_ratio_locked": False, "extra_segmend_id": s["id"]} for s in segments]
    dump_json(mp, meta)

    # auxiliares: corrige caminho antigo
    src_fwd = src_dir.replace("\\", "/")
    for aux in ("draft.extra", "draft_virtual_store.json", "key_value.json",
                "attachment_editing.json"):
        p = os.path.join(dst_dir, aux)
        if not os.path.isfile(p):
            continue
        try:
            txt = open(p, "r", encoding="utf-8").read()
        except Exception:
            continue
        nt = txt.replace(src_fwd, dst_fwd).replace(src_dir, dst_dir).replace(src_id, dst_name)
        if nt != txt:
            open(p, "w", encoding="utf-8").write(nt)

    # registro (opcional; o CapCut re-escaneia). Backup sempre.
    root_meta = os.path.join(draft_root, "root_meta_info.json")
    if os.path.isfile(root_meta):
        shutil.copy2(root_meta, root_meta + f".poc_bak_{int(time.time())}")
        root = load_json(root_meta)
        entry = json.loads(json.dumps((root.get("all_draft_store") or [{}])[0]))
        entry.update({
            "draft_cover": dst_fwd + "\\draft_cover.jpg", "draft_fold_path": dst_fwd,
            "draft_id": new_draft_id, "draft_json_file": dst_fwd + "\\draft_content.json",
            "draft_name": name, "draft_root_path": draft_root, "tm_draft_create": now_us,
            "tm_draft_modified": now_us, "tm_duration": metapack["total"], "tm_draft_removed": 0,
        })
        root.setdefault("all_draft_store", []).append(entry)
        root["draft_ids"] = root.get("draft_ids", 0) + 1
        dump_json(root_meta, root)

    return dst_dir


def validate(content: dict) -> list[str]:
    """Checagem leve: todas as refs de material resolvem?"""
    ids = set()
    for arr in content["materials"].values():
        for it in arr:
            if isinstance(it, dict) and it.get("id"):
                ids.add(it["id"])
    problems = []
    for tr in content["tracks"]:
        for s in tr["segments"]:
            if s["material_id"] not in ids:
                problems.append(f"material_id solto: {s['material_id']}")
            for r in s.get("extra_material_refs", []):
                if r not in ids:
                    problems.append(f"ref solta: {r}")
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Gera slideshow de fotos no CapCut.")
    ap.add_argument("--images-dir", required=True, help="pasta com as fotos (ordem alfabetica)")
    ap.add_argument("--src-id", default="0116", help="rascunho usado de scaffold")
    ap.add_argument("--name", default="Edit de fotos", help="nome do projeto (o CapCut mostra o nome da pasta)")
    ap.add_argument("--per-sec", type=float, default=2.5, help="segundos por foto")
    ap.add_argument("--zoom", type=float, default=0.12, help="intensidade do zoom (0.12 = 12%)")
    ap.add_argument("--user-data", default=DEFAULT_USER_DATA)
    args = ap.parse_args(argv)

    images = sorted(p for p in glob.glob(os.path.join(args.images_dir, "*"))
                    if p.lower().endswith(IMG_EXTS))
    if not images:
        sys.exit(f"Nenhuma imagem em {args.images_dir}")

    ffprobe = find_ffprobe()
    per_us = int(round(args.per_sec * 1_000_000))
    content, metapack, segments = build(images, os.path.join(
        args.user_data, "Projects", "com.lveditor.draft", args.src_id),
        args.name, per_us, args.zoom, ffprobe)

    probs = validate(content)
    if probs:
        sys.exit("JSON invalido:\n  " + "\n  ".join(probs))

    dst = write_draft(args.user_data, args.src_id, content, metapack, segments, args.name)
    print("OK! Projeto gerado (JSON validado).")
    print(f"  nome  : {args.name}  (exibicao = pasta: {os.path.basename(dst)})")
    print(f"  pasta : {dst}")
    print(f"  fotos : {len(images)} x {args.per_sec}s = {metapack['total']/1e6:.1f}s  (zoom {int(args.zoom*100)}%)")
    print("Abra o CapCut (feche e reabra se estiver aberto) e procure "
          f"'{os.path.basename(dst)}' na lista.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
