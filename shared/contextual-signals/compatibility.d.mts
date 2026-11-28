export function contextualCompatibility(bidder: string, prebidVersion: string | null): {
  bidder: string; prebidVersion: string | null; reviewedVersions: string[];
  evidence: string; delivery: string; serverAcceptance: string; note: string; source: string | null;
};
