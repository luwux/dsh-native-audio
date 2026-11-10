#!/usr/bin/env python3
"""Verify subsystem pages and map repository paths to them.

Default mode checks structure only: every page is listed in the index, every
index row has a page, the folder is flat, each page declares a `Source:` line
(`Source: none` marks a cross-cutting page that owns no paths),
and each declared source path or glob matches something and has exactly one
owning page. It does not prove that a page describes the code correctly.

`--owner PATH...` prints the page that owns each path. A file path beats a glob,
a glob beats a directory, and a longer directory beats a shorter one. `--changed [BASE]` lists pages whose owned paths differ from
BASE (default HEAD, including staged, unstaged, and untracked files) while the
page itself does not; it exits 0 because an unchanged page can still be
correct.

The root AGENTS.md carries a generated path-to-page table between the
`subsystem-map` markers. The default check fails when that table is stale;
`--map` rewrites it; the check compares cells, so a formatter may realign the
table. `--pointers` lists pages that no owned non-Markdown file names; it exits
0 because some owned files cannot hold comments.
"""

from __future__ import annotations

import argparse
import functools
import os
from pathlib import Path
import re
import subprocess
import sys


REPOSITORY = Path(__file__).resolve().parent.parent
# A repository that keeps subsystem pages in another flat directory sets it here
# instead of renaming the directory.
PAGES = REPOSITORY / "docs" / "specs"
INDEX = PAGES / "README.md"
# Files in PAGES that are not subsystem pages; the index is always exempt.
NON_SUBSYSTEM_PAGES: set[str] = set()
IGNORED_ENTRY_NAMES = {".DS_Store"}
AGENTS_FILE = REPOSITORY / "AGENTS.md"
MAP_START = "<!-- subsystem-map:start"
MAP_END = "<!-- subsystem-map:end -->"
POINTER_SIZE_LIMIT = 1_000_000
PROOF_LIMIT = (
    "verify_subsystem_pages proves index, layout, and Source-path consistency "
    "only; it does not prove that page content matches the code."
)

INDEX_ROW = re.compile(r"^\|\s*\[[^\]]+\]\((?P<target>[^)#\s]+)\)\s*\|")
H1 = re.compile(r"^# \S")
SOURCE_LINE = re.compile(r"^Source: (?:(?P<none>none)|(?P<paths>`[^`]+`(?:, `[^`]+`)*))$")
SOURCE_PATH = re.compile(r"`([^`]+)`")
GLOB_CHARACTERS = set("*?[")


def display(path: Path) -> str:
    return path.relative_to(REPOSITORY).as_posix()


def index_targets(errors: list[str]) -> list[str]:
    """Return page filenames linked from index table rows, in order."""

    if INDEX.is_symlink() or not INDEX.is_file():
        errors.append(f"structure: {display(INDEX)} — required regular file is missing")
        return []
    targets: list[str] = []
    for number, line in enumerate(INDEX.read_text(encoding="utf-8").splitlines(), 1):
        match = INDEX_ROW.match(line)
        if not match:
            continue
        target = match.group("target")
        if target.startswith("./"):
            target = target[2:]
        if "/" in target or not target.endswith(".md") or target == INDEX.name:
            errors.append(
                f"index: {display(INDEX)}:{number} — row must link a sibling page, got {target}"
            )
            continue
        if target in targets:
            errors.append(f"index: {display(INDEX)}:{number} — {target} is listed twice")
            continue
        targets.append(target)
    return targets


def page_files(errors: list[str]) -> list[str]:
    """Return page filenames in the flat folder and report other entries."""

    pages: list[str] = []
    for entry in sorted(PAGES.iterdir()):
        if entry.name in IGNORED_ENTRY_NAMES or entry == INDEX or entry.name in NON_SUBSYSTEM_PAGES:
            continue
        if entry.is_symlink() or not entry.is_file():
            errors.append(
                f"structure: {display(entry)} — keep {display(PAGES)}/ flat; "
                "only regular Markdown pages are allowed"
            )
        elif entry.suffix != ".md":
            errors.append(f"structure: {display(entry)} — only Markdown pages are allowed")
        else:
            pages.append(entry.name)
    return pages


def page_sources(page: str, errors: list[str]) -> list[str]:
    """Return the normalized source paths a page declares."""

    path = PAGES / page
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or not H1.match(lines[0]):
        errors.append(f"page: {display(path)}:1 — first line must be a `# ` title")
        return []
    following = [(number, line) for number, line in enumerate(lines[1:], 2) if line.strip()]
    if not following:
        errors.append(f"page: {display(path)} — missing `Source:` line after the title")
        return []
    number, line = following[0]
    match = SOURCE_LINE.match(line)
    if not match:
        errors.append(
            f"page: {display(path)}:{number} — first line after the title must be "
            "`Source: `path/`, `file`` or `Source: none`"
        )
        return []
    if match.group("none"):
        return []

    sources: list[str] = []
    for raw in SOURCE_PATH.findall(match.group("paths")):
        if raw.startswith("/") or ".." in Path(raw).parts or raw in {".", "./"}:
            errors.append(f"page: {display(path)}:{number} — {raw} must be repository-relative")
            continue
        if is_glob(raw):
            if raw.endswith("/"):
                errors.append(f"page: {display(path)}:{number} — glob {raw} must match files")
            elif not any(glob_pattern(raw).match(file) for file in repository_files()):
                errors.append(f"page: {display(path)}:{number} — glob {raw} matches no file")
            else:
                sources.append(raw)
            continue
        target = REPOSITORY / raw
        if not target.exists():
            errors.append(f"page: {display(path)}:{number} — {raw} does not exist")
            continue
        if target.is_dir() != raw.endswith("/"):
            errors.append(
                f"page: {display(path)}:{number} — {raw}: directories end with `/`, files do not"
            )
            continue
        sources.append(raw)
    return sources


def load(errors: list[str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Check the folder; return source path -> page and, in index order, page -> sources."""

    if PAGES.is_symlink() or not PAGES.is_dir():
        errors.append(f"structure: {display(PAGES)}/ — required regular directory is missing")
        return {}, {}
    targets = index_targets(errors)
    pages = page_files(errors)
    for page in pages:
        if page not in targets:
            errors.append(f"index: {display(PAGES / page)} — page is missing from {INDEX.name}")
    for target in targets:
        if target not in pages:
            errors.append(f"index: {display(INDEX)} links {target}, which does not exist")

    owners: dict[str, str] = {}
    declared: dict[str, list[str]] = {}
    for page in pages:
        for source in page_sources(page, errors):
            previous = owners.get(source)
            if previous is not None and previous != page:
                errors.append(
                    f"ownership: {source} is declared by both {previous} and {page}"
                )
                continue
            owners[source] = page
            declared.setdefault(page, []).append(source)
    ordered = [target for target in targets if target in declared]
    ordered += sorted(page for page in declared if page not in ordered)
    return owners, {page: declared[page] for page in ordered}


def map_lines(sources_by_page: dict[str, list[str]]) -> list[str]:
    """Return the generated path-to-page table for the root AGENTS.md."""

    lines = ["| Paths | Page |", "|---|---|"]
    for page, sources in sources_by_page.items():
        paths = ", ".join(f"`{source}`" for source in sources)
        lines.append(f"| {paths} | [{Path(page).stem}]({display(PAGES / page)}) |")
    return lines


def table_cells(lines: list[str]) -> list[list[str]]:
    """Return table rows as stripped cells, so formatter alignment and separator width do not matter."""

    rows: list[list[str]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if all(re.fullmatch(r":?-+:?", cell) for cell in cells):
            cells = ["---"] * len(cells)
        rows.append(cells)
    return rows


def map_block(lines: list[str]) -> tuple[int, int] | None:
    """Return the line indexes of the map markers, or None when AGENTS.md has none."""

    starts = [number for number, line in enumerate(lines) if line.startswith(MAP_START)]
    ends = [number for number, line in enumerate(lines) if line.strip() == MAP_END]
    if not starts and not ends:
        return None
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        raise ValueError(f"{display(AGENTS_FILE)} must hold one `{MAP_START}` line followed by one `{MAP_END}` line")
    return starts[0], ends[0]


def check_map(sources_by_page: dict[str, list[str]], errors: list[str]) -> None:
    if not AGENTS_FILE.is_file():
        return
    lines = AGENTS_FILE.read_text(encoding="utf-8").splitlines()
    try:
        block = map_block(lines)
    except ValueError as error:
        errors.append(f"map: {error}")
        return
    if block is not None and table_cells(lines[block[0] + 1 : block[1]]) != table_cells(
        map_lines(sources_by_page)
    ):
        errors.append(
            f"map: {display(AGENTS_FILE)} subsystem table is stale; "
            f"run `python3 {display(Path(__file__).resolve())} --map`"
        )


def write_map(sources_by_page: dict[str, list[str]]) -> int:
    lines = AGENTS_FILE.read_text(encoding="utf-8").splitlines() if AGENTS_FILE.is_file() else []
    try:
        block = map_block(lines)
    except ValueError as error:
        print(f"verify_subsystem_pages: {error}", file=sys.stderr)
        return 1
    if block is None:
        print(
            f"verify_subsystem_pages: {display(AGENTS_FILE)} has no `{MAP_START}` / `{MAP_END}` markers",
            file=sys.stderr,
        )
        return 1
    generated = map_lines(sources_by_page)
    if table_cells(lines[block[0] + 1 : block[1]]) == table_cells(generated):
        print(f"verify_subsystem_pages: {display(AGENTS_FILE)} subsystem table is current.")
        return 0
    lines[block[0] + 1 : block[1]] = generated
    AGENTS_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"verify_subsystem_pages: updated the subsystem table in {display(AGENTS_FILE)}.")
    return 0


def pages_without_pointer(owners: dict[str, str], sources_by_page: dict[str, list[str]]) -> list[str]:
    """Return pages whose filename appears in none of the non-Markdown files they own.

    Markdown files do not count: an agent that starts from code opens source files, not READMEs.
    """

    pointed: set[str] = set()
    for file in repository_files():
        page = owner_of(file, owners)
        if page is None or page in pointed or file.endswith((".md", ".mdx")):
            continue
        path = REPOSITORY / file
        try:
            if path.stat().st_size > POINTER_SIZE_LIMIT:
                continue
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if page in text:
            pointed.add(page)
    return [page for page in sources_by_page if page not in pointed]


@functools.lru_cache(maxsize=None)
def is_glob(source: str) -> bool:
    """Treat a source as a glob only when it has glob characters and is not an existing path.

    Literal directory names such as Next.js `[slug]/` or `[...key]/` stay literal paths.
    """

    if not GLOB_CHARACTERS & set(source):
        return False
    return not (REPOSITORY / source).exists()


@functools.lru_cache(maxsize=None)
def glob_pattern(source: str) -> re.Pattern[str]:
    """Translate a Source glob: `*` and `?` stay within one path segment, `**` crosses segments."""

    pattern = ""
    index = 0
    while index < len(source):
        if source.startswith("**/", index):
            pattern += "(?:.*/)?"
            index += 3
        elif source.startswith("**", index):
            pattern += ".*"
            index += 2
        elif source[index] == "*":
            pattern += "[^/]*"
            index += 1
        elif source[index] == "?":
            pattern += "[^/]"
            index += 1
        elif source[index] == "[":
            end = source.find("]", index + 1)
            if end == -1:
                pattern += re.escape("[")
                index += 1
            else:
                pattern += "[" + source[index + 1 : end].replace("\\", "\\\\") + "]"
                index = end + 1
        else:
            pattern += re.escape(source[index])
            index += 1
    return re.compile(pattern + r"\Z")


_repository_files: list[str] | None = None


def repository_files() -> list[str]:
    """Return tracked and untracked non-ignored files, or a filesystem walk outside Git."""

    global _repository_files
    if _repository_files is None:
        try:
            _repository_files = git_lines(
                "ls-files", "--cached", "--others", "--exclude-standard"
            )
        except (OSError, RuntimeError):
            _repository_files = [
                file.relative_to(REPOSITORY).as_posix()
                for file in REPOSITORY.rglob("*")
                if file.is_file() and ".git" not in file.relative_to(REPOSITORY).parts
            ]
    return _repository_files


def specificity(source: str, path: str) -> tuple[int, int] | None:
    """Rank how specifically source covers path, or return None when it does not."""

    if is_glob(source):
        return (1, len(source)) if glob_pattern(source).match(path) else None
    if source.endswith("/"):
        if path.startswith(source) or path == source.rstrip("/"):
            return (0, len(source))
        return None
    return (2, len(source)) if path == source else None


def owner_of(path: str, owners: dict[str, str]) -> str | None:
    """Return the page whose declared source most specifically covers path."""

    best: tuple[tuple[int, int], str] | None = None
    for source, page in owners.items():
        rank = specificity(source, path)
        if rank is not None and (best is None or rank > best[0]):
            best = (rank, page)
    return None if best is None else best[1]


def repository_relative(raw: str) -> str:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    for resolved in (Path(os.path.normpath(candidate)), candidate.resolve()):
        try:
            return resolved.relative_to(REPOSITORY).as_posix()
        except ValueError:
            continue
    return raw


def git_lines(*args: str) -> list[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=REPOSITORY,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return [line for line in result.stdout.splitlines() if line]


def changed_paths(base: str) -> set[str]:
    return {
        *git_lines("diff", "--name-only", "--relative", base, "--"),
        *git_lines("ls-files", "--others", "--exclude-standard"),
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = result.add_mutually_exclusive_group()
    mode.add_argument("--owner", nargs="+", metavar="PATH", help="print the page owning each path")
    mode.add_argument(
        "--map", action="store_true", help="rewrite the subsystem table in the root AGENTS.md"
    )
    mode.add_argument(
        "--pointers", action="store_true", help="list pages that no owned file names in a comment"
    )
    mode.add_argument(
        "--changed",
        nargs="?",
        const="HEAD",
        metavar="BASE",
        help="list pages whose owned paths changed against BASE (default HEAD)",
    )
    return result


def main() -> int:
    args = parser().parse_args()
    errors: list[str] = []
    owners, sources_by_page = load(errors)
    if not errors and not args.map:
        check_map(sources_by_page, errors)
    if errors:
        print("verify_subsystem_pages: violations found:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        print(PROOF_LIMIT, file=sys.stderr)
        return 1

    if args.map:
        return write_map(sources_by_page)

    if args.pointers:
        missing = pages_without_pointer(owners, sources_by_page)
        if not missing:
            print("verify_subsystem_pages: every owning page is named by at least one file it owns.")
            return 0
        print("verify_subsystem_pages: add a comment naming the page to one entry file each of:")
        for page in missing:
            print(f"  {display(PAGES / page)}")
        return 0

    if args.owner:
        for raw in args.owner:
            path = repository_relative(raw)
            page = owner_of(path, owners)
            print(f"{path} -> " + (display(PAGES / page) if page else "(no subsystem page)"))
        return 0

    if args.changed:
        try:
            changed = changed_paths(args.changed)
        except RuntimeError as error:
            print(f"verify_subsystem_pages: {error}", file=sys.stderr)
            return 2
        stale: dict[str, list[str]] = {}
        for path in sorted(changed):
            page = owner_of(path, owners)
            if page is not None and display(PAGES / page) not in changed:
                stale.setdefault(page, []).append(path)
        if not stale:
            print(f"verify_subsystem_pages: no owned paths changed without their page against {args.changed}.")
            return 0
        print(f"verify_subsystem_pages: review these pages; their owned paths changed against {args.changed}:")
        for page, paths in sorted(stale.items()):
            print(f"  {display(PAGES / page)}: {', '.join(paths)}")
        print("Update each page whose documented facts changed; an unchanged page can still be correct.")
        return 0

    print(
        f"verify_subsystem_pages: {len(set(owners.values()))} owning page(s) with "
        f"{len(owners)} source path(s) checked in {display(PAGES)}/; "
        "index, layout, and Source paths conform."
    )
    print(PROOF_LIMIT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
