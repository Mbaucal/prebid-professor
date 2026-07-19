from pathlib import Path

path = Path('src/components/ReleaseDiffPanel.tsx')
source = path.read_text(encoding='utf-8')
old = '''function cleanEntity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanEntity);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_ENTITY_KEYS.has(key))
      .map(([key, candidate]) => [key, cleanEntity(candidate)]),
  );
}
'''
new = '''function cleanEntity(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanEntity(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => depth > 0 || !VOLATILE_ENTITY_KEYS.has(key))
      .map(([key, candidate]) => [key, cleanEntity(candidate, depth + 1)]),
  );
}
'''
if new not in source:
    if old not in source:
        raise SystemExit('cleanEntity anchor was not found.')
    source = source.replace(old, new, 1)
path.write_text(source, encoding='utf-8')
print('Nested adapter id parameters are preserved in release comparisons.')
