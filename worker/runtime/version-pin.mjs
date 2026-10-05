/** Pure metadata checks shared by the future built-in registry and release builder.
 * Not connected to a production route yet. No alias resolves implicitly here.
 * codeSha256 must cover the entire bundled engine, not only the reference file.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
}
function requiredString(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

export function validateRuntimeDescriptor(value) {
  object(value, 'Runtime descriptor');
  const id = requiredString(value.id, KEY, 'runtime ID');
  const version = requiredString(value.version, EXACT_VERSION, 'exact runtime version');
  const codeSha256 = requiredString(value.codeSha256, SHA256, 'engine SHA-256');
  if (!Number.isSafeInteger(value.configSchemaVersion) || value.configSchemaVersion < 1) {
    throw new Error('Invalid configuration schema version.');
  }
  if (value.channel !== 'stable' && value.channel !== 'preview') throw new Error('Invalid runtime channel.');
  if (!Array.isArray(value.capabilities)) throw new Error('Capabilities must be explicit.');
  const capabilities = value.capabilities.map((item) => requiredString(item, KEY, 'capability'));
  if (new Set(capabilities).size !== capabilities.length) throw new Error('Duplicate capability.');
  return Object.freeze({
    id, version, codeSha256, configSchemaVersion: value.configSchemaVersion,
    channel: value.channel, capabilities: Object.freeze([...capabilities].sort()),
  });
}

/** Resolving Stable/Preview is a separate, explicit user action; save the exact result. */
export function pinRuntime(descriptor, { allowPreview = false } = {}) {
  const runtime = validateRuntimeDescriptor(descriptor);
  if (runtime.channel === 'preview' && allowPreview !== true) {
    throw new Error('Selecting a preview runtime requires explicit opt-in.');
  }
  return Object.freeze({
    schemaVersion: 1, runtimeId: runtime.id, runtimeVersion: runtime.version,
    runtimeSha256: runtime.codeSha256, configSchemaVersion: runtime.configSchemaVersion,
    capabilities: Object.freeze([...runtime.capabilities]),
  });
}

/** Reject unavailable/changed engine bytes rather than falling back to another version. */
export function assertPinnedRuntime(pin, descriptor, requirements) {
  object(pin, 'Runtime pin');
  object(requirements, 'Runtime requirements');
  const runtime = validateRuntimeDescriptor(descriptor);
  if (pin.schemaVersion !== 1 || pin.runtimeId !== runtime.id ||
      pin.runtimeVersion !== runtime.version || pin.runtimeSha256 !== runtime.codeSha256 ||
      pin.configSchemaVersion !== runtime.configSchemaVersion ||
      !Array.isArray(pin.capabilities) ||
      JSON.stringify(pin.capabilities) !== JSON.stringify(runtime.capabilities)) {
    throw new Error('Pinned runtime changed or is unavailable. Explicit upgrade required.');
  }
  if (requirements.configSchemaVersion !== runtime.configSchemaVersion) {
    throw new Error('Configuration schema is incompatible with this runtime.');
  }
  if (!Array.isArray(requirements.capabilities)) throw new Error('Required capabilities must be explicit.');
  for (const capability of requirements.capabilities) {
    requiredString(capability, KEY, 'required capability');
    if (!runtime.capabilities.includes(capability)) {
      throw new Error(`Runtime does not support ${capability}.`);
    }
  }
  return runtime;
}
