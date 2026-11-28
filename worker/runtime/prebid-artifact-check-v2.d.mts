export function parsePrebidHeader(text: string): {version: string; modules: string[]};
export function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string>;
