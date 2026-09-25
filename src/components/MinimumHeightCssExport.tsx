type Props = {
  cssText: string;
  loading?: boolean;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
};

export default function MinimumHeightCssExport({ cssText, loading = false, copied, onCopy, onDownload }: Props) {
  return <article className="export-card">
    <div className="export-card-heading">
      <div><span className="panel-kicker">Layout stability</span><h3>Minimum-height CSS</h3></div>
      <div className="export-card-actions">
        <button disabled={loading || !cssText} onClick={onCopy} type="button">{copied ? '✓ Copied' : 'Copy'}</button>
        <button disabled={loading || !cssText} onClick={onDownload} type="button">Download</button>
      </div>
    </div>
    <p className="export-card-note">Grouped by viewport width and minimum height. Values follow the selected release.</p>
    <pre className="export-code compact">{loading ? 'Loading CSS artifact…' : cssText || 'CSS artifact is not available for this source.'}</pre>
  </article>;
}
