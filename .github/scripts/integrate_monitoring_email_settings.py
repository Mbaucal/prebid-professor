from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if new in source:
        return
    if old not in source:
        raise SystemExit(f'{label} anchor was not found in {path}.')
    file_path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(
    'worker/app-deploy.ts',
    "import { getMonitoringEmailPreviewData } from './monitoring-email-preview';\n",
    "import { getMonitoringEmailPreviewData } from './monitoring-email-preview';\nimport { getMonitoringEmailDraft, updateMonitoringEmailDraft } from './monitoring-email-settings';\n",
    'monitoring email settings import',
)

replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-21-monitoring-preview-v21';",
    "const RUNTIME_BUILD = '2026-07-21-monitoring-draft-storage-v22';",
    'runtime marker',
)

settings_route = """    const monitoringEmailSettingsMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-settings$/);
    if (monitoringEmailSettingsMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(monitoringEmailSettingsMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getMonitoringEmailDraft(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updateMonitoringEmailDraft(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

"""
replace_once(
    'worker/app-deploy.ts',
    "    const monitoringEmailDataMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-preview-data$/);\n",
    settings_route + "    const monitoringEmailDataMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-preview-data$/);\n",
    'monitoring email settings route',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """type RenderedPreview = {
  subject: string;
  body: string;
  bodyFormat: BodyFormat;
  attachmentName: string;
  attachmentContent: string;
  variables: Record<string, string>;
  warnings: string[];
};
""",
    """type RenderedPreview = {
  subject: string;
  body: string;
  bodyFormat: BodyFormat;
  attachmentName: string;
  attachmentContent: string;
  variables: Record<string, string>;
  warnings: string[];
};

type ServerDraftPayload = {
  ok: true;
  saved: boolean;
  settings: EmailDraft;
  updatedBy: string | null;
  updatedAt: string | null;
  storage: 'd1' | 'not-created';
};
""",
    'server draft type',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """async function requestEmailPreviewData(siteId: string): Promise<EmailPreviewData> {
  return requestJson<EmailPreviewData>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-preview-data?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
}
""",
    """async function requestEmailPreviewData(siteId: string): Promise<EmailPreviewData> {
  return requestJson<EmailPreviewData>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-preview-data?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
}

async function requestMonitoringEmailDraft(siteId: string): Promise<ServerDraftPayload> {
  return requestJson<ServerDraftPayload>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-settings?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
}

async function persistMonitoringEmailDraft(siteId: string, settings: EmailDraft): Promise<ServerDraftPayload> {
  return requestJson<ServerDraftPayload>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-settings`,
    {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ settings }),
    },
  );
}
""",
    'server draft request helpers',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """  const [previewing, setPreviewing] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null);
""",
    """  const [previewing, setPreviewing] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null);
  const [serverDraft, setServerDraft] = useState<ServerDraftPayload | null>(null);
  const [serverSaving, setServerSaving] = useState(false);
""",
    'server draft state',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """  useEffect(() => {
    setPayload(null);
    setPreview(null);
    setDraftMessage(null);
    setDraft(loadDraft(site.id));
    void load();
  }, [load, site.id]);
""",
    """  const loadServerDraft = useCallback(async () => {
    try {
      const savedDraft = await requestMonitoringEmailDraft(site.id);
      setServerDraft(savedDraft);
      setDraft(savedDraft.saved ? savedDraft.settings : loadDraft(site.id));
    } catch (requestError) {
      setServerDraft(null);
      setDraft(loadDraft(site.id));
      setError(requestError instanceof Error ? requestError.message : 'Saved email draft could not be loaded.');
    }
  }, [site.id]);

  useEffect(() => {
    setPayload(null);
    setPreview(null);
    setDraftMessage(null);
    setServerDraft(null);
    setDraft(loadDraft(site.id));
    void load();
    void loadServerDraft();
  }, [load, loadServerDraft, site.id]);
""",
    'server draft load',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """  function saveDraft(): void {
    window.localStorage.setItem(storageKey(site.id), JSON.stringify(draft));
    setDraftMessage('Draft saved in this browser for this site.');
  }

  function clearDraft(): void {
""",
    """  function saveDraft(): void {
    window.localStorage.setItem(storageKey(site.id), JSON.stringify(draft));
    setDraftMessage('Draft saved in this browser for this site.');
  }

  async function saveServerDraft(): Promise<void> {
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
  }

  function clearDraft(): void {
""",
    'server draft save action',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "    setDraftMessage('Browser draft cleared.');",
    "    setDraftMessage(serverDraft?.saved ? 'Browser form cleared. The saved Tessera draft remains until you save the empty form.' : 'Browser draft cleared.');",
    'clear draft message',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "      setDraftMessage('Preview generated. No email was sent and no server setting was saved.');",
    "      setDraftMessage('Preview generated. No email was sent and current form values were not saved automatically.');",
    'preview message',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "          <p>Monitoring remains server read-only. Email templates and attachments can now be prepared and previewed, but nothing is sent or saved to D1.</p>",
    "          <p>Runtime checks remain read-only. Email templates can be previewed and optionally saved per site in Tessera, but email sending is still disabled.</p>",
    'monitoring intro',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """                <span className="panel-kicker">Preview-only workflow</span>
                <h3>Ads.txt email template</h3>
              </div>
              <span className="monitor-readonly-pill warning">NO EMAIL SENDING</span>
            </div>
            <p className="monitor-email-intro">Write the exact subject and message you want. This stage stores an optional draft only in this browser and generates a safe preview plus a downloadable ads.txt attachment.</p>
""",
    """                <span className="panel-kicker">Per-site template workflow</span>
                <h3>Ads.txt email template</h3>
              </div>
              <div className="monitor-email-statuses">
                <span className={`monitor-readonly-pill ${serverDraft?.saved ? 'healthy' : 'warning'}`}>
                  {serverDraft?.saved ? 'SAVED TO TESSERA' : 'NOT SAVED TO TESSERA'}
                </span>
                <span className="monitor-readonly-pill warning">NO EMAIL SENDING</span>
              </div>
            </div>
            <p className="monitor-email-intro">Write the exact subject and message you want. You can keep a browser draft, save the template per site in Tessera, and generate a safe preview plus a downloadable ads.txt attachment.</p>
""",
    'email template heading',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """            <div className="monitor-email-actions">
              <button className="button secondary" onClick={saveDraft} type="button">Save browser draft</button>
              <button className="button secondary" onClick={clearDraft} type="button">Clear draft</button>
              <button className="button primary" disabled={previewing} onClick={() => void generatePreview()} type="button">{previewing ? 'Generating…' : 'Preview email + attachment'}</button>
            </div>
""",
    """            <div className="monitor-email-actions">
              <button className="button secondary" onClick={saveDraft} type="button">Save browser draft</button>
              <button className="button secondary" disabled={serverSaving} onClick={() => void saveServerDraft()} type="button">{serverSaving ? 'Saving…' : 'Save to Tessera'}</button>
              <button className="button secondary" onClick={clearDraft} type="button">Clear form</button>
              <button className="button primary" disabled={previewing} onClick={() => void generatePreview()} type="button">{previewing ? 'Generating…' : 'Preview email + attachment'}</button>
            </div>
""",
    'email action buttons',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    """          <div className="monitor-readonly-note">
            <strong>Safe staged rollout:</strong> the server remains read-only. Browser drafts use localStorage only; no email is sent, no D1 table is created and no release or R2 object is modified.
          </div>
""",
    """          <div className="monitor-readonly-note">
            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Saving creates or updates only an isolated per-site email-draft record; no email is sent, no Cron runs and no release or R2 object is modified.
          </div>
""",
    'safe rollout note',
)

replace_once(
    'src/monitoring-email-preview.css',
    ".monitor-email-actions {\n",
    ".monitor-email-statuses {\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  flex-wrap: wrap;\n  gap: 8px;\n}\n\n.monitor-email-actions {\n",
    'email status styling',
)
