// Explicit mode selection keeps historical jobs unchanged; there is no fallback.
const mode=process.env.TESSERA_TEST_TOOLCHAIN;
if(mode!==undefined&&mode!=='isolated')throw Error('Unknown TESSERA_TEST_TOOLCHAIN mode');
export const isolatedToolchain=mode==='isolated'||process.argv.includes('--isolated-toolchain');
const implementation=await import(isolatedToolchain?'../tools/test-miniflare.mjs':'miniflare');
export const Miniflare=implementation.Miniflare;
export const Headers=implementation.Headers;
