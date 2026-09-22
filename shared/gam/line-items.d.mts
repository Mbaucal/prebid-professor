export const MAX_LINE_ITEMS: number;
export const ORDER_BATCH: number;
export const LINE_ITEM_TYPES: string[];
export const DEFAULT_LINE_SIZES: string;
export const PREBID_CREATIVE: string;
export function priceRows(
  ranges: { from: string; to: string; step: string }[],
): { price: string; microAmount: number }[];
export function normalizeLinePlan(input: unknown, now?: number): any;

export function prebidNamingPreview(input: unknown): {
  orders: string[];
  examples: {
    name: string;
    price: string;
    hbPb: string;
    order: string;
    creativeFirst: string;
    creativeLast: string;
  }[];
};
