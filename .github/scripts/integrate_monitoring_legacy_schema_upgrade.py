from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if new in source:
        print(f'{label}: already applied')
        return
    if old not in source:
        raise SystemExit(f'{label} anchor was not found in {path}.')
    file_path.write_text(source.replace(old, new, 1), encoding='utf-8')
    print(f'{label}: applied')


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding='utf-8')
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f'Integration validation failed in {path}: {missing}')


replace_once(
    'worker/monitoring-notification-settings.ts',
    "import type { DatabaseEnv } from './publishers';\n",
    "import type { DatabaseEnv } from './publishers';\nimport { reconcileMonitoringNotificationSchema } from './monitoring-notification-schema';\n",
    'legacy schema reconciler import',
)
replace_once(
    'worker/monitoring-notification-settings.ts',
    "  ]);\n\n  // D1 prepares batch statements before execution. Create the index only after",
    "  ]);\n\n  // Older preview builds created monitoring_notification_log without the\n  // provider column. CREATE TABLE IF NOT EXISTS does not upgrade that table,\n  // so reconcile known legacy columns before any SELECT or INSERT uses them.\n  await reconcileMonitoringNotificationSchema(db);\n\n  // D1 prepares batch statements before execution. Create the index only after",
    'legacy schema reconciliation call',
)
replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-25-monitoring-notification-rules-v26';",
    "const RUNTIME_BUILD = '2026-07-26-monitoring-schema-upgrade-v27';",
    'monitoring schema upgrade marker',
)

require(
    'worker/monitoring-notification-settings.ts',
    "from './monitoring-notification-schema'",
    'await reconcileMonitoringNotificationSchema(db);',
)
require(
    'worker/app-deploy.ts',
    '2026-07-26-monitoring-schema-upgrade-v27',
)
print('Legacy monitoring notification schema upgrade integration passed.')
