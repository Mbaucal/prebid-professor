from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def block(text: str, start_marker: str, end_marker: str, label: str) -> tuple[str, int, int]:
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"{label}: start marker not found")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"{label}: end marker not found")
    return text[start:end], start, end


def patch_monitoring_notification_run() -> None:
    path = "worker/monitoring-notification-run.ts"
    text = read(path)
    text = replace_once(
        text,
        "  let state = await readMonitoringNotificationState(env.DB, siteId);\n  let claimToken: string | null = null;\n  try {",
        "  let state = await readMonitoringNotificationState(env.DB, siteId);\n"
        "  let claimToken: string | null = null;\n"
        "  let evaluatedStatus = state.lastStatus ?? '';\n"
        "  let evaluatedMissingCount = 0;\n"
        "  let deliveredState: MonitoringNotificationState | null = null;\n"
        "  let deliveredResult: Awaited<ReturnType<typeof sendGmailMessage>> | null = null;\n"
        "  let deliveredDecision: Decision | null = null;\n"
        "  let deliveredAttachmentName = '';\n"
        "  try {",
        "notification delivery bookkeeping",
    )
    text = replace_once(
        text,
        "    const status = String(check.status ?? 'fetch-error');\n    const missingEntries = uniqueEntries(check.missing ?? []);",
        "    const status = String(check.status ?? 'fetch-error');\n"
        "    const missingEntries = uniqueEntries(check.missing ?? []);\n"
        "    evaluatedStatus = status;\n"
        "    evaluatedMissingCount = missingEntries.length;",
        "evaluated status bookkeeping",
    )
    text = replace_once(
        text,
        "    await writeMonitoringNotificationState(env.DB, siteId, nextState);",
        "    deliveredState = nextState;\n"
        "    deliveredResult = result;\n"
        "    deliveredDecision = decision;\n"
        "    deliveredAttachmentName = String(message.attachmentName ?? '');\n"
        "    await writeMonitoringNotificationState(env.DB, siteId, nextState);",
        "preserve accepted Gmail state",
    )

    catch_start = text.rfind("  } catch (error) {")
    finally_start = text.rfind("  } finally {")
    if catch_start < 0 or finally_start < catch_start:
        raise RuntimeError("notification catch/finally block not found")
    new_catch = """  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (claimToken) {
      const stateToPersist: MonitoringNotificationState = deliveredState
        ? {
            ...deliveredState,
            lastError: errorMessage,
          }
        : {
            ...state,
            lastCheckedAt: checkedAt,
            lastError: errorMessage,
            updatedAt: checkedAt,
          };
      state = stateToPersist;
      await writeMonitoringNotificationState(env.DB, siteId, stateToPersist).catch(() => undefined);
    }
    await appendMonitoringNotificationLog(env.DB, siteId, {
      kind: deliveredDecision?.kind ?? 'manual',
      status: 'failed',
      provider: 'gmail',
      messageId: deliveredResult?.messageId ?? null,
      recipients: deliveredResult?.to ?? [],
      subject: null,
      attachmentName: deliveredAttachmentName || null,
      errorMessage,
      details: {
        actor,
        serialized: Boolean(claimToken),
        emailAccepted: Boolean(deliveredState && deliveredResult),
        sentMarkerPreserved: Boolean(deliveredState),
      },
    }).catch(() => undefined);

    if (deliveredState && deliveredResult && deliveredDecision) {
      return json({
        ok: true,
        sent: true,
        decision: deliveredDecision.kind,
        reason: deliveredDecision.reason,
        checkedAt,
        adsTxtStatus: evaluatedStatus,
        missingCount: evaluatedMissingCount,
        messageId: deliveredResult.messageId,
        from: deliveredResult.from,
        recipients: deliveredResult.to,
        attachmentName: deliveredAttachmentName,
        state: deliveredState,
        warning: `Gmail accepted the message, but a follow-up state or log write reported an error: ${errorMessage}`,
      });
    }

    return apiError('Monitoring notification evaluation failed.', 502, errorMessage);
"""
    text = text[:catch_start] + new_catch + text[finally_start:]
    write(path, text)


def patch_monitoring_readonly_panel() -> None:
    path = "src/components/MonitoringReadonlyPanel.tsx"
    text = read(path)
    text = replace_once(
        text,
        "  const activeSiteId = useRef(site.id);\n  activeSiteId.current = site.id;",
        "  const activeSiteId = useRef(site.id);\n"
        "  const statusGeneration = useRef(0);\n"
        "  const draftLoadGeneration = useRef(0);\n"
        "  const draftSaveGeneration = useRef(0);\n"
        "  const previewGeneration = useRef(0);\n"
        "  activeSiteId.current = site.id;",
        "monitoring generation refs",
    )

    current, start, end = block(text, "  const load = useCallback(async () => {", "\n\n  const loadServerDraft", "status load block")
    current = replace_once(current, "    const requestedSiteId = site.id;", "    const requestedSiteId = site.id;\n    const generation = ++statusGeneration.current;", "status generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || statusGeneration.current !== generation) return;",
    )
    current = current.replace(
        "if (activeSiteId.current === requestedSiteId) setLoading(false);",
        "if (activeSiteId.current === requestedSiteId && statusGeneration.current === generation) setLoading(false);",
    )
    text = text[:start] + current + text[end:]

    current, start, end = block(text, "  const loadServerDraft = useCallback(async () => {", "\n\n  useEffect(() => {", "draft load block")
    current = replace_once(current, "    const requestedSiteId = site.id;", "    const requestedSiteId = site.id;\n    const generation = ++draftLoadGeneration.current;", "draft load generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || draftLoadGeneration.current !== generation) return;",
    )
    text = text[:start] + current + text[end:]

    text = replace_once(
        text,
        "  useEffect(() => {\n    setPayload(null);",
        "  useEffect(() => {\n"
        "    statusGeneration.current += 1;\n"
        "    draftLoadGeneration.current += 1;\n"
        "    draftSaveGeneration.current += 1;\n"
        "    previewGeneration.current += 1;\n"
        "    setPayload(null);",
        "invalidate requests on site change",
    )

    current, start, end = block(text, "  async function saveServerDraft(): Promise<void> {", "\n\n  function clearDraft", "draft save block")
    current = replace_once(current, "    const requestedSiteId = site.id;", "    const requestedSiteId = site.id;\n    const generation = ++draftSaveGeneration.current;", "draft save generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || draftSaveGeneration.current !== generation) return;",
    )
    current = current.replace(
        "if (activeSiteId.current === requestedSiteId) setServerSaving(false);",
        "if (activeSiteId.current === requestedSiteId && draftSaveGeneration.current === generation) setServerSaving(false);",
    )
    text = text[:start] + current + text[end:]

    current, start, end = block(text, "  async function generatePreview(): Promise<void> {", "\n\n  async function copyPreviewPart", "preview block")
    current = replace_once(current, "    const requestedSiteId = site.id;", "    const requestedSiteId = site.id;\n    const generation = ++previewGeneration.current;", "preview generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || previewGeneration.current !== generation) return;",
    )
    current = current.replace(
        "if (activeSiteId.current === requestedSiteId) setPreviewing(false);",
        "if (activeSiteId.current === requestedSiteId && previewGeneration.current === generation) setPreviewing(false);",
    )
    text = text[:start] + current + text[end:]
    write(path, text)


def patch_notification_rules() -> None:
    path = "src/components/MonitoringNotificationRules.tsx"
    text = read(path)
    text = replace_once(
        text,
        "  const activeSiteId = useRef(siteId);\n  const confirmActionRef = useRef<HTMLButtonElement | null>(null);\n  activeSiteId.current = siteId;",
        "  const activeSiteId = useRef(siteId);\n"
        "  const loadGeneration = useRef(0);\n"
        "  const saveGeneration = useRef(0);\n"
        "  const runGeneration = useRef(0);\n"
        "  const confirmActionRef = useRef<HTMLButtonElement | null>(null);\n"
        "  const confirmDialogRef = useRef<HTMLElement | null>(null);\n"
        "  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);\n"
        "  activeSiteId.current = siteId;",
        "notification rule refs",
    )

    current, start, end = block(text, "  const load = useCallback(async () => {", "\n\n  useEffect(() => {", "notification settings load")
    current = replace_once(current, "    const requestedSiteId = siteId;", "    const requestedSiteId = siteId;\n    const generation = ++loadGeneration.current;", "notification load generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || loadGeneration.current !== generation) return;",
    )
    current = current.replace(
        "if (activeSiteId.current === requestedSiteId) setLoading(false);",
        "if (activeSiteId.current === requestedSiteId && loadGeneration.current === generation) setLoading(false);",
    )
    text = text[:start] + current + text[end:]

    text = replace_once(
        text,
        "  useEffect(() => {\n    setBundle(null);",
        "  useEffect(() => {\n"
        "    loadGeneration.current += 1;\n"
        "    saveGeneration.current += 1;\n"
        "    runGeneration.current += 1;\n"
        "    setBundle(null);",
        "invalidate notification requests",
    )

    focus_old, focus_start, focus_end = block(
        text,
        "  useEffect(() => {\n    if (!confirmOpen) return undefined;",
        "\n\n  function update<",
        "confirmation focus block",
    )
    focus_new = """  useEffect(() => {
    if (!confirmOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const trigger = confirmTriggerRef.current;
    const backgroundElements = Array.from(document.querySelectorAll<HTMLElement>(
      '.sidebar, .topbar, .tabbar, .monitor-readonly-card',
    ));
    const previousInert = backgroundElements.map((element) => element.hasAttribute('inert'));

    document.body.style.overflow = 'hidden';
    backgroundElements.forEach((element) => element.setAttribute('inert', ''));
    window.requestAnimationFrame(() => confirmActionRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) {
        event.preventDefault();
        setConfirmOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = confirmDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (!focusable.length) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      backgroundElements.forEach((element, index) => {
        if (previousInert[index]) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
      });
      document.removeEventListener('keydown', onKeyDown);
      window.requestAnimationFrame(() => trigger?.focus());
    };
  }, [confirmOpen, running]);
"""
    text = text[:focus_start] + focus_new + text[focus_end:]

    current, start, end = block(text, "  async function save(): Promise<void> {", "\n\n  async function runNow", "notification save block")
    current = replace_once(current, "    const requestedSiteId = siteId;", "    const requestedSiteId = siteId;\n    const generation = ++saveGeneration.current;", "notification save generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || saveGeneration.current !== generation) return;",
    )
    current = current.replace(
        "if (activeSiteId.current === requestedSiteId) setSaving(false);",
        "if (activeSiteId.current === requestedSiteId && saveGeneration.current === generation) setSaving(false);",
    )
    text = text[:start] + current + text[end:]

    current, start, end = block(text, "  async function runNow(): Promise<void> {", "\n\n  const disabledReasons", "notification run block")
    current = replace_once(current, "    const requestedSiteId = siteId;", "    const requestedSiteId = siteId;\n    const generation = ++runGeneration.current;", "notification run generation")
    current = current.replace(
        "if (activeSiteId.current !== requestedSiteId) return;",
        "if (activeSiteId.current !== requestedSiteId || runGeneration.current !== generation) return;",
    )
    current = current.replace(
        "if (activeSiteId.current === requestedSiteId) setRunning(false);",
        "if (activeSiteId.current === requestedSiteId && runGeneration.current === generation) setRunning(false);",
    )
    text = text[:start] + current + text[end:]

    text = replace_once(
        text,
        "<button className=\"button primary\" disabled={Boolean(disabledReasons.length) || running} onClick={() => setConfirmOpen(true)} type=\"button\">",
        "<button ref={confirmTriggerRef} className=\"button primary\" disabled={Boolean(disabledReasons.length) || running} onClick={() => setConfirmOpen(true)} type=\"button\">",
        "confirmation trigger ref",
    )
    text = replace_once(
        text,
        "            className=\"monitor-confirm-dialog\"\n            role=\"dialog\"",
        "            className=\"monitor-confirm-dialog\"\n            ref={confirmDialogRef}\n            role=\"dialog\"",
        "confirmation dialog ref",
    )
    write(path, text)


def patch_ads_txt_duplicate_details() -> None:
    path = "worker/ads-txt.ts"
    text = read(path)
    text = replace_once(
        text,
        "function actualAdsEntries(text: string): {",
        "const MAX_DUPLICATE_GROUPS = 100;\n"
        "const MAX_DUPLICATE_OCCURRENCES_PER_GROUP = 20;\n\n"
        "function actualAdsEntries(text: string): {",
        "duplicate detail constants",
    )
    text = replace_once(
        text,
        "  duplicateCount: number;\n  duplicateEntries: Array<{",
        "  duplicateCount: number;\n"
        "  duplicateEntryGroupCount: number;\n"
        "  duplicateEntriesTruncated: boolean;\n"
        "  duplicateEntries: Array<{",
        "duplicate metadata return type",
    )
    old = """  const duplicateEntries = Array.from(occurrences.values())
    .filter((item) => item.lineNumbers.length > 1)
    .map((item) => ({
      entry: item.entry,
      occurrences: item.lineNumbers.length,
      lineNumbers: item.lineNumbers,
      rawOccurrences: item.rawOccurrences,
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.entry.localeCompare(right.entry));

  return { canonical, validCount, invalidCount, duplicateCount, duplicateEntries };
"""
    new = """  const duplicateGroups = Array.from(occurrences.values())
    .filter((item) => item.lineNumbers.length > 1)
    .sort((left, right) => right.lineNumbers.length - left.lineNumbers.length || left.entry.localeCompare(right.entry));
  const duplicateEntryGroupCount = duplicateGroups.length;
  const duplicateEntriesTruncated = duplicateEntryGroupCount > MAX_DUPLICATE_GROUPS
    || duplicateGroups.some((item) => item.lineNumbers.length > MAX_DUPLICATE_OCCURRENCES_PER_GROUP);
  const duplicateEntries = duplicateGroups
    .slice(0, MAX_DUPLICATE_GROUPS)
    .map((item) => ({
      entry: item.entry,
      occurrences: item.lineNumbers.length,
      lineNumbers: item.lineNumbers.slice(0, MAX_DUPLICATE_OCCURRENCES_PER_GROUP),
      rawOccurrences: item.rawOccurrences.slice(0, MAX_DUPLICATE_OCCURRENCES_PER_GROUP),
    }));

  return {
    canonical,
    validCount,
    invalidCount,
    duplicateCount,
    duplicateEntryGroupCount,
    duplicateEntriesTruncated,
    duplicateEntries,
  };
"""
    text = replace_once(text, old, new, "cap duplicate details")
    text = replace_once(
        text,
        "        duplicateLineCount: actual.duplicateCount,\n        duplicateEntries: actual.duplicateEntries,",
        "        duplicateLineCount: actual.duplicateCount,\n"
        "        duplicateEntryGroupCount: actual.duplicateEntryGroupCount,\n"
        "        duplicateEntriesTruncated: actual.duplicateEntriesTruncated,\n"
        "        duplicateEntries: actual.duplicateEntries,",
        "duplicate response metadata",
    )
    write(path, text)


def remove_experimental_files() -> None:
    paths = [
        ".github/ads-txt-pre-connector.trigger",
        ".github/ads-txt-raw-repeats.trigger",
        ".github/ads-txt-repeat-labels.trigger",
        ".github/ads-txt-search-duplicates.trigger",
        ".github/ads-txt-search-live-matches.trigger",
        ".github/gmail-oauth.trigger",
        ".github/monitoring-daily-cron.trigger",
        ".github/monitoring-legacy-schema-upgrade.trigger",
        ".github/monitoring-log-kind-compat.trigger",
        ".github/monitoring-notification-rules.trigger",
        ".github/monitoring-premerge-hardening.trigger",
        ".github/monitoring-review-hardening.trigger",
        ".github/scripts/align_ads_txt_pre_connector.py",
        ".github/scripts/clarify_ads_txt_repeat_labels.py",
        ".github/scripts/integrate_ads_txt_raw_repeats.py",
        ".github/scripts/integrate_ads_txt_search_duplicates.py",
        ".github/scripts/integrate_ads_txt_search_live_matches.py",
        ".github/scripts/integrate_gmail_oauth.py",
        ".github/scripts/integrate_monitoring_daily_cron.py",
        ".github/scripts/integrate_monitoring_legacy_schema_upgrade.py",
        ".github/scripts/integrate_monitoring_log_kind_compat.py",
        ".github/scripts/integrate_monitoring_notification_rules.py",
        ".github/scripts/integrate_monitoring_premerge_hardening.py",
        ".github/scripts/integrate_monitoring_review_hardening.py",
        ".github/workflows/align-ads-txt-pre-connector.yml",
        ".github/workflows/clarify-ads-txt-repeat-labels.yml",
        ".github/workflows/integrate-ads-txt-raw-repeats.yml",
        ".github/workflows/integrate-ads-txt-search-duplicates.yml",
        ".github/workflows/integrate-ads-txt-search-live-matches.yml",
        ".github/workflows/integrate-gmail-oauth.yml",
        ".github/workflows/integrate-monitoring-daily-cron.yml",
        ".github/workflows/integrate-monitoring-legacy-schema-upgrade.yml",
        ".github/workflows/integrate-monitoring-log-kind-compat.yml",
        ".github/workflows/integrate-monitoring-notification-rules.yml",
        ".github/workflows/integrate-monitoring-premerge-hardening.yml",
        ".github/workflows/integrate-monitoring-review-hardening.yml",
        "migrations/0006_ads_txt_requirement_duplicates.sql",
        "src/components/AdsTxtPreConnectorGuard.tsx",
        "src/components/AdsTxtRequirementDuplicateGuard.tsx",
        "worker/ads-txt-requirement-duplicates.ts",
        "worker/ads-txt-requirement-schema.ts",
        "worker/app-ads-txt-duplicates.ts",
        ".github/finalize-monitoring.trigger",
        ".github/workflows/finalize-monitoring-branch.yml",
        ".github/scripts/finalize_monitoring_branch.py",
    ]
    for relative in paths:
        candidate = ROOT / relative
        if candidate.exists():
            candidate.unlink()


def main() -> None:
    patch_monitoring_notification_run()
    patch_monitoring_readonly_panel()
    patch_notification_rules()
    patch_ads_txt_duplicate_details()
    remove_experimental_files()


if __name__ == "__main__":
    main()
