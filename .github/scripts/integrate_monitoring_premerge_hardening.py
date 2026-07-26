from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if new in source:
        print(f'{label}: already applied')
        return
    if old not in source:
        raise SystemExit(f'{label} anchor was not found in {path}.')
    file_path.write_text(source.replace(old, new, 1), encoding='utf-8')
    print(f'{label}: applied')


def replace_segment(path: str, start: str, end: str, replacement: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if replacement in source:
        print(f'{label}: already applied')
        return
    start_index = source.find(start)
    if start_index < 0:
        raise SystemExit(f'{label} start anchor was not found in {path}.')
    end_index = source.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f'{label} end anchor was not found in {path}.')
    file_path.write_text(source[:start_index] + replacement + source[end_index:], encoding='utf-8')
    print(f'{label}: applied')


def replace_suffix(path: str, start: str, replacement: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if replacement in source:
        print(f'{label}: already applied')
        return
    start_index = source.find(start)
    if start_index < 0:
        raise SystemExit(f'{label} start anchor was not found in {path}.')
    file_path.write_text(source[:start_index] + replacement, encoding='utf-8')
    print(f'{label}: applied')


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding='utf-8')
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f'Integration validation failed in {path}: {missing}')


# The attachment must be a clean final ads.txt file, without a Tessera-specific marker.
for target in ('worker/monitoring-notification-run.ts', 'src/components/MonitoringReadonlyPanel.tsx'):
    replace_once(
        target,
        "return `${live ? `${live}\\n\\n` : ''}# Tessera additions\\n${additions}\\n`;",
        "return `${live ? `${live}\\n\\n` : ''}${additions}\\n`;",
        f'remove Tessera additions marker from {target}',
    )

replace_once(
    'worker/monitoring-notification-run.ts',
    'export interface MonitoringNotificationRunEnv extends GmailOAuthEnv {}',
    'export interface MonitoringNotificationRunEnv extends GmailOAuthEnv {\n  BUILDS?: R2Bucket;\n}',
    'notification R2 environment',
)

new_decide = '''function decide(
  status: string,
  currentFingerprint: string | null,
  state: MonitoringNotificationState,
  settings: Awaited<ReturnType<typeof readMonitoringNotificationSettings>>,
  now: number,
): Decision {
  if (!settings.enabled) return { kind: 'none', reason: 'Notifications are disabled for this site.' };
  if (status === 'missing') {
    if (!settings.notifyOnMissing) return { kind: 'none', reason: 'Missing-entry notifications are disabled.' };
    if (!state.lastNotifiedAt || !state.lastNotifiedFingerprint) {
      return { kind: 'missing', reason: 'Missing entries were detected and no previous notification was sent.' };
    }

    const sameFingerprint = currentFingerprint === state.lastNotifiedFingerprint;
    if (!sameFingerprint) {
      return settings.notifyOnChange
        ? { kind: 'missing', reason: 'The missing-entry list changed since the last notification.' }
        : { kind: 'none', reason: 'The missing-entry list changed, but changed-list notifications are disabled.' };
    }

    const elapsed = hoursSince(state.lastNotifiedAt, now);
    if (settings.reminderEnabled && elapsed !== null && elapsed >= settings.reminderHours) {
      return { kind: 'reminder', reason: `The same issue has remained unresolved for ${Math.floor(elapsed)} hour(s).` };
    }
    return { kind: 'none', reason: 'The missing-entry list is unchanged and the reminder interval has not elapsed.' };
  }
  if (status === 'ok') {
    if (settings.recoveryEnabled && state.lastNotifiedFingerprint && state.lastNotifiedAt) {
      return { kind: 'recovery', reason: 'The site recovered after a previously notified missing-entry state.' };
    }
    return { kind: 'none', reason: 'Ads.txt is healthy and no recovery notification is pending.' };
  }
  return { kind: 'none', reason: `No automatic email is sent for ads.txt status "${status}".` };
}

'''
replace_segment(
    'worker/monitoring-notification-run.ts',
    'function decide(',
    'function messageFor(',
    new_decide,
    'notification decision rules',
)

new_helpers_and_message = '''async function readManifestVersion(
  env: MonitoringNotificationRunEnv,
  siteId: string,
): Promise<string> {
  if (!env.BUILDS) return '';
  const object = await env.BUILDS.get(`publishers/${siteId}/current/manifest.json`);
  if (!object) return '';
  try {
    const parsed = JSON.parse(await object.text()) as unknown;
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    return '';
  }
}

const EVALUATION_CLAIM_TTL_MS = 5 * 60 * 1000;

async function ensureEvaluationClaimTable(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS monitoring_notification_claims (
    site_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
  )`).run();
}

async function acquireEvaluationClaim(db: D1Database, siteId: string): Promise<string | null> {
  await ensureEvaluationClaimTable(db);
  const token = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + EVALUATION_CLAIM_TTL_MS).toISOString();
  await db.prepare(`INSERT INTO monitoring_notification_claims (
      site_id, token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET
      token = excluded.token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE monitoring_notification_claims.expires_at <= excluded.created_at`)
    .bind(siteId, token, expiresAt, nowIso, nowIso)
    .run();
  const row = await db.prepare(
    'SELECT token FROM monitoring_notification_claims WHERE site_id = ? LIMIT 1',
  ).bind(siteId).first<{ token: string }>();
  return row?.token === token ? token : null;
}

async function releaseEvaluationClaim(db: D1Database, siteId: string, token: string): Promise<void> {
  await db.prepare(
    'DELETE FROM monitoring_notification_claims WHERE site_id = ? AND token = ?',
  ).bind(siteId, token).run();
}

function closeHealthyIncident(
  status: string,
  decision: Decision,
  state: MonitoringNotificationState,
): MonitoringNotificationState {
  if (status !== 'ok' || decision.kind !== 'none' || !state.lastNotifiedFingerprint) return state;
  return {
    ...state,
    lastNotifiedFingerprint: null,
    lastNotifiedAt: null,
  };
}

function messageFor(
  draft: MonitoringEmailDraft,
  preview: PreviewData,
  site: SiteRow,
  check: AdsTxtCheck,
  kind: Exclude<Decision['kind'], 'none'>,
  missingEntries: AdsTxtEntry[],
  manifestVersion: string,
): GmailMessageInput {
  const missingText = groupedEntries(missingEntries) || 'None';
  const statusLabel = kind === 'recovery'
    ? 'OK'
    : `${check.requiredMissingCount ?? missingEntries.length} MISSING`;
  const baseVariables: Record<string, string> = {
    publisher_name: preview.site.publisherName || '',
    site_name: preview.site.name,
    domain: preview.site.domain,
    ads_txt_url: preview.live.finalUrl || preview.site.adsTxtUrl,
    status: statusLabel,
    checked_at: new Date(check.fetchedAt || preview.fetchedAt).toLocaleString('en'),
    missing_count: String(check.requiredMissingCount ?? missingEntries.length),
    missing_entries: missingText,
    current_version: site.current_version && site.current_version !== 'draft' ? site.current_version : '',
    manifest_version: manifestVersion,
    sender_name: draft.senderName,
    notification_kind: kind,
    attachment_name: '',
  };
  const attachmentName = safeFileName(renderTemplate(draft.attachmentNameTemplate, baseVariables));
  const variables = { ...baseVariables, attachment_name: attachmentName };
  const expectedEntries = preview.expected;
  let attachmentContent = '';
  if (draft.attachmentMode === 'missing-only') {
    attachmentContent = groupedEntries(missingEntries);
  } else if (draft.attachmentMode === 'expected-only') {
    attachmentContent = groupedEntries(expectedEntries);
  } else if (preview.live.error) {
    attachmentContent = groupedEntries(expectedEntries);
  } else {
    attachmentContent = correctedAdsTxt(preview.live.content, missingEntries);
  }
  if (attachmentContent && !attachmentContent.endsWith('\\n')) attachmentContent += '\\n';
  return {
    senderName: draft.senderName,
    to: draft.to,
    cc: draft.cc,
    replyTo: draft.replyTo,
    subject: renderTemplate(draft.subjectTemplate, variables),
    body: renderTemplate(draft.bodyTemplate, variables),
    bodyFormat: draft.bodyFormat,
    attachmentName,
    attachmentContent,
  };
}

'''
replace_segment(
    'worker/monitoring-notification-run.ts',
    'function messageFor(',
    'export async function runMonitoringNotification(',
    new_helpers_and_message,
    'notification rendering and claim helpers',
)

new_run = '''export async function runMonitoringNotification(
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
    const [settings, check] = await Promise.all([
      readMonitoringNotificationSettings(env.DB, siteId),
      readCheck(env, siteId),
    ]);
    const status = String(check.status ?? 'fetch-error');
    const missingEntries = uniqueEntries(check.missing ?? []);
    const currentFingerprint = await fingerprint(missingEntries);
    let decision = decide(status, currentFingerprint, state, settings, Date.now());
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
        kind: 'check',
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

    claimToken = await acquireEvaluationClaim(env.DB, siteId);
    if (!claimToken) {
      const reason = 'Another notification evaluation is already in progress for this site.';
      await appendMonitoringNotificationLog(env.DB, siteId, {
        kind: 'check',
        status: 'skipped',
        provider: 'gmail',
        messageId: null,
        recipients: [],
        subject: null,
        attachmentName: null,
        errorMessage: null,
        details: { actor, reason, adsTxtStatus: status, missingCount: missingEntries.length },
      });
      return json({
        ok: true,
        sent: false,
        decision: 'none',
        reason,
        checkedAt,
        adsTxtStatus: status,
        missingCount: missingEntries.length,
        state,
      });
    }

    // A previous request may have sent while this request waited for the claim.
    // Re-read state and decide again after ownership is established.
    state = await readMonitoringNotificationState(env.DB, siteId);
    decision = decide(status, currentFingerprint, state, settings, Date.now());
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
        kind: 'check',
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
          reevaluatedAfterClaim: true,
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
      readPreviewData(env, siteId),
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
    state = {
      ...state,
      lastCheckedAt: checkedAt,
      lastError: errorMessage,
      updatedAt: checkedAt,
    };
    await writeMonitoringNotificationState(env.DB, siteId, state).catch(() => undefined);
    await appendMonitoringNotificationLog(env.DB, siteId, {
      kind: 'check',
      status: 'failed',
      provider: 'gmail',
      messageId: null,
      recipients: [],
      subject: null,
      attachmentName: null,
      errorMessage,
      details: { actor },
    }).catch(() => undefined);
    return apiError('Monitoring notification evaluation failed.', 502, errorMessage);
  } finally {
    if (claimToken) {
      await releaseEvaluationClaim(env.DB, siteId, claimToken).catch(() => undefined);
    }
  }
}
'''
replace_suffix(
    'worker/monitoring-notification-run.ts',
    'export async function runMonitoringNotification(',
    new_run,
    'serialized notification evaluator',
)

replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-26-monitoring-schema-upgrade-v27';",
    "const RUNTIME_BUILD = '2026-07-26-monitoring-premerge-v28';",
    'monitoring pre-merge marker',
)

migration = Path('migrations/0004_gmail_and_monitoring_notifications.sql')
migration_source = migration.read_text(encoding='utf-8')
claim_table = '''

CREATE TABLE IF NOT EXISTS monitoring_notification_claims (
  site_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);
'''
if 'CREATE TABLE IF NOT EXISTS monitoring_notification_claims' not in migration_source:
    migration.write_text(migration_source.rstrip() + claim_table, encoding='utf-8')
    print('notification claim migration: applied')
else:
    print('notification claim migration: already applied')

require(
    'worker/monitoring-notification-run.ts',
    'currentFingerprint === state.lastNotifiedFingerprint',
    'changed-list notifications are disabled',
    'closeHealthyIncident',
    'monitoring_notification_claims',
    'Another notification evaluation is already in progress',
    'readManifestVersion',
    'manifest_version: manifestVersion',
    'const expectedEntries = preview.expected;',
)
require(
    'src/components/MonitoringReadonlyPanel.tsx',
    "return `${live ? `${live}\\n\\n` : ''}${additions}\\n`;",
)
if '# Tessera additions' in Path('worker/monitoring-notification-run.ts').read_text(encoding='utf-8'):
    raise SystemExit('Tessera additions marker remains in notification delivery code.')
if '# Tessera additions' in Path('src/components/MonitoringReadonlyPanel.tsx').read_text(encoding='utf-8'):
    raise SystemExit('Tessera additions marker remains in browser preview code.')
require('worker/app-deploy.ts', '2026-07-26-monitoring-premerge-v28')
print('Monitoring pre-merge hardening integration passed.')
