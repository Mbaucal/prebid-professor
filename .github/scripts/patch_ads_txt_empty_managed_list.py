from pathlib import Path

path = Path('src/components/AdsTxtPanel.tsx')
source = path.read_text()

start_marker = "        {requirements.length ? (\n"
end_marker = "\n      </article>\n    </section>"
start = source.index(start_marker)
end = source.index(end_marker, start)

replacement = r'''        <>
          <div className="ads-txt-list-toolbar">
            <input
              aria-label="Search saved and repeated live ads.txt entries"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search source, domain, seller ID, comment or complete line…"
              type="search"
              value={searchQuery}
            />
            {searchQuery ? <button className="button secondary" onClick={() => setSearchQuery('')} type="button">Clear</button> : null}
          </div>

          {searchQuery.trim() && liveSearchMatches.length ? (
            <div className="ads-txt-live-search-panel">
              <div className="ads-txt-live-search-heading">
                <div>
                  <span className="panel-kicker">Live publisher file</span>
                  <h4>{liveSearchMatches.length} matching live line{liveSearchMatches.length === 1 ? '' : 's'}</h4>
                </div>
                <a className="button secondary" href={check?.finalUrl || check?.url || adsTxtUrl} rel="noreferrer" target="_blank">Open live ads.txt</a>
              </div>
              <p>The orange cards are the current live file and remain read-only. Add any unsaved occurrence to Tessera's managed list; it will then appear below with its own Edit and Delete actions. Publishing the managed file back to the website still requires a CMS connection.</p>
              <div className="ads-txt-live-search-list">
                {liveSearchMatches.map((match) => {
                  const pendingKey = `${match.lineNumber}:${match.exactKey}`;
                  return (
                    <div key={`${match.lineNumber}-${match.line}`}>
                      <div>
                        <strong>Live line {match.lineNumber}</strong>
                        <span>{match.occurrences} occurrences for this canonical record</span>
                      </div>
                      <code>{match.line}</code>
                      <div className="ads-txt-live-search-actions">
                        <em>LIVE FILE · READ ONLY</em>
                        {match.saved ? (
                          <span className="ads-txt-live-search-managed">SAVED IN TESSERA</span>
                        ) : (
                          <button
                            className="button secondary"
                            disabled={saving || Boolean(addingLiveKey)}
                            onClick={() => void addLiveOccurrence(match)}
                            type="button"
                          >
                            {addingLiveKey === pendingKey ? 'Adding…' : 'Add to managed list'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="ads-txt-saved-search-heading">
            <strong>Saved requirements</strong>
            {searchQuery.trim() ? <span>{filteredRequirements.length} match{filteredRequirements.length === 1 ? '' : 'es'}</span> : null}
          </div>
          {filteredRequirements.length ? (
            <div className="ads-txt-requirement-list">
              {filteredRequirements.map((requirement) => {
                const status = statusForRequirement(check, requirement.id);
                return (
                  <div className={`ads-txt-requirement ${status}`} key={requirement.id}>
                    <div className="ads-txt-requirement-status" title={status === 'found' ? 'Found in live ads.txt' : status === 'missing' ? 'Missing from live ads.txt' : 'Not checked'}>
                      {status === 'found' ? '✓' : status === 'missing' ? '×' : '—'}
                    </div>
                    <div className="ads-txt-requirement-main">
                      <div><strong>{requirement.sourceLabel}</strong><span className={requirement.required ? 'required' : 'optional'}>{requirement.required ? 'required' : 'optional'}</span></div>
                      <code>{requirement.entry}</code>
                    </div>
                    <div className="ads-txt-requirement-actions">
                      <button className="button secondary" onClick={() => editRequirement(requirement)} type="button">Edit</button>
                      <button className="button danger subtle" disabled={saving} onClick={() => void deleteRequirement(requirement)} type="button">Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : requirements.length ? (
            <div className="ads-txt-empty"><strong>No matching requirements</strong><span>Try a source name, ad-system domain, seller ID, or part of the complete line.</span></div>
          ) : (
            <div className="ads-txt-empty"><strong>No saved requirements</strong><span>Search a repeated live line and add each occurrence, or add/import requirements above.</span></div>
          )}
        </>'''

path.write_text(source[:start] + replacement + source[end:])
