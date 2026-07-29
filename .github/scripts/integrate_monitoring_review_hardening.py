from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if new in source:
        print(f"{label}: already applied")
        return
    if old not in source:
        raise SystemExit(f"{label} anchor was not found in {path}.")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")
    print(f"{label}: applied")


def replace_from(path: str, marker: str, replacement: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if replacement in source:
        print(f"{label}: already applied")
        return
    index = source.find(marker)
    if index < 0:
        raise SystemExit(f"{label} marker was not found in {path}.")
    file_path.write_text(source[:index] + replacement.rstrip() + "\n", encoding="utf-8")
    print(f"{label}: applied")


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"Integration validation failed in {path}: {missing}")


# Guard notification-rule responses when the operator switches sites.
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    "import { useCallback, useEffect, useState } from 'react';",
    "import { useCallback, useEffect, useRef, useState } from 'react';",
    "notification rules useRef import",
)
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    """  const [message, setMessage] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<Bundle>(
        `/api/publishers/${encodeURIComponent(siteId)}/monitoring/notification-settings?ts=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      setBundle(payload);
      setSettings(payload.settings);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Notification rules could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    setBundle(null);
    setSettings(null);
    setRunResult(null);
    setMessage(null);
    void load();
  }, [load, siteId]);""",
    """  const [message, setMessage] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const activeSiteId = useRef(siteId);
  activeSiteId.current = siteId;

  const load = useCallback(async () => {
    const requestedSiteId = siteId;
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<Bundle>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/monitoring/notification-settings?ts=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteId.current !== requestedSiteId) return;
      setBundle(payload);
      setSettings(payload.settings);
    } catch (loadError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(loadError instanceof Error ? loadError.message : 'Notification rules could not be loaded.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    setBundle(null);
    setSettings(null);
    setRunResult(null);
    setMessage(null);
    setError(null);
    setSaving(false);
    setRunning(false);
    setLoading(true);
    void load();
  }, [load, siteId]);""",
    "notification rules active-site load guard",
)
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    """  async function save(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<{ ok: true; settings: NotificationSettings; updatedAt: string }>(
        `/api/publishers/${encodeURIComponent(siteId)}/monitoring/notification-settings`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ settings }),
        },
      );
      setSettings(payload.settings);
      setMessage(`Notification rules saved · ${formatTime(payload.updatedAt)}.`);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Notification rules could not be saved.');
    } finally {
      setSaving(false);
    }
  }""",
    """  async function save(): Promise<void> {
    if (!settings) return;
    const requestedSiteId = siteId;
    const settingsToSave = settings;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<{ ok: true; settings: NotificationSettings; updatedAt: string }>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/monitoring/notification-settings`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ settings: settingsToSave }),
        },
      );
      if (activeSiteId.current !== requestedSiteId) return;
      setSettings(payload.settings);
      setMessage(`Notification rules saved · ${formatTime(payload.updatedAt)}.`);
      await load();
    } catch (saveError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(saveError instanceof Error ? saveError.message : 'Notification rules could not be saved.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setSaving(false);
    }
  }""",
    "notification rules save response guard",
)
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    """  async function runNow(): Promise<void> {
    if (!settings?.enabled || !gmailConnected || !templateSaved || running) return;
    if (!window.confirm('Evaluate the saved notification rules now?\\n\\nIf the current ads.txt state matches a rule, Tessera will send a real Gmail message.')) return;
    setRunning(true);
    setError(null);
    setMessage(null);
    setRunResult(null);
    try {
      const result = await requestJson<RunResult>(
        `/api/publishers/${encodeURIComponent(siteId)}/monitoring/notifications/run`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ mode: 'manual-preview' }),
        },
      );
      setRunResult(result);
      setMessage(result.sent
        ? `Gmail notification sent · ${result.messageId ?? 'message accepted'}.`
        : `No email sent: ${result.reason}`);
      await load();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Notification evaluation failed.');
      await load();
    } finally {
      setRunning(false);
    }
  }""",
    """  async function runNow(): Promise<void> {
    if (!settings?.enabled || !gmailConnected || !templateSaved || running) return;
    if (!window.confirm('Evaluate the saved notification rules now?\\n\\nIf the current ads.txt state matches a rule, Tessera will send a real Gmail message.')) return;
    const requestedSiteId = siteId;
    setRunning(true);
    setError(null);
    setMessage(null);
    setRunResult(null);
    try {
      const result = await requestJson<RunResult>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/monitoring/notifications/run`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ mode: 'manual-preview' }),
        },
      );
      if (activeSiteId.current !== requestedSiteId) return;
      setRunResult(result);
      setMessage(result.sent
        ? `Gmail notification sent · ${result.messageId ?? 'message accepted'}.`
        : `No email sent: ${result.reason}`);
      await load();
    } catch (runError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(runError instanceof Error ? runError.message : 'Notification evaluation failed.');
      await load();
    } finally {
      if (activeSiteId.current === requestedSiteId) setRunning(false);
    }
  }""",
    "notification rules run response guard",
)

# Guard saved-template and email-preview responses in the parent monitoring panel.
replace_once(
    "src/components/MonitoringReadonlyPanel.tsx",
    """    setDraftMessage(null);
    setServerDraft(null);
    setDraft(loadDraft(site.id));
    void load();""",
    """    setDraftMessage(null);
    setServerDraft(null);
    setPreviewing(false);
    setServerSaving(false);
    setDraft(loadDraft(site.id));
    void load();""",
    "monitoring site-switch busy-state reset",
)
replace_once(
    "src/components/MonitoringReadonlyPanel.tsx",
    """  async function saveServerDraft(): Promise<void> {
    setServerSaving(true);
    setError(null);
    setDraftMessage(null);
    try {
      const savedDraft = await persistMonitoringEmailDraft(site.id, draft);
      setServerDraft(savedDraft);
      setDraft(savedDraft.settings);
      window.localStorage.setItem(storageKey(site.id), JSON.stringify(savedDraft.settings));
      setDraftMessage(`Draft saved to Tessera${savedDraft.updatedAt ? ` · ${formatTime(savedDraft.updatedAt)}` : ''}. No email was sent.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Email draft could not be saved to Tessera.');
    } finally {
      setServerSaving(false);
    }
  }""",
    """  async function saveServerDraft(): Promise<void> {
    const requestedSiteId = site.id;
    const draftToSave = draft;
    setServerSaving(true);
    setError(null);
    setDraftMessage(null);
    try {
      const savedDraft = await persistMonitoringEmailDraft(requestedSiteId, draftToSave);
      if (activeSiteId.current !== requestedSiteId) return;
      setServerDraft(savedDraft);
      setDraft(savedDraft.settings);
      window.localStorage.setItem(storageKey(requestedSiteId), JSON.stringify(savedDraft.settings));
      setDraftMessage(`Draft saved to Tessera${savedDraft.updatedAt ? ` · ${formatTime(savedDraft.updatedAt)}` : ''}. No email was sent.`);
    } catch (requestError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(requestError instanceof Error ? requestError.message : 'Email draft could not be saved to Tessera.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setServerSaving(false);
    }
  }""",
    "monitoring saved-template response guard",
)
replace_once(
    "src/components/MonitoringReadonlyPanel.tsx",
    """  async function generatePreview(): Promise<void> {
    if (!payload) return;
    setPreviewing(true);
    setError(null);
    setDraftMessage(null);
    try {
      const data = await requestEmailPreviewData(site.id);
      const missingEntries = uniqueEntries(payload.adsTxt.missing ?? []);
      const expectedEntries = uniqueEntries(data.expected);
      const missingText = groupedEntries(missingEntries) || 'None';
      const baseVariables: Record<string, string> = {
        publisher_name: data.site.publisherName || '',
        site_name: data.site.name,
        domain: data.site.domain,
        ads_txt_url: data.live.finalUrl || data.site.adsTxtUrl,
        status: adsTxtLabel(payload.adsTxt),
        checked_at: formatTime(payload.checkedAt),
        missing_count: String(payload.adsTxt.requiredMissingCount ?? missingEntries.length),
        missing_entries: missingText,
        current_version: payload.runtime.expectedVersion ?? '',
        manifest_version: payload.runtime.manifestVersion ?? '',
        sender_name: draft.senderName,
        attachment_name: '',
      };
      const attachmentName = safeFileName(renderTemplate(draft.attachmentNameTemplate || '{{domain}}-ads.txt', baseVariables));
      const variables = { ...baseVariables, attachment_name: attachmentName };

      let attachmentContent = '';
      const warnings: string[] = [];
      if (draft.attachmentMode === 'missing-only') {
        attachmentContent = groupedEntries(missingEntries);
      } else if (draft.attachmentMode === 'expected-only') {
        attachmentContent = groupedEntries(expectedEntries);
      } else if (data.live.error) {
        warnings.push(`Full corrected ads.txt could not be created: ${data.live.error}`);
        attachmentContent = groupedEntries(expectedEntries);
      } else {
        attachmentContent = correctedAdsTxt(data.live.content, missingEntries);
      }
      if (attachmentContent && !attachmentContent.endsWith('\\n')) attachmentContent += '\\n';
      if (!draft.subjectTemplate.trim()) warnings.push('Subject template is empty.');
      if (!draft.bodyTemplate.trim()) warnings.push('Email body template is empty.');
      if (!draft.to.trim()) warnings.push('Recipient list is empty.');

      setPreview({
        subject: renderTemplate(draft.subjectTemplate, variables),
        body: renderTemplate(draft.bodyTemplate, variables),
        bodyFormat: draft.bodyFormat,
        attachmentName,
        attachmentContent,
        variables,
        warnings,
      });
      setDraftMessage('Preview generated. No email was sent and current form values were not saved automatically.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Email preview could not be generated.');
    } finally {
      setPreviewing(false);
    }
  }""",
    """  async function generatePreview(): Promise<void> {
    if (!payload) return;
    const requestedSiteId = site.id;
    const payloadSnapshot = payload;
    const draftSnapshot = draft;
    setPreviewing(true);
    setError(null);
    setDraftMessage(null);
    try {
      const data = await requestEmailPreviewData(requestedSiteId);
      if (activeSiteId.current !== requestedSiteId) return;
      const missingEntries = uniqueEntries(payloadSnapshot.adsTxt.missing ?? []);
      const expectedEntries = uniqueEntries(data.expected);
      const missingText = groupedEntries(missingEntries) || 'None';
      const baseVariables: Record<string, string> = {
        publisher_name: data.site.publisherName || '',
        site_name: data.site.name,
        domain: data.site.domain,
        ads_txt_url: data.live.finalUrl || data.site.adsTxtUrl,
        status: adsTxtLabel(payloadSnapshot.adsTxt),
        checked_at: formatTime(payloadSnapshot.checkedAt),
        missing_count: String(payloadSnapshot.adsTxt.requiredMissingCount ?? missingEntries.length),
        missing_entries: missingText,
        current_version: payloadSnapshot.runtime.expectedVersion ?? '',
        manifest_version: payloadSnapshot.runtime.manifestVersion ?? '',
        sender_name: draftSnapshot.senderName,
        attachment_name: '',
      };
      const attachmentName = safeFileName(renderTemplate(
        draftSnapshot.attachmentNameTemplate || '{{domain}}-ads.txt',
        baseVariables,
      ));
      const variables = { ...baseVariables, attachment_name: attachmentName };

      let attachmentContent = '';
      const warnings: string[] = [];
      if (draftSnapshot.attachmentMode === 'missing-only') {
        attachmentContent = groupedEntries(missingEntries);
      } else if (draftSnapshot.attachmentMode === 'expected-only') {
        attachmentContent = groupedEntries(expectedEntries);
      } else if (data.live.error) {
        warnings.push(`Full corrected ads.txt could not be created: ${data.live.error}`);
        attachmentContent = groupedEntries(expectedEntries);
      } else {
        attachmentContent = correctedAdsTxt(data.live.content, missingEntries);
      }
      if (attachmentContent && !attachmentContent.endsWith('\\n')) attachmentContent += '\\n';
      if (!draftSnapshot.subjectTemplate.trim()) warnings.push('Subject template is empty.');
      if (!draftSnapshot.bodyTemplate.trim()) warnings.push('Email body template is empty.');
      if (!draftSnapshot.to.trim()) warnings.push('Recipient list is empty.');
      if (activeSiteId.current !== requestedSiteId) return;

      setPreview({
        subject: renderTemplate(draftSnapshot.subjectTemplate, variables),
        body: renderTemplate(draftSnapshot.bodyTemplate, variables),
        bodyFormat: draftSnapshot.bodyFormat,
        attachmentName,
        attachmentContent,
        variables,
        warnings,
      });
      setDraftMessage('Preview generated. No email was sent and current form values were not saved automatically.');
    } catch (requestError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(requestError instanceof Error ? requestError.message : 'Email preview could not be generated.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setPreviewing(false);
    }
  }""",
    "monitoring email-preview response guard",
)
replace_once(
    "src/components/MonitoringReadonlyPanel.tsx",
    """          <div className="monitor-readonly-note">
            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Gmail test sends and manual rule evaluation are explicit actions; the scheduler is still disabled on this preview branch and no release or R2 object is modified.
          </div>""",
    """          <div className="monitor-readonly-note">
            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Gmail test sends and manual rule evaluation are explicit actions. The daily 06:00 UTC schedule is configured; review enabled sites and recipients before promoting this version to an active deployment. No release or R2 object is modified.
          </div>""",
    "monitoring scheduler safety copy",
)

# Serialize every evaluation that may write notification state, including healthy/no-send checks.
new_run_function = r'''export async function runMonitoringNotification(
  request: Request,
  env: MonitoringNotificationRunEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  const site = await env.DB.prepare(
    'SELECT id, name, domain, current_version FROM publishers WHERE id = ? LIMIT 1',
  ).bind(siteId).first<SiteRow>();
  if (!site) return apiError('Site not found.', 404);

  const actor = getActor(request);
  const checkedAt = new Date().toISOString();
  let state = await readMonitoringNotificationState(env.DB, siteId);
  let claimToken: string | null = null;
  try {
    claimToken = await acquireEvaluationClaim(env.DB, siteId);
    if (!claimToken) {
      const reason = 'Another notification evaluation is already in progress for this site.';
      state = await readMonitoringNotificationState(env.DB, siteId);
      await appendMonitoringNotificationLog(env.DB, siteId, {
        kind: 'manual',
        status: 'skipped',
        provider: 'gmail',
        messageId: null,
        recipients: [],
        subject: null,
        attachmentName: null,
        errorMessage: null,
        details: { actor, reason, serialized: true },
      });
      return json({
        ok: true,
        sent: false,
        decision: 'none',
        reason,
        checkedAt,
        adsTxtStatus: state.lastStatus ?? '',
        missingCount: 0,
        state,
      });
    }

    const [settings, check] = await Promise.all([
      readMonitoringNotificationSettings(env.DB, siteId),
      readCheck(env, siteId),
    ]);
    state = await readMonitoringNotificationState(env.DB, siteId);
    const status = String(check.status ?? 'fetch-error');
    const missingEntries = uniqueEntries(check.missing ?? []);
    const currentFingerprint = await fingerprint(missingEntries);
    const decision = decide(status, currentFingerprint, state, settings, Date.now());
    state = closeHealthyIncident(status, decision, {
      ...state,
      lastStatus: status,
      lastFingerprint: currentFingerprint,
      lastCheckedAt: checkedAt,
      lastError: null,
      updatedAt: checkedAt,
    });

    if (decision.kind === 'none') {
      await writeMonitoringNotificationState(env.DB, siteId, state);
      await appendMonitoringNotificationLog(env.DB, siteId, {
        kind: 'manual',
        status: 'skipped',
        provider: 'gmail',
        messageId: null,
        recipients: [],
        subject: null,
        attachmentName: null,
        errorMessage: null,
        details: {
          actor,
          reason: decision.reason,
          adsTxtStatus: status,
          missingCount: missingEntries.length,
          fingerprint: currentFingerprint,
          serialized: true,
        },
      });
      return json({
        ok: true,
        sent: false,
        decision: decision.kind,
        reason: decision.reason,
        checkedAt,
        adsTxtStatus: status,
        missingCount: missingEntries.length,
        state,
      });
    }

    const draft = await loadSavedDraft(env.DB, siteId);
    if (!draft) throw new Error('Save the ads.txt email template to Tessera before enabling notifications.');
    if (!draft.to.trim()) throw new Error('The saved email template does not contain a recipient.');
    if (!draft.subjectTemplate.trim() || !draft.bodyTemplate.trim()) {
      throw new Error('The saved email template must contain both a subject and message body.');
    }
    const [preview, manifestVersion] = await Promise.all([
      readPreviewData(env, siteId, check),
      readManifestVersion(env, siteId),
    ]);
    const message = messageFor(
      draft,
      preview,
      site,
      check,
      decision.kind,
      missingEntries,
      manifestVersion,
    );
    const result = await sendGmailMessage(env, message);
    const nextState: MonitoringNotificationState = {
      ...state,
      lastNotifiedFingerprint: decision.kind === 'recovery' ? null : currentFingerprint,
      lastNotifiedAt: decision.kind === 'recovery' ? null : result.sentAt,
      lastRecoveryAt: decision.kind === 'recovery' ? result.sentAt : state.lastRecoveryAt,
      lastError: null,
      updatedAt: result.sentAt,
    };
    await writeMonitoringNotificationState(env.DB, siteId, nextState);
    await appendMonitoringNotificationLog(env.DB, siteId, {
      kind: decision.kind,
      status: 'sent',
      provider: 'gmail',
      messageId: result.messageId,
      recipients: result.to,
      subject: String(message.subject ?? ''),
      attachmentName: String(message.attachmentName ?? ''),
      errorMessage: null,
      details: {
        actor,
        reason: decision.reason,
        adsTxtStatus: status,
        missingCount: missingEntries.length,
        fingerprint: currentFingerprint,
        cc: result.cc,
        from: result.from,
        manifestVersion,
        serialized: true,
      },
    });
    return json({
      ok: true,
      sent: true,
      decision: decision.kind,
      reason: decision.reason,
      checkedAt,
      adsTxtStatus: status,
      missingCount: missingEntries.length,
      messageId: result.messageId,
      from: result.from,
      recipients: result.to,
      attachmentName: String(message.attachmentName ?? ''),
      state: nextState,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (claimToken) {
      state = {
        ...state,
        lastCheckedAt: checkedAt,
        lastError: errorMessage,
        updatedAt: checkedAt,
      };
      await writeMonitoringNotificationState(env.DB, siteId, state).catch(() => undefined);
    }
    await appendMonitoringNotificationLog(env.DB, siteId, {
      kind: 'manual',
      status: 'failed',
      provider: 'gmail',
      messageId: null,
      recipients: [],
      subject: null,
      attachmentName: null,
      errorMessage,
      details: { actor, serialized: Boolean(claimToken) },
    }).catch(() => undefined);
    return apiError('Monitoring notification evaluation failed.', 502, errorMessage);
  } finally {
    if (claimToken) {
      await releaseEvaluationClaim(env.DB, siteId, claimToken).catch(() => undefined);
    }
  }
}'''
replace_from(
    "worker/monitoring-notification-run.ts",
    "export async function runMonitoringNotification(",
    new_run_function,
    "serialized monitoring notification evaluation",
)

replace_once(
    "worker/app-deploy.ts",
    "const RUNTIME_BUILD = '2026-07-29-monitoring-log-compat-v30';",
    "const RUNTIME_BUILD = '2026-07-29-monitoring-review-hardening-v31';",
    "monitoring review hardening runtime marker",
)

require(
    "src/components/MonitoringNotificationRules.tsx",
    "useRef",
    "const activeSiteId = useRef(siteId);",
    "activeSiteId.current !== requestedSiteId",
    "settingsToSave",
)
require(
    "src/components/MonitoringReadonlyPanel.tsx",
    "const payloadSnapshot = payload;",
    "const draftSnapshot = draft;",
    "activeSiteId.current !== requestedSiteId",
    "review enabled sites and recipients before promoting this version",
)
require(
    "worker/monitoring-notification-run.ts",
    "claimToken = await acquireEvaluationClaim(env.DB, siteId);",
    "state = await readMonitoringNotificationState(env.DB, siteId);",
    "serialized: true",
    "if (claimToken) {",
)
require(
    "worker/app-deploy.ts",
    "2026-07-29-monitoring-review-hardening-v31",
)
print("Monitoring review hardening source validation passed.")
