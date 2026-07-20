from pathlib import Path

path = Path('worker/monitoring.ts')
source = path.read_text(encoding='utf-8')
old = '''function severityFor(status: Omit<MonitoringStatus, 'severity'>): MonitorSeverity {
  if (!status.currentReleaseId || !status.expectedVersion) return 'not-configured';
  const requiredMissing = status.artifacts.some((artifact) => artifact.required && !artifact.found);
  if (!status.manifestFound || status.versionMatches === false || requiredMissing) return 'error';
  if (status.adsTxt?.status === 'missing' || status.adsTxt?.status === 'fetch-error') return 'error';
  if (status.adsTxt?.status === 'empty' || (status.adsTxt?.optionalMissingCount ?? 0) > 0) return 'warning';
  return 'ok';
}
'''
new = '''function severityFor(
  status: Omit<MonitoringStatus, 'severity'>,
  settings: MonitoringSettings,
): MonitorSeverity {
  if (settings.runtimeChecks && (!status.currentReleaseId || !status.expectedVersion)) return 'not-configured';
  if (settings.runtimeChecks) {
    const requiredMissing = status.artifacts.some((artifact) => artifact.required && !artifact.found);
    if (!status.manifestFound || status.versionMatches === false || requiredMissing) return 'error';
  }
  if (settings.adsTxtChecks) {
    if (status.adsTxt?.status === 'missing' || status.adsTxt?.status === 'fetch-error') return 'error';
    if (status.adsTxt?.status === 'empty' || (status.adsTxt?.optionalMissingCount ?? 0) > 0) return 'warning';
  }
  return 'ok';
}
'''
if new not in source:
    if old not in source:
        raise SystemExit('severityFor anchor was not found.')
    source = source.replace(old, new, 1)
old_call = "  const status: MonitoringStatus = { ...base, severity: severityFor(base) };"
new_call = "  const status: MonitoringStatus = { ...base, severity: severityFor(base, effective) };"
if new_call not in source:
    if old_call not in source:
        raise SystemExit('severityFor call anchor was not found.')
    source = source.replace(old_call, new_call, 1)
path.write_text(source, encoding='utf-8')
