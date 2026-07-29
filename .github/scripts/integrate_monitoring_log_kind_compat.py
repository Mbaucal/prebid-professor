from pathlib import Path


def replace_all(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    count = source.count(old)
    if count == 0:
        if new in source:
            print(f'{label}: already applied')
            return
        raise SystemExit(f'{label}: expected value was not found in {path}.')
    file_path.write_text(source.replace(old, new), encoding='utf-8')
    print(f'{label}: replaced {count} occurrence(s)')


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if new in source:
        print(f'{label}: already applied')
        return
    if old not in source:
        raise SystemExit(f'{label}: expected value was not found in {path}.')
    file_path.write_text(source.replace(old, new, 1), encoding='utf-8')
    print(f'{label}: applied')


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding='utf-8')
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f'Validation failed in {path}: {missing}')


# The shared D1 database contains a legacy CHECK constraint that permits
# `manual` but not the newer `check` log kind. Non-email evaluations are
# therefore stored as `manual`; the actor/details still distinguish manual,
# batch and Cloudflare Cron executions.
replace_all(
    'worker/monitoring-notification-run.ts',
    "kind: 'check',",
    "kind: 'manual',",
    'legacy monitoring log kind compatibility',
)

replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-29-monitoring-daily-cron-v29';",
    "const RUNTIME_BUILD = '2026-07-29-monitoring-log-compat-v30';",
    'runtime build marker',
)

require(
    'worker/monitoring-notification-run.ts',
    "kind: 'manual',",
)
require(
    'worker/app-deploy.ts',
    '2026-07-29-monitoring-log-compat-v30',
)

if "kind: 'check'," in Path('worker/monitoring-notification-run.ts').read_text(encoding='utf-8'):
    raise SystemExit('Validation failed: unsupported monitoring log kind remains.')

print('Monitoring log compatibility validation passed.')
