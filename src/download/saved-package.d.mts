export function downloadStoredPackage(
  id: string,
  progress?: (message: string) => void,
  options?: { siteId?: string | null },
): Promise<void>;
