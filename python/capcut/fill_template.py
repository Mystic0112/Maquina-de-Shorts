"""Cria um projeto do CapCut a partir de um projeto-mestre, trocando as fotos/videos dos espacos pelos seus.

    python python/capcut/fill_template.py --src-id MESTRE --media-dir "C:/fotos/carro" --name "Edit carro 1"
    python python/capcut/fill_template.py --src-id MESTRE --media a.jpg b.jpg c.jpg --name "Edit 2" --cycle
    python python/capcut/fill_template.py --src-id MESTRE --inspect       # mostra os espacos do mestre

As midias entram na ordem dos nomes dos arquivos (ou na ordem de --media), uma por espaco da timeline. Rode com o
CapCut FECHADO; ele re-escaneia a pasta sozinho e mostra o NOME DA PASTA como nome do projeto. Nada e publicado.
Contexto e limites: planejamento/capcut-templates-automacao.md e slots.py.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # works with `python -I` too

import clone_draft as cd  # noqa: E402
import slots  # noqa: E402

MEDIA_EXT = slots.IMAGE_EXT | {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


def list_media(folder: str) -> list[str]:
    files = [p for p in glob.glob(os.path.join(folder, "*")) if os.path.splitext(p)[1].lower() in MEDIA_EXT]
    return sorted(files, key=lambda p: os.path.basename(p).lower())


def inspect(draft_root: str, src_id: str, track_index: int) -> int:
    content = cd.load_json(os.path.join(draft_root, src_id, "draft_content.json"))
    tracks = [t for t in content.get("tracks", []) if t.get("type") == "video"]
    print(f"{src_id}: {len(tracks)} trilha(s) de video, duracao {content.get('duration', 0) / 1e6:.1f}s")
    by_id = {v["id"]: v for v in content["materials"].get("videos", [])}
    for i, seg in enumerate(slots.video_track_slots(content, track_index)):
        mat = by_id.get(seg["material_id"], {})
        t = seg["target_timerange"]
        print(f"  espaco {i:2d}: {t['start'] / 1e6:6.2f}s +{t['duration'] / 1e6:5.2f}s  "
              f"{mat.get('type', '?'):5} {mat.get('width')}x{mat.get('height')}  {mat.get('material_name')}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Preenche um projeto-mestre do CapCut com suas fotos/videos.")
    ap.add_argument("--src-id", required=True, help="pasta do projeto-mestre")
    ap.add_argument("--media-dir", help="pasta com as fotos/videos (ordem alfabetica)")
    ap.add_argument("--media", nargs="+", help="lista de arquivos, na ordem dos espacos")
    ap.add_argument("--name", help="nome do novo projeto (vira o nome da pasta)")
    ap.add_argument("--track", type=int, default=0, help="qual trilha de video preencher (0 = a primeira)")
    ap.add_argument("--cycle", action="store_true", help="repete as midias se faltarem para os espacos")
    ap.add_argument("--inspect", action="store_true", help="so mostra os espacos do mestre e sai")
    ap.add_argument("--user-data", default=cd.DEFAULT_USER_DATA, help="pasta 'User Data' do CapCut (ou env CAPCUT_USER_DATA)")
    args = ap.parse_args(argv)

    draft_root = os.path.join(args.user_data, "Projects", "com.lveditor.draft")
    if args.inspect:
        return inspect(draft_root, args.src_id, args.track)

    paths = args.media or (list_media(args.media_dir) if args.media_dir else [])
    if not paths or not args.name:
        sys.exit("informe --name e as midias (--media-dir ou --media)")
    try:
        dst, report = slots.build_project(draft_root, args.src_id, paths, args.name, track_index=args.track, cycle=args.cycle)
    except (ValueError, FileNotFoundError, FileExistsError) as error:
        sys.exit(str(error))
    print(f"OK! {len(report.swapped)} espaco(s) preenchidos em: {dst}")
    for i, name in report.swapped:
        print(f"  espaco {i:2d} <- {name}")
    for w in report.warnings:
        print(f"  AVISO: {w}")
    print("Abra o CapCut (feche e reabra se ja estiver aberto) e procure o projeto pelo nome.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
