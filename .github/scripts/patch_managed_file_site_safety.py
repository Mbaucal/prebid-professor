from pathlib import Path

path = Path('src/components/AdsTxtManagedFilePanel.tsx')
source = path.read_text()

old_detection = """      const changed = markerBefore.signature !== markerSignatureRef.current;
      if (!force && !changed && activeSiteIdRef.current) return;

      const generation = ++detectionGeneration.current;
"""
new_detection = """      const changed = markerBefore.signature !== markerSignatureRef.current;
      if (changed) {
        markerSignatureRef.current = markerBefore.signature;
        activeSiteIdRef.current = '';
        loadGeneration.current += 1;
        setSite(null);
        setFile(null);
        setPreviewOpen(false);
        setCopied(false);
        setMessage(null);
        setError(null);
        setLoading(true);
        setRefreshing(false);
      }
      if (!force && !changed && activeSiteIdRef.current) return;

      const generation = ++detectionGeneration.current;
"""
if old_detection not in source:
    raise SystemExit('Site detection target not found')
source = source.replace(old_detection, new_detection, 1)

source = source.replace(
    "window.setTimeout(() => URL.revokeObjectURL(url), 0);",
    "window.setTimeout(() => URL.revokeObjectURL(url), 1_000);",
    1,
)
source = source.replace(
    "            aria-expanded={previewOpen}\n            className=\"ads-txt-managed-file-toggle\"",
    "            aria-controls=\"ads-txt-managed-file-preview\"\n            aria-expanded={previewOpen}\n            className=\"ads-txt-managed-file-toggle\"",
    1,
)
source = source.replace(
    "            <pre className=\"ads-txt-managed-file-preview\">{file.content}</pre>",
    "            <pre className=\"ads-txt-managed-file-preview\" id=\"ads-txt-managed-file-preview\">{file.content}</pre>",
    1,
)

path.write_text(source)
