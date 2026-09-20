import ConfirmDeleteButton from './ConfirmDeleteButton';
import { useMemo, useState } from 'react';

type ReleaseSummary = {
  id: string;
  version: string;
  displayName?: string;
  status: string;
  manifest: Record<string, unknown> | null;
};

type DeletePayload = {
  ok: true;
  deleted: {
    id: string;
    version: string;
    status: string;
    objectsDeleted: number;
    bytesFreed: number;
    externalDeploymentsDeleted: number;
  };
};

type Props = {
  publisherId: string;
  release: ReleaseSummary;
  disabled?: boolean;
  onDeleted: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function manifestBytes(manifest: Record<string, unknown> | null): number {
  if (!manifest || typeof manifest.files !== 'object' || manifest.files === null || Array.isArray(manifest.files)) {
    return 0;
  }

  return Object.values(manifest.files as Record<string, unknown>).reduce((total, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return total;
    const size = Number((value as Record<string, unknown>).size);
    return total + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
}

export default function ReleaseDeleteButton({
  publisherId,
  release,
  disabled = false,
  onDeleted,
  onError,
}: Props) {
  const [deleting, setDeleting] = useState(false);
  const estimatedBytes = useMemo(() => manifestBytes(release.manifest), [release.manifest]);
  const deletable = ['draft', 'failed', 'archived'].includes(release.status);

  if (!deletable) return null;

  async function remove(): Promise<void> {
    setDeleting(true);
    onError('');
    try {
      const response = await fetch(
        `/api/publishers/${encodeURIComponent(publisherId)}/releases/${encodeURIComponent(release.id)}`,
        { method: 'DELETE', headers: {'x-confirm-delete':release.id} },
      );
      const text = await response.text();
      let payload: DeletePayload | { error?: string; details?: unknown };
      try {
        payload = text ? JSON.parse(text) as DeletePayload : {};
      } catch {
        throw new Error(text || `Delete failed with status ${response.status}.`);
      }
      if (!response.ok || !('deleted' in payload)) {
        const details = 'details' in payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error(`${'error' in payload && payload.error ? payload.error : `Delete failed with status ${response.status}.`}${details}`);
      }

      const freed = formatBytes(payload.deleted.bytesFreed);
      const message = `Deleted ${payload.deleted.version}: ${payload.deleted.objectsDeleted} R2 object(s), ${freed} freed.`;
      await onDeleted(message);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Release could not be deleted.');
      throw error;
    } finally {
      setDeleting(false);
    }
  }

  return <ConfirmDeleteButton name={release.displayName||release.version} disabled={disabled||deleting}
    description="Delete this saved release and its files permanently? Download a ZIP first if you need a backup. Active releases cannot be deleted."
    label={estimatedBytes ? `Delete · ${formatBytes(estimatedBytes)}` : 'Delete release'} onConfirm={remove}/>;
}
