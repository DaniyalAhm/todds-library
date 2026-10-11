#!/usr/bin/env python3
from pathlib import Path
import argparse
import os


def is_hidden_relative(path: Path, root: Path) -> bool:
    return any(part.startswith(".") for part in path.relative_to(root).parts)


def planned_moves(root: Path, include_hidden: bool, flatten_subfolders: bool = False) -> list[tuple[Path, Path]]:
    moves = []
    for src in root.rglob("*"):
        if not src.is_file():
            continue
        if not include_hidden and is_hidden_relative(src, root):
            continue
        rel = src.relative_to(root).parts
        audio_indexes = [i for i, part in enumerate(rel[:-1]) if part.lower() == "audio"]
        if not audio_indexes:
            continue
        audio_index = audio_indexes[0]
        # Preserve companion subfolders such as subtitles; collapse nested Audio folders.
        remainder = [] if flatten_subfolders else [part for part in rel[audio_index:-1] if part.lower() != "audio"]
        dst = root.joinpath(*rel[:audio_index], *remainder, src.name)
        if src != dst:
            moves.append((src, dst))
    return moves


def remove_empty_audio_dirs(root: Path, include_hidden: bool) -> int:
    removed = 0
    directories = [p for p in root.rglob("*") if p.is_dir()
                   and any(part.lower() == "audio" for part in p.relative_to(root).parts)]
    for directory in sorted(directories, key=lambda p: len(p.parts), reverse=True):
        if not include_hidden and is_hidden_relative(directory, root):
            continue
        try:
            directory.rmdir()
            removed += 1
        except OSError:
            pass
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Move all files out of Audio folders into their parent book folder."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default="/mnt/2tb_jellyfin/Books",
        type=Path,
        help="Books library root.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually move files. Without this, only prints a dry run.",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Also process hidden folders such as .quarantine or .backups.",
    )
    parser.add_argument("--flatten-subfolders", action="store_true",
                        help="Move every file directly into the book directory, discarding subfolder structure.")
    args = parser.parse_args()

    root = args.root.resolve()
    moves = planned_moves(root, args.include_hidden, args.flatten_subfolders)
    destinations: set[Path] = set()
    collisions = []
    for src, dst in moves:
        if (dst.exists() and not src.samefile(dst)) or dst in destinations:
            collisions.append((src, dst))
        destinations.add(dst)

    print(f"Root: {root}")
    print(f"Files to move: {len(moves)}")
    print(f"Collisions: {len(collisions)}")

    if collisions:
        print("Refusing to continue because destination files already exist:")
        for src, dst in collisions:
            print(f"  {src} -> {dst}")
        return 2

    for src, dst in moves:
        print(f"{'MOVE' if args.apply else 'DRY '} {src} -> {dst}")

    if not args.apply:
        return 0

    for src, dst in sorted(moves, key=lambda pair: len(pair[0].parts), reverse=True):
        dst.parent.mkdir(parents=True, exist_ok=True)
        # A hard link refuses existing targets, including files created after preflight.
        if not dst.exists():
            os.link(src, dst)
        src.unlink()

    removed = remove_empty_audio_dirs(root, args.include_hidden)
    print(f"Moved {len(moves)} files.")
    print(f"Removed {removed} empty Audio directories.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
