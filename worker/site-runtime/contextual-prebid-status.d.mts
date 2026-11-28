export type ContextualPrebidStatus = {
  status: 'no-build' | 'unknown' | 'modules-missing' | 'modules-present';
  buildId: string | null;
  selectedBuildId: string | null;
  selectionMatches: boolean;
  missingModules: string[];
  evidence: 'current-build-metadata';
};
export function contextualPrebidStatus(builds: unknown, selectedId?: string | null): ContextualPrebidStatus;
