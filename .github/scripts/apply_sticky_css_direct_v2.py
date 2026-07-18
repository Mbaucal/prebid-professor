from pathlib import Path


WORKER_FILE = Path("worker/releases.ts")
LEGACY_SCRIPT = Path(".github/scripts/apply_sticky_css_direct.py")
COMMENT = "<!-- ads.min.js injects sticky base styles. sticky.css is an optional handoff and override artifact. -->"


def patch_implementation_comment() -> None:
    source = WORKER_FILE.read_text(encoding="utf-8")
    old = (
        '<link rel="stylesheet" href="${origin}/cdn/${snapshot.site.id}/current/min-height.css">\\n'
        '<script src="${origin}/cdn/${snapshot.site.id}/current/prebid.js"></script>'
    )
    new = (
        '<link rel="stylesheet" href="${origin}/cdn/${snapshot.site.id}/current/min-height.css">\\n'
        f'{COMMENT}\\n'
        '<script src="${origin}/cdn/${snapshot.site.id}/current/prebid.js"></script>'
    )
    if new in source:
        return
    if old not in source:
        raise SystemExit("The implementationHtml stylesheet/script boundary was not found.")
    WORKER_FILE.write_text(source.replace(old, new, 1), encoding="utf-8")


def execute_remaining_patch() -> None:
    source = LEGACY_SCRIPT.read_text(encoding="utf-8")
    label_position = source.find('"implementation sticky note",')
    if label_position < 0:
        raise SystemExit("The implementation sticky-note patch block was not found.")

    block_start = source.rfind("\nreplace_once(", 0, label_position)
    block_end = source.find("\nreplace_once(", label_position)
    if block_start < 0 or block_end < 0:
        raise SystemExit("The implementation sticky-note patch block could not be isolated.")

    source = source[: block_start + 1] + source[block_end + 1 :]
    namespace = {
        "__name__": "__main__",
        "__file__": str(LEGACY_SCRIPT),
    }
    exec(compile(source, str(LEGACY_SCRIPT), "exec"), namespace)


patch_implementation_comment()
execute_remaining_patch()
