from pathlib import Path


LEGACY_SCRIPT = Path(".github/scripts/apply_sticky_css_export.py")
RELEASES_FILE = Path("worker/releases.ts")


def prepare_release_source() -> None:
    source = RELEASES_FILE.read_text(encoding="utf-8")
    comment = "<!-- ads.min.js injects sticky base styles. sticky.css is an optional handoff and override artifact. -->"
    if comment in source:
        return

    stylesheet_line = (
        '<link rel="stylesheet" href="${origin}/cdn/${snapshot.site.id}/current/min-height.css">\n'
    )
    if stylesheet_line not in source:
        raise SystemExit(
            "The min-height stylesheet line was not found in implementationHtml()."
        )

    source = source.replace(
        stylesheet_line,
        f"{stylesheet_line}{comment}\n",
        1,
    )
    RELEASES_FILE.write_text(source, encoding="utf-8")


def execute_idempotent_legacy_patch() -> None:
    script = LEGACY_SCRIPT.read_text(encoding="utf-8")
    original_helper = '''def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} anchor was not found.")
    return source.replace(old, new, 1)
'''
    idempotent_helper = '''def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    if old not in source:
        raise SystemExit(f"{label} anchor was not found.")
    return source.replace(old, new, 1)
'''

    if original_helper in script:
        script = script.replace(original_helper, idempotent_helper, 1)
    elif idempotent_helper not in script:
        raise SystemExit("The sticky CSS patch helper could not be upgraded safely.")

    namespace = {
        "__name__": "__main__",
        "__file__": str(LEGACY_SCRIPT),
    }
    exec(compile(script, str(LEGACY_SCRIPT), "exec"), namespace)


prepare_release_source()
execute_idempotent_legacy_patch()
