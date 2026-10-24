"""Clona um rascunho do CapCut e troca o video por outro (prova de conceito).

Base para automatizar o "template" do CapCut: pegar um projeto-mestre (com o estilo pronto)
e gerar um novo projeto com a midia trocada, que o CapCut abre pronto. Tudo e dado JSON em
`...\\CapCut\\User Data\\Projects\\com.lveditor.draft\\<pasta>\\`; o coracao e o
`draft_content.json` (tracks -> segments -> materials, tempo em MICROSSEGUNDOS). Ver
`planejamento/capcut-templates-automacao.md` para o contexto completo e as limitacoes.

Limitacoes (resolver ao virar modulo): troca so o 1o segmento de video; nao troca audio nem
legenda; estica o slot para a duracao do novo video. O CapCut re-escaneia a pasta sozinho e
usa o NOME DA PASTA como nome de exibicao; rode com o CapCut FECHADO para ele nao reescrever
o registro no meio.

Uso (Windows, Python 3.10+; ex.: .venv\\Scripts\\python.exe):
    python python/capcut/clone_draft.py                          # 0116 + Short mais recente
    python python/capcut/clone_draft.py --video "C:/x/meu.mp4" --name "Teste 1"
    python python/capcut/clone_draft.py --list                   # lista os rascunhos

Sonda o video com o ffprobe do Remotion (node_modules/@remotion/compositor-*/ffprobe.exe).
Nada e publicado nem enviado: tudo local.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

# raiz do repo = dois niveis acima de python/capcut/
PROJECT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# pasta "User Data" do CapCut; sobrescrevivel por env ou --user-data
DEFAULT_USER_DATA = os.environ.get(
    "CAPCUT_USER_DATA",
    os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local"),
                 "CapCut", "User Data"),
)


def find_ffprobe() -> str:
    hits = glob.glob(os.path.join(PROJECT_DIR, "node_modules", "@remotion",
                                  "compositor-*", "ffprobe.exe"))
    if hits:
        return hits[0]
    from shutil import which
    w = which("ffprobe")
    if w:
        return w
    sys.exit("ffprobe nao encontrado (nem no Remotion, nem no PATH).")


def probe_video(ffprobe: str, path: str) -> tuple[int, int, int]:
    """Retorna (width, height, duration_us) do primeiro stream de video."""
    out = subprocess.check_output([
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_entries", "stream=codec_type,width,height,duration:format=duration",
        path,
    ], text=True)
    info = json.loads(out)
    w = h = 0
    dur = None
    for s in info.get("streams", []):
        if s.get("codec_type") == "video":
            w = int(s.get("width") or 0)
            h = int(s.get("height") or 0)
            if s.get("duration"):
                dur = float(s["duration"])
            break
    if dur is None:
        dur = float(info.get("format", {}).get("duration") or 0)
    if not (w and h and dur):
        sys.exit(f"Nao consegui ler dimensoes/duracao de: {path}")
    return w, h, int(round(dur * 1_000_000))  # CapCut usa microssegundos


def new_guid() -> str:
    """GUID maiusculo, no formato que o CapCut usa."""
    return str(uuid.uuid4()).upper()


def load_json(p: str):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(p: str, data) -> None:
    # compacto e sem escapar nao-ascii, como o CapCut grava
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def clone_and_swap(draft_root: str, src_id: str, video: str,
                   name: str | None) -> str:
    """Clona o rascunho `src_id` trocando o 1o video por `video`. Retorna a pasta criada."""
    src_dir = os.path.join(draft_root, src_id)
    if not os.path.isdir(src_dir):
        sys.exit(f"Rascunho de origem nao existe: {src_dir}")

    video = os.path.abspath(video)
    if not os.path.isfile(video):
        sys.exit(f"Video nao existe: {video}")

    ffprobe = find_ffprobe()
    w, h, dur_us = probe_video(ffprobe, video)
    video_fwd = video.replace("\\", "/")      # CapCut usa barra normal nos paths
    basename = os.path.basename(video)
    now_us = int(time.time() * 1_000_000)

    dst_name = f"poc_{int(time.time())}"
    dst_dir = os.path.join(draft_root, dst_name)
    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    dst_fold_fwd = dst_dir.replace("\\", "/")

    draft_name = name or f"PoC {time.strftime('%H:%M:%S')}"
    new_draft_id = new_guid()
    new_content_id = new_guid()

    # ----- draft_content.json: trocar o material do 1o segmento de video -----
    content_path = os.path.join(dst_dir, "draft_content.json")
    content = load_json(content_path)
    content["id"] = new_content_id
    content["duration"] = dur_us

    target_seg = None
    for tr in content.get("tracks", []):
        if tr.get("type") == "video":
            for seg in tr.get("segments", []):
                target_seg = seg
                break
        if target_seg:
            break
    if not target_seg:
        sys.exit("Nao achei trilha/segmento de video no rascunho de origem.")

    mat_id = target_seg["material_id"]
    vid = next((v for v in content["materials"]["videos"] if v["id"] == mat_id), None)
    if vid is None:
        sys.exit(f"Material de video {mat_id} nao encontrado.")
    old_local_id = vid.get("local_material_id", "")
    old_path = vid.get("path", "")

    # mantem o `id` do material: preserva os efeitos que referenciam esse material
    vid["path"] = video_fwd
    vid["material_name"] = basename
    vid["width"] = w
    vid["height"] = h
    vid["duration"] = dur_us

    # encaixa no slot: usa a duracao do novo video (PoC). Num template de verdade,
    # avaliar manter a duracao do slot e cortar via source_timerange.
    for key in ("source_timerange", "target_timerange"):
        if isinstance(target_seg.get(key), dict):
            target_seg[key]["start"] = 0
            target_seg[key]["duration"] = dur_us

    dump_json(content_path, content)
    bak = content_path + ".bak"
    if os.path.exists(bak):
        dump_json(bak, content)
    for tmp in ("template.tmp", "template-2.tmp"):
        p = os.path.join(dst_dir, tmp)
        if os.path.exists(p):
            os.remove(p)

    # ----- draft_meta_info.json -----
    meta_path = os.path.join(dst_dir, "draft_meta_info.json")
    meta = load_json(meta_path)
    meta["draft_fold_path"] = dst_fold_fwd
    meta["draft_id"] = new_draft_id
    meta["draft_name"] = draft_name
    meta["tm_duration"] = dur_us
    meta["tm_draft_create"] = now_us
    meta["tm_draft_modified"] = now_us
    for group in meta.get("draft_materials", []):
        for item in group.get("value", []) or []:
            if (item.get("id") == old_local_id
                    or item.get("file_Path") == old_path
                    or item.get("extra_info") == os.path.basename(old_path)):
                item["file_Path"] = video_fwd
                item["extra_info"] = basename
                item["width"] = w
                item["height"] = h
                item["duration"] = dur_us
                item["roughcut_time_range"] = {"start": 0, "duration": dur_us}
    dump_json(meta_path, meta)

    # ----- auxiliares: corrige o caminho da pasta antiga -----
    src_fold_fwd = src_dir.replace("\\", "/")
    for aux in ("draft.extra", "draft_virtual_store.json", "key_value.json",
                "attachment_editing.json"):
        p = os.path.join(dst_dir, aux)
        if not os.path.isfile(p):
            continue
        try:
            txt = open(p, "r", encoding="utf-8").read()
        except Exception:
            continue
        new_txt = (txt.replace(src_fold_fwd, dst_fold_fwd)
                      .replace(src_dir, dst_dir)
                      .replace(src_id, dst_name))
        if new_txt != txt:
            open(p, "w", encoding="utf-8").write(new_txt)

    # ----- registra no root_meta_info.json (opcional; o CapCut re-escaneia). Backup sempre. -----
    root_meta = os.path.join(draft_root, "root_meta_info.json")
    if os.path.isfile(root_meta):
        shutil.copy2(root_meta, root_meta + f".poc_bak_{int(time.time())}")
        root = load_json(root_meta)
        template_entry = (root.get("all_draft_store") or [{}])[0]
        entry = json.loads(json.dumps(template_entry))  # copia profunda
        entry.update({
            "draft_cover": dst_fold_fwd + "\\draft_cover.jpg",
            "draft_fold_path": dst_fold_fwd,
            "draft_id": new_draft_id,
            "draft_json_file": dst_fold_fwd + "\\draft_content.json",
            "draft_name": draft_name,
            "draft_root_path": draft_root,
            "tm_draft_create": now_us,
            "tm_draft_modified": now_us,
            "tm_duration": dur_us,
            "tm_draft_removed": 0,
        })
        root.setdefault("all_draft_store", []).append(entry)
        root["draft_ids"] = root.get("draft_ids", 0) + 1
        dump_json(root_meta, root)

    print("OK! Novo rascunho criado.")
    print(f"  nome  : {draft_name}  (exibicao = nome da pasta: {dst_name})")
    print(f"  pasta : {dst_dir}")
    print(f"  video : {basename}  ({w}x{h}, {dur_us / 1_000_000:.1f}s)")
    print(f"  origem: {src_id} (intacto)")
    return dst_dir


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Clona rascunho do CapCut e troca o video.")
    ap.add_argument("--src-id", default="0116", help="pasta do rascunho de origem (default: 0116)")
    ap.add_argument("--video", default=None, help="novo video (default: render_output mais recente)")
    ap.add_argument("--name", default=None, help="nome do novo rascunho")
    ap.add_argument("--user-data", default=DEFAULT_USER_DATA,
                    help="pasta 'User Data' do CapCut (ou env CAPCUT_USER_DATA)")
    ap.add_argument("--list", action="store_true", help="so lista os rascunhos e sai")
    args = ap.parse_args(argv)

    draft_root = os.path.join(args.user_data, "Projects", "com.lveditor.draft")
    root_meta = os.path.join(draft_root, "root_meta_info.json")

    if args.list:
        if not os.path.isfile(root_meta):
            sys.exit(f"root_meta_info.json nao encontrado em {draft_root}")
        for e in load_json(root_meta).get("all_draft_store", []):
            print(f"  - {e.get('draft_name'):20} id={e.get('draft_id')}  "
                  f"dur={e.get('tm_duration', 0) / 1_000_000:.1f}s  "
                  f"pasta={os.path.basename(e.get('draft_fold_path', ''))}")
        return 0

    video = args.video
    if not video:
        cands = sorted(glob.glob(os.path.join(PROJECT_DIR, "render_output", "*", "final.mp4")),
                       key=os.path.getmtime, reverse=True)
        if not cands:
            sys.exit("Nenhum render_output/*/final.mp4 encontrado; passe --video.")
        video = cands[0]

    dst = clone_and_swap(draft_root, args.src_id, video, args.name)
    print("Abra o CapCut (feche e reabra se ja estiver aberto) e procure o projeto "
          f"'{os.path.basename(dst)}' na lista.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
