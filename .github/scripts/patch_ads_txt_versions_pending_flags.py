from pathlib import Path

path = Path('src/components/AdsTxtVersionsPanel.tsx')
source = path.read_text()

old_clear = """      setDetails({});
      setPreviewId(null);
      setNote('');
      setMessage(null);
      setLoading(false);
      setError(errorMessage);
"""
new_clear = """      setDetails({});
      setPreviewId(null);
      setHistoryOpen(false);
      setSaving(false);
      setActionId(null);
      setNote('');
      setMessage(null);
      setLoading(false);
      setError(errorMessage);
"""
if old_clear not in source:
    raise SystemExit('clearResolvedSite reset block not found')
source = source.replace(old_clear, new_clear, 1)

old_changed = """        setDetails({});
        setPreviewId(null);
        setNote('');
        setMessage(null);
        setError(null);
        setLoading(true);
"""
new_changed = """        setDetails({});
        setPreviewId(null);
        setHistoryOpen(false);
        setSaving(false);
        setActionId(null);
        setNote('');
        setMessage(null);
        setError(null);
        setLoading(true);
"""
if old_changed not in source:
    raise SystemExit('changed-site reset block not found')
source = source.replace(old_changed, new_changed, 1)

old_resolved = """        setDetails({});
        setPreviewId(null);
        setNote('');
        setMessage(null);
        setError(null);
        void loadForSite(currentSite);
"""
new_resolved = """        setDetails({});
        setPreviewId(null);
        setHistoryOpen(false);
        setSaving(false);
        setActionId(null);
        setNote('');
        setMessage(null);
        setError(null);
        void loadForSite(currentSite);
"""
if old_resolved not in source:
    raise SystemExit('resolved-site reset block not found')
source = source.replace(old_resolved, new_resolved, 1)

path.write_text(source)
