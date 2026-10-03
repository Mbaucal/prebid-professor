import type { RuntimeCompileInput } from '../runtime-compiler';
import type { PreviewSnapshot, RuntimeDescriptor } from './contracts';
export type PreviewInput = {
  core: Omit<RuntimeCompileInput, 'template'>;
  options: {
    buildTimestamp: string; adContainerSelector: string; enablePrebid: boolean; debug: boolean;
    sticky: { bottomAdUnitId: string; topAdUnitId: string; refreshSeconds: number };
    floors: { enabled: boolean; hardFloor: number; currency: string; bidderFloors: Record<string, number>; rules: Record<string, number> };
    takeOver: { enabled: boolean } & Record<string, unknown>;
    currencyConversion: { enabled: boolean; url: string };
    schain?: { ver: string; complete: 0 | 1; nodes: Record<string, unknown>[] };
  };
};
export function previewInput(snapshot: PreviewSnapshot, descriptor: RuntimeDescriptor, buildTimestamp: string, takeOver?: { enabled: boolean } & Record<string, unknown>): PreviewInput;
export function digest(value: unknown): Promise<string>;
export function assertReview(snapshot: PreviewSnapshot, expected: unknown): Promise<void>;
