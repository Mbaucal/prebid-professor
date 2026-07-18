type JsonRecord = Record<string, unknown>;

export type GeneratorEngine = 'legacy-frozen-v1' | 'legacy-advanced-refresh-v1';

export type RuntimeCompileInput = {
  template: string;
  engine: GeneratorEngine;
  buildVersion: string;
  siteId: string;
  generatorProfileId: string;
  gamPath: string;
  bidders: JsonRecord[];
  bidderSlotParams: JsonRecord;
  bidderDeviceParams: JsonRecord;
  bidderAdUnitParams: JsonRecord;
  adUnitRules: JsonRecord;
  explicitUnits: JsonRecord[];
  sizeMapsRaw: JsonRecord;
  prebidSizeConfigsRaw: JsonRecord;
  userSync: JsonRecord;
  defaultTimeout: number;
  atfTimeout: number;
  btfTimeout: number;
  stickyTimeout: number;
  globalRefresh: JsonRecord;
  maxCmpTimeout: number;
};

export type RuntimeCompileResult = {
  adsJs: string;
  adsMinJs: string;
  patches: string[];
  warnings: string[];
  minifier: 'safe-whitespace-v1';
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function replaceVarAssignment(
  source: string,
  name: string,
  value: unknown,
  patches: string[],
  required = true,
): string {
  const pattern = new RegExp(
    `^(\\s*var\\s+${escapeRegExp(name)}\\s*=\\s*).*?(;\\s*(?://[^\\r\\n]*)?[\\t ]*)$`,
    'm',
  );
  if (!pattern.test(source)) {
    if (required) throw new Error(`Runtime template does not contain variable ${name}.`);
    return source;
  }
  patches.push(name);
  return source.replace(pattern, (_match, prefix: string, suffix: string) => {
    return `${prefix}${jsonLiteral(value)}${suffix}`;
  });
}

function replaceWindowAssignment(
  source: string,
  name: string,
  value: unknown,
  patches: string[],
): string {
  const pattern = new RegExp(
    `^(\\s*window\\.${escapeRegExp(name)}\\s*=\\s*).*?(;[\\t ]*)$`,
    'm',
  );
  if (!pattern.test(source)) throw new Error(`Runtime template does not contain window.${name}.`);
  patches.push(`window.${name}`);
  return source.replace(pattern, (_match, prefix: string, suffix: string) => {
    return `${prefix}${jsonLiteral(value)}${suffix}`;
  });
}

function replaceSection(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
  label: string,
  patches: string[],
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Runtime template section ${label} start marker was not found.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Runtime template section ${label} end marker was not found.`);
  patches.push(label);
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`;
}

function patchMetadata(source: string, input: RuntimeCompileInput, patches: string[]): string {
  const pattern = /(window\.ADS_BUILD_TS\s*=\s*[^;]+;)/;
  if (!pattern.test(source)) throw new Error('Runtime build timestamp marker was not found.');
  patches.push('runtime metadata');
  return source.replace(
    pattern,
    `$1\n      window.ADOPS_SITE_ID = ${jsonLiteral(input.siteId)};\n      window.ADOPS_RELEASE = ${jsonLiteral(input.buildVersion)};\n      window.ADOPS_GENERATOR_PROFILE = ${jsonLiteral(input.generatorProfileId)};`,
  );
}

function patchUserSync(
  source: string,
  userSync: JsonRecord,
  patches: string[],
): string {
  const startMarker = '        userSync: {';
  const endMarker = '          enableTIDs:';
  return replaceSection(
    source,
    startMarker,
    endMarker,
    `        userSync: ${jsonLiteral(userSync)},`,
    'Prebid userSync',
    patches,
  );
}

function advancedRefreshFunction(): string {
  return `function getAdUnitRefreshRule(code){
  var rule = getAdUnitRuntimeRule(code) || {};
  var refresh = rule.refresh || {};
  var schedule = refresh.schedule || {};
  var fallbackMinSeconds = 30;

  try {
    fallbackMinSeconds = isMobile()
      ? (MOBILE_MIN_SECONDS_BETWEEN_REFRESHES || MIN_SECONDS_BETWEEN_REFRESHES || DWELL_MIN_VIEW_SEC || 30)
      : (MIN_SECONDS_BETWEEN_REFRESHES || DWELL_MIN_VIEW_SEC || 30);
  } catch(_) {
    fallbackMinSeconds = DWELL_MIN_VIEW_SEC || 30;
  }

  var completed = (_refreshCounts && _refreshCounts[code]) || 0;
  var mode = String(schedule.mode || 'fixed');
  var minSeconds = Number(refresh.minSeconds || fallbackMinSeconds);

  if (mode === 'firstThenFixed') {
    minSeconds = completed > 0
      ? Number(schedule.nextSeconds || minSeconds)
      : Number(schedule.firstSeconds || minSeconds);
  } else if (mode === 'percentage') {
    var firstSeconds = Number(schedule.firstSeconds || minSeconds);
    var growth = Number(schedule.growthPercent || 0) / 100;
    var maxSeconds = Number(schedule.maxSeconds || REFRESH_MAX_INTERVAL_SEC || 7200);
    minSeconds = Math.min(maxSeconds, Math.round(firstSeconds * Math.pow(1 + growth, completed)));
  } else if (mode === 'sequence') {
    var sequence = Array.isArray(schedule.sequenceSeconds) ? schedule.sequenceSeconds : [];
    if (sequence.length) {
      minSeconds = Number(sequence[Math.min(completed, sequence.length - 1)] || minSeconds);
    }
  } else if (schedule.fixedSeconds) {
    minSeconds = Number(schedule.fixedSeconds || minSeconds);
  }

  if (!minSeconds || minSeconds < 1) minSeconds = fallbackMinSeconds;

  return {
    enabled: refresh.enabled !== false,
    minSeconds: minSeconds,
    minViewPct: Number(refresh.minViewPct == null ? 0 : refresh.minViewPct),
    exitViewPct: Number(refresh.exitViewPct == null ? REFRESH_EXIT_PCT : refresh.exitViewPct),
    accumulateViewTime: refresh.accumulateViewTime !== false,
    minGapSeconds: Number(refresh.minGapSeconds || 0),
    maxRefreshes: Number(refresh.maxRefreshes == null ? MAX_REFRESHES_PER_SLOT : refresh.maxRefreshes),
    requirePreviousViewable: !!refresh.requirePreviousViewable,
    checkEveryMs: Number(refresh.checkEveryMs || 5000),
    schedule: schedule
  };
}`;
}

function patchAdvancedRuntime(
  source: string,
  input: RuntimeCompileInput,
  patches: string[],
  warnings: string[],
): string {
  source = replaceSection(
    source,
    'function getAdUnitRefreshRule(code){',
    'function getSlotViewPct(id){',
    advancedRefreshFunction(),
    'advanced refresh scheduler',
    patches,
  );

  const entryPattern = /function getEntryPct\(\)\{ return isMobile\(\) \? entryPctM : entryPctD; \}/;
  if (!entryPattern.test(source)) {
    throw new Error('Advanced runtime could not find the dwell entry helper in the template.');
  }
  source = source.replace(
    entryPattern,
    `function getEntryPct(id){
    var rr = getAdUnitRefreshRule(id);
    return (rr && rr.minViewPct > 0) ? rr.minViewPct : (isMobile() ? entryPctM : entryPctD);
  }
  function getExitPct(id){
    var rr = getAdUnitRefreshRule(id);
    return (rr && rr.exitViewPct >= 0) ? rr.exitViewPct : exitPct;
  }
  function getAccumulate(id){
    var rr = getAdUnitRefreshRule(id);
    return rr ? rr.accumulateViewTime !== false : DWELL_ACCUMULATE;
  }`,
  );
  patches.push('per-slot dwell thresholds');

  source = source.replace(/pct >= getEntryPct\(\)/g, 'pct >= getEntryPct(id)');
  source = source.replace(/pct <= exitPct/g, 'pct <= getExitPct(id)');
  source = source.replace(/if \(DWELL_ACCUMULATE\)\{/g, 'if (getAccumulate(id)){');
  source = source.replace(/clearDwell\(id, DWELL_ACCUMULATE\);/g, 'clearDwell(id, getAccumulate(id));');

  const maxRefreshPattern = /var currentCount = _refreshCounts\[id\] \|\| 0;\s*if \(currentCount >= \(MAX_REFRESHES_PER_SLOT\|\|0\)\) return;/;
  if (!maxRefreshPattern.test(source)) {
    throw new Error('Advanced runtime could not find the maximum-refresh guard in the template.');
  }
  source = source.replace(
    maxRefreshPattern,
    `var currentCount = _refreshCounts[id] || 0;
  var countRule = getAdUnitRefreshRule(id);
  var maxAllowedRefreshes = Number(countRule.maxRefreshes == null ? MAX_REFRESHES_PER_SLOT : countRule.maxRefreshes);
  if (maxAllowedRefreshes >= 0 && currentCount >= maxAllowedRefreshes) return;`,
  );
  patches.push('per-slot maximum refresh guard');

  if (!source.includes('function resolveConsent(cb){')) {
    throw new Error('Advanced runtime could not find the wrapper consent resolver.');
  }
  source = source.replace('function resolveConsent(cb){', 'function resolveConsent(cb, timeoutMs){');

  const consentTimerPattern = /}, Math\.min\(8000, 1500\)\);/;
  if (!consentTimerPattern.test(source)) {
    throw new Error('Advanced runtime could not find the wrapper consent timer.');
  }
  source = source.replace(
    consentTimerPattern,
    '}, Math.max(100, Math.min(Number(timeoutMs || window.__PP_CONSENT_TIMEOUT || 1500), 30000)));',
  );

  const consentHelper = `function getConsentTimeoutForSlots(slots){
    var maxTimeout = 0;
    try {
      for (var i = 0; i < (slots || []).length; i++){
        var slot = slots[i];
        var id = slot && slot.getSlotElementId && slot.getSlotElementId();
        if (!id) continue;
        var rule = getAdUnitRuntimeRule(id) || {};
        var candidate = Number(rule.cmpTimeout || 0);
        if (candidate > maxTimeout) maxTimeout = candidate;
      }
    } catch(_){}
    return maxTimeout || ${Math.max(100, input.maxCmpTimeout || 1500)};
  }

  `;
  if (!source.includes('  /* ====== PPID iz ID5 ====== */')) {
    throw new Error('Advanced runtime could not find the consent helper insertion point.');
  }
  source = source.replace('  /* ====== PPID iz ID5 ====== */', `${consentHelper}/* ====== PPID iz ID5 ====== */`);

  const retryConsentPattern = /^ {14}resolveConsent\(function\(res\)\{/m;
  const initialConsentPattern = /^ {6}resolveConsent\(function\(res\)\{/m;
  if (!retryConsentPattern.test(source) || !initialConsentPattern.test(source)) {
    throw new Error('Advanced runtime could not find both initial consent call sites.');
  }
  source = source.replace(
    retryConsentPattern,
    '              window.__PP_CONSENT_TIMEOUT = getConsentTimeoutForSlots(retry);\n              resolveConsent(function(res){',
  );
  source = source.replace(
    initialConsentPattern,
    '      window.__PP_CONSENT_TIMEOUT = getConsentTimeoutForSlots(atfSlots);\n      resolveConsent(function(res){',
  );
  patches.push('per-auction CMP wait');

  const consentConfigStart = source.indexOf('var gdprConsentConfig =');
  const consentConfigEnd = consentConfigStart >= 0 ? source.indexOf('      try{', consentConfigStart) : -1;
  if (consentConfigStart >= 0 && consentConfigEnd > consentConfigStart) {
    const before = source.slice(0, consentConfigStart);
    const block = source
      .slice(consentConfigStart, consentConfigEnd)
      .replace(/(timeout:\s*)\d+(\s*,)/, `$1${Math.max(100, input.maxCmpTimeout)}$2`)
      .replace(/(actionTimeout:\s*)\d+(\s*,)/, `$1${Math.max(100, input.maxCmpTimeout)}$2`);
    source = `${before}${block}${source.slice(consentConfigEnd)}`;
    patches.push('Prebid consent timeout');
  } else {
    warnings.push('Prebid consent-management timeout block was not patched; wrapper consent timing is still patched.');
  }

  return source;
}

function patchGlobalRefresh(
  source: string,
  refresh: JsonRecord,
  patches: string[],
): string {
  const schedule = refresh.schedule && typeof refresh.schedule === 'object' && !Array.isArray(refresh.schedule)
    ? (refresh.schedule as JsonRecord)
    : {};
  const fixedOrFirst = Number(
    schedule.mode === 'fixed'
      ? schedule.fixedSeconds
      : schedule.mode === 'sequence' && Array.isArray(schedule.sequenceSeconds)
        ? schedule.sequenceSeconds[0]
        : schedule.firstSeconds,
  );
  const dwellSeconds = Number.isFinite(fixedOrFirst) && fixedOrFirst > 0
    ? fixedOrFirst
    : Number(refresh.minSeconds || 30);

  source = replaceVarAssignment(source, 'REFRESH_ENABLED', refresh.enabled !== false, patches, false);
  source = replaceVarAssignment(source, 'DWELL_MIN_VIEW_SEC', dwellSeconds || 30, patches, false);
  source = replaceVarAssignment(source, 'REFRESH_IN_VIEW_PCT', Number(refresh.minViewPct ?? 50), patches, false);
  source = replaceVarAssignment(source, 'REFRESH_MOBILE_IN_VIEW_PCT', Number(refresh.minViewPct ?? 50), patches, false);
  source = replaceVarAssignment(source, 'REFRESH_EXIT_PCT', Number(refresh.exitViewPct ?? 10), patches, false);
  source = replaceVarAssignment(source, 'MAX_REFRESHES_PER_SLOT', Number(refresh.maxRefreshes ?? 20), patches, false);
  source = replaceVarAssignment(source, 'MIN_SECONDS_BETWEEN_REFRESHES', Number(refresh.minGapSeconds ?? 0), patches, false);
  source = replaceVarAssignment(source, 'MOBILE_MIN_SECONDS_BETWEEN_REFRESHES', Number(refresh.minGapSeconds ?? 0), patches, false);
  source = replaceVarAssignment(source, 'DWELL_ACCUMULATE', refresh.accumulateViewTime !== false, patches, false);
  source = replaceVarAssignment(
    source,
    'REFRESH_BACKOFF_FACTOR',
    schedule.mode === 'percentage' ? Number(schedule.growthPercent ?? 0) / 100 : 0,
    patches,
    false,
  );
  source = replaceVarAssignment(source, 'REFRESH_MAX_INTERVAL_SEC', Number(schedule.maxSeconds ?? 120), patches, false);
  return source;
}

function ensureRuntimeBuildMarker(source: string): string {
  // Release metadata must never depend on how an older frozen template
  // spelled or omitted its build marker. This runs on the in-memory
  // template only; the immutable R2 object and its hash stay unchanged.
  if (/^\s*window\.ADS_BUILD_TS\s*=.*;\s*$/m.test(source)) return source;
  return `window.ADS_BUILD_TS = "__PP_TEMPLATE_BUILD__";\n${source}`;
}

function compactSafely(source: string): string {
  const output: string[] = [];
  let previousBlank = false;
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/[\t ]+$/g, '');
    const blank = line.trim() === '';
    if (blank && previousBlank) continue;
    output.push(line);
    previousBlank = blank;
  }
  return output.join('\n').trim() + '\n';
}

export function compileRuntime(input: RuntimeCompileInput): RuntimeCompileResult {
  const patches: string[] = [];
  const warnings: string[] = [];
  let source = ensureRuntimeBuildMarker(input.template.replace(/^\uFEFF/, ''));

  source = replaceWindowAssignment(source, 'ADS_BUILD_TS', input.buildVersion, patches);
  source = patchMetadata(source, input, patches);
  source = replaceVarAssignment(source, 'adUnitPath', input.gamPath, patches);
  source = replaceVarAssignment(source, 'BIDDERS', input.bidders, patches);
  source = replaceVarAssignment(source, 'BIDDER_SLOT_PARAMS', input.bidderSlotParams, patches);
  source = replaceVarAssignment(source, 'BIDDER_DEVICE_PARAMS', input.bidderDeviceParams, patches);
  source = replaceVarAssignment(source, 'BIDDER_ADUNIT_PARAMS', input.bidderAdUnitParams, patches);
  source = replaceVarAssignment(source, 'AD_UNIT_RULES', input.adUnitRules, patches);
  source = replaceVarAssignment(source, 'EXPLICIT_UNITS', input.explicitUnits, patches);
  source = replaceVarAssignment(source, 'SIZE_MAPS_RAW', input.sizeMapsRaw, patches);
  source = replaceVarAssignment(source, 'PREBID_SIZE_CONFIGS_RAW', input.prebidSizeConfigsRaw, patches);
  source = replaceVarAssignment(source, 'userIds', input.userSync.userIds ?? [], patches);
  source = patchUserSync(source, input.userSync, patches);

  source = replaceVarAssignment(source, 'PREBID_TIMEOUT', input.defaultTimeout, patches, false);
  source = replaceVarAssignment(source, 'PREBID_TIMEOUT_ATF', input.atfTimeout, patches, false);
  source = replaceVarAssignment(source, 'PREBID_TIMEOUT_BTF', input.btfTimeout, patches, false);
  source = replaceVarAssignment(source, 'PREBID_TIMEOUT_STICKY', input.stickyTimeout, patches, false);
  source = patchGlobalRefresh(source, input.globalRefresh, patches);

  const id5Module = Array.isArray(input.userSync.userIds)
    ? input.userSync.userIds.find((value) => {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (value as JsonRecord).name === 'id5Id';
      })
    : null;
  if (id5Module && typeof id5Module === 'object' && !Array.isArray(id5Module)) {
    const params = (id5Module as JsonRecord).params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const partner = Number((params as JsonRecord).partner);
      if (Number.isInteger(partner) && partner > 0) {
        source = replaceVarAssignment(source, 'ID5_PARTNER_ID', partner, patches, false);
      }
    }
  }

  if (input.engine === 'legacy-advanced-refresh-v1') {
    source = patchAdvancedRuntime(source, input, patches, warnings);
  } else if (Object.keys(input.adUnitRules).some((key) => {
    const rule = input.adUnitRules[key];
    return Boolean(rule) && typeof rule === 'object' && !Array.isArray(rule) && Boolean((rule as JsonRecord).cmpTimeout || (rule as JsonRecord).refresh);
  })) {
    warnings.push('Frozen runtime applies basic timeout and refresh values only; advanced schedule fields remain inactive.');
  }

  return {
    adsJs: source,
    adsMinJs: compactSafely(source),
    patches: Array.from(new Set(patches)),
    warnings: Array.from(new Set(warnings)),
    minifier: 'safe-whitespace-v1',
  };
}
