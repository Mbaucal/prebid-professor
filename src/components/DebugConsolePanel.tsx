import { experimentInspectCommand } from '../debug/experiment-inspect.mjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AdUnit, Bidder } from '../shared/types';

type Props = {
  publisherId: string;
  siteName: string;
  domain: string;
};

type DebugCategory = 'Overview' | 'GAM' | 'Prebid' | 'Privacy' | 'Runtime';

type DebugScope = {
  siteId: string;
  siteName: string;
  domain: string;
  adUnit: string;
  bidder: string;
};

type DebugCommand = {
  id: string;
  category: DebugCategory;
  title: string;
  description: string;
  code: string;
};

const ALL = '__all__';
const CUSTOM = '__custom__';
const CATEGORY_ORDER: DebugCategory[] = ['Overview', 'GAM', 'Prebid', 'Privacy', 'Runtime'];

function js(value: string): string {
  return JSON.stringify(value);
}

function scopePrelude(scope: DebugScope): string {
  return `  var selectedAdUnit = ${js(scope.adUnit)};
  var selectedBidder = ${js(scope.bidder)};
  var configuredSiteId = ${js(scope.siteId)};
  var configuredSiteName = ${js(scope.siteName)};
  var configuredDomain = ${js(scope.domain)};

  function bidderName(value) {
    if (!value) return '';
    return String(value.bidderCode || value.bidder || (value.bidderRequest && value.bidderRequest.bidderCode) || '');
  }

  function unitName(value) {
    if (!value) return '';
    return String(value.adUnitCode || value.code || value.slot || value.slotId || '');
  }

  function matchesBidder(value) {
    return !selectedBidder || bidderName(value) === selectedBidder;
  }

  function matchesUnit(value) {
    return !selectedAdUnit || unitName(value) === selectedAdUnit;
  }

  function targetingMap(slot) {
    try {
      if (slot && typeof slot.getTargetingMap === 'function') return slot.getTargetingMap();
      var output = {};
      var keys = slot && typeof slot.getTargetingKeys === 'function' ? slot.getTargetingKeys() : [];
      keys.forEach(function (key) { output[key] = slot.getTargeting(key); });
      return output;
    } catch (_) {
      return {};
    }
  }
`;
}

function wrapCommand(title: string, scope: DebugScope, body: string): string {
  return `/* Prebid Professor Debug Console — ${title} */
(function () {
  'use strict';
${scopePrelude(scope)}
${body.trim()}
})();
`;
}

function fullDiagnosticCommand(scope: DebugScope): string {
  return wrapCommand('Full diagnostic bundle', scope, `
  var report = {
    generatedAt: new Date().toISOString(),
    requestedScope: {
      siteId: configuredSiteId,
      siteName: configuredSiteName,
      domain: configuredDomain,
      adUnit: selectedAdUnit || 'all',
      bidder: selectedBidder || 'all'
    },
    page: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState
    },
    runtime: {
      siteId: window.ADOPS_SITE_ID || null,
      release: window.ADOPS_RELEASE || window.ADS_BUILD_TS || null,
      generatorProfile: window.ADOPS_GENERATOR_PROFILE || window.ADOPS_GENERATOR_PROFILE_ID || null,
      consentTimeout: window.__PP_CONSENT_TIMEOUT || null
    },
    libraries: {
      prebid: Boolean(window.pbjs),
      prebidVersion: window.pbjs && (window.pbjs.version || window.pbjs.libLoaded) || null,
      gpt: Boolean(window.googletag),
      tcfApi: typeof window.__tcfapi === 'function',
      gppApi: typeof window.__gpp === 'function',
      uspApi: typeof window.__uspapi === 'function'
    },
    prebid: null,
    gamSlots: [],
    domSlots: []
  };

  try {
    var pbjs = window.pbjs;
    if (pbjs) {
      var responses = typeof pbjs.getBidResponses === 'function' ? pbjs.getBidResponses() : {};
      var bids = [];
      Object.keys(responses || {}).forEach(function (code) {
        ((responses[code] && responses[code].bids) || []).forEach(function (bid) {
          var normalized = Object.assign({ adUnitCode: code }, bid);
          if (matchesUnit(normalized) && matchesBidder(normalized)) bids.push(normalized);
        });
      });
      report.prebid = {
        config: typeof pbjs.getConfig === 'function' ? pbjs.getConfig() : null,
        bids: bids,
        winningBids: typeof pbjs.getAllWinningBids === 'function'
          ? pbjs.getAllWinningBids().filter(function (bid) { return matchesUnit(bid) && matchesBidder(bid); })
          : [],
        highestCpmBids: typeof pbjs.getHighestCpmBids === 'function'
          ? pbjs.getHighestCpmBids(selectedAdUnit || undefined).filter(matchesBidder)
          : [],
        events: typeof pbjs.getEvents === 'function' ? pbjs.getEvents() : [],
        userIds: typeof pbjs.getUserIds === 'function' ? pbjs.getUserIds() : null,
        eids: typeof pbjs.getUserIdsAsEids === 'function' ? pbjs.getUserIdsAsEids() : null
      };
    }
  } catch (error) {
    report.prebid = { error: String(error) };
  }

  function visiblePercent(element) {
    if (!element) return 0;
    var rect = element.getBoundingClientRect();
    var visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    var visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    var area = Math.max(1, rect.width * rect.height);
    return Math.round((visibleWidth * visibleHeight / area) * 1000) / 10;
  }

  function finish() {
    window.__PP_DEBUG_EXPORT = report;
    var text = JSON.stringify(report, null, 2);
    console.group('[PP Debug] Full diagnostic bundle');
    console.log(report);
    console.info('Saved as window.__PP_DEBUG_EXPORT');
    console.groupEnd();
    try {
      if (typeof copy === 'function') {
        copy(text);
        console.info('[PP Debug] JSON copied with the DevTools copy() helper.');
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          console.info('[PP Debug] JSON copied to the clipboard.');
        }).catch(function () {});
      }
    } catch (_) {}
    return report;
  }

  try {
    var ids = selectedAdUnit ? [selectedAdUnit] : Array.prototype.slice.call(document.querySelectorAll('[id]')).map(function (element) {
      return element.id;
    }).filter(function (id) {
      return /ad|banner|billboard|sticky|infeed|intext|branding/i.test(id);
    }).slice(0, 100);
    report.domSlots = ids.map(function (id) {
      var element = document.getElementById(id);
      if (!element) return { id: id, present: false };
      var rect = element.getBoundingClientRect();
      return {
        id: id,
        present: true,
        connected: element.isConnected,
        className: element.className,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visiblePct: visiblePercent(element),
        iframeCount: element.querySelectorAll('iframe').length,
        data: Object.assign({}, element.dataset)
      };
    });
  } catch (_) {}

  if (window.googletag && window.googletag.cmd) {
    window.googletag.cmd.push(function () {
      try {
        report.gamSlots = window.googletag.pubads().getSlots().filter(function (slot) {
          return !selectedAdUnit || slot.getSlotElementId() === selectedAdUnit;
        }).map(function (slot) {
          var response = typeof slot.getResponseInformation === 'function' ? slot.getResponseInformation() : null;
          return {
            id: slot.getSlotElementId(),
            adUnitPath: slot.getAdUnitPath(),
            targeting: targetingMap(slot),
            response: response
          };
        });
      } catch (error) {
        report.gamSlots = [{ error: String(error) }];
      }
      finish();
    });
  } else {
    finish();
  }
`);
}

function environmentCommand(scope: DebugScope): string {
  return wrapCommand('Environment summary', scope, `
  var summary = {
    configuredSite: configuredSiteName + ' (' + configuredDomain + ')',
    configuredSiteId: configuredSiteId,
    pageUrl: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    runtimeSiteId: window.ADOPS_SITE_ID || null,
    release: window.ADOPS_RELEASE || window.ADS_BUILD_TS || null,
    generatorProfile: window.ADOPS_GENERATOR_PROFILE || window.ADOPS_GENERATOR_PROFILE_ID || null,
    prebidLoaded: Boolean(window.pbjs),
    prebidVersion: window.pbjs && (window.pbjs.version || window.pbjs.libLoaded) || null,
    gptLoaded: Boolean(window.googletag),
    tcfApi: typeof window.__tcfapi === 'function',
    gppApi: typeof window.__gpp === 'function',
    selectedAdUnit: selectedAdUnit || 'all',
    selectedBidder: selectedBidder || 'all'
  };
  console.group('[PP Debug] Environment summary');
  console.table([summary]);
  console.log(summary);
  console.groupEnd();
  return summary;
`);
}

function gptSlotsCommand(scope: DebugScope): string {
  return wrapCommand('GPT slot snapshot', scope, `
  if (!window.googletag || !window.googletag.cmd) {
    console.error('[PP Debug] Google Publisher Tag is not available.');
    return;
  }

  function sizeText(size) {
    try {
      if (size && typeof size.getWidth === 'function') return size.getWidth() + 'x' + size.getHeight();
      return String(size);
    } catch (_) {
      return String(size);
    }
  }

  window.googletag.cmd.push(function () {
    var slots = window.googletag.pubads().getSlots().filter(function (slot) {
      return !selectedAdUnit || slot.getSlotElementId() === selectedAdUnit;
    });
    var rows = slots.map(function (slot) {
      var response = typeof slot.getResponseInformation === 'function' ? slot.getResponseInformation() : null;
      return {
        id: slot.getSlotElementId(),
        adUnitPath: slot.getAdUnitPath(),
        sizes: (slot.getSizes ? slot.getSizes() : []).map(sizeText).join(', '),
        serviceCount: slot.getServices ? slot.getServices().length : null,
        lineItemId: response && response.lineItemId || null,
        creativeId: response && response.creativeId || null,
        advertiserId: response && response.advertiserId || null,
        refreshBucket: slot.getTargeting ? slot.getTargeting('refresh_bucket').join(', ') : ''
      };
    });
    console.group('[PP Debug] GPT slot snapshot');
    console.table(rows);
    console.log('Raw slots:', slots);
    console.groupEnd();
    return rows;
  });
`);
}

function targetingCommand(scope: DebugScope): string {
  return wrapCommand('GAM targeting', scope, `
  if (!window.googletag || !window.googletag.cmd) {
    console.error('[PP Debug] Google Publisher Tag is not available.');
    return;
  }

  window.googletag.cmd.push(function () {
    var output = window.googletag.pubads().getSlots().filter(function (slot) {
      return !selectedAdUnit || slot.getSlotElementId() === selectedAdUnit;
    }).map(function (slot) {
      return {
        id: slot.getSlotElementId(),
        adUnitPath: slot.getAdUnitPath(),
        targeting: targetingMap(slot)
      };
    });
    console.group('[PP Debug] GAM targeting');
    output.forEach(function (item) {
      console.groupCollapsed(item.id + ' — ' + item.adUnitPath);
      console.table(Object.keys(item.targeting).map(function (key) {
        return { key: key, value: Array.isArray(item.targeting[key]) ? item.targeting[key].join(', ') : String(item.targeting[key]) };
      }));
      console.log(item.targeting);
      console.groupEnd();
    });
    console.groupEnd();
    return output;
  });
`);
}

function bidResponsesCommand(scope: DebugScope): string {
  return wrapCommand('Prebid bid responses', scope, `
  var pbjs = window.pbjs;
  if (!pbjs || typeof pbjs.getBidResponses !== 'function') {
    console.error('[PP Debug] Prebid bid responses are not available.');
    return;
  }
  var responses = pbjs.getBidResponses() || {};
  var rows = [];
  Object.keys(responses).forEach(function (code) {
    ((responses[code] && responses[code].bids) || []).forEach(function (bid) {
      var normalized = Object.assign({ adUnitCode: code }, bid);
      if (!matchesUnit(normalized) || !matchesBidder(normalized)) return;
      rows.push({
        adUnitCode: code,
        bidder: bidderName(normalized),
        cpm: Number(bid.cpm || 0),
        currency: bid.currency || '',
        size: bid.width && bid.height ? bid.width + 'x' + bid.height : '',
        mediaType: bid.mediaType || '',
        timeToRespond: bid.timeToRespond || null,
        status: bid.statusMessage || bid.status || '',
        adId: bid.adId || '',
        auctionId: bid.auctionId || ''
      });
    });
  });
  rows.sort(function (left, right) { return right.cpm - left.cpm; });
  console.group('[PP Debug] Prebid bid responses');
  console.table(rows);
  console.log('Raw responses:', responses);
  console.groupEnd();
  return rows;
`);
}

function auctionHistoryCommand(scope: DebugScope): string {
  return wrapCommand('Prebid auction history', scope, `
  var pbjs = window.pbjs;
  if (!pbjs || typeof pbjs.getEvents !== 'function') {
    console.error('[PP Debug] pbjs.getEvents() is not available in this build.');
    return;
  }
  var events = pbjs.getEvents() || [];
  var rows = [];
  events.forEach(function (event, index) {
    var args = event.args || {};
    var candidates = Array.isArray(args) ? args : [args];
    var haystack = '';
    try { haystack = JSON.stringify(args); } catch (_) {}
    if (selectedAdUnit && haystack.indexOf(selectedAdUnit) < 0) return;
    if (selectedBidder && haystack.indexOf(selectedBidder) < 0) return;
    var first = candidates[0] || {};
    rows.push({
      index: index,
      eventType: event.eventType || event.type || '',
      elapsedTime: event.elapsedTime == null ? null : event.elapsedTime,
      auctionId: first.auctionId || first.auctionId || '',
      adUnitCode: unitName(first),
      bidder: bidderName(first),
      cpm: first.cpm == null ? null : first.cpm
    });
  });
  console.group('[PP Debug] Prebid auction history');
  console.table(rows);
  console.log('Raw events:', events);
  console.groupEnd();
  return rows;
`);
}

function bidderDiagnosticsCommand(scope: DebugScope): string {
  return wrapCommand('Bidder diagnostics', scope, `
  var pbjs = window.pbjs;
  if (!pbjs) {
    console.error('[PP Debug] Prebid is not available.');
    return;
  }

  var groups = {};
  function group(name) {
    var key = name || '(unknown)';
    if (!groups[key]) groups[key] = { bidder: key, responses: 0, noBids: 0, timeouts: 0, wins: 0, cpmTotal: 0, maxCpm: 0, responseMsTotal: 0 };
    return groups[key];
  }

  var responses = typeof pbjs.getBidResponses === 'function' ? pbjs.getBidResponses() : {};
  Object.keys(responses || {}).forEach(function (code) {
    ((responses[code] && responses[code].bids) || []).forEach(function (bid) {
      var normalized = Object.assign({ adUnitCode: code }, bid);
      if (!matchesUnit(normalized) || !matchesBidder(normalized)) return;
      var item = group(bidderName(normalized));
      item.responses += 1;
      item.cpmTotal += Number(bid.cpm || 0);
      item.maxCpm = Math.max(item.maxCpm, Number(bid.cpm || 0));
      item.responseMsTotal += Number(bid.timeToRespond || 0);
    });
  });

  var events = typeof pbjs.getEvents === 'function' ? pbjs.getEvents() : [];
  events.forEach(function (event) {
    var eventType = event.eventType || event.type || '';
    var args = Array.isArray(event.args) ? event.args : [event.args || {}];
    args.forEach(function (value) {
      var haystack = '';
      try { haystack = JSON.stringify(value); } catch (_) {}
      if (selectedAdUnit && haystack.indexOf(selectedAdUnit) < 0) return;
      var name = bidderName(value);
      if (selectedBidder && name !== selectedBidder && haystack.indexOf(selectedBidder) < 0) return;
      if (!name && selectedBidder) name = selectedBidder;
      if (!name) return;
      var item = group(name);
      if (eventType === 'noBid') item.noBids += 1;
      if (eventType === 'bidTimeout') item.timeouts += 1;
      if (eventType === 'bidWon') item.wins += 1;
    });
  });

  if (selectedBidder && !groups[selectedBidder]) group(selectedBidder);
  var rows = Object.keys(groups).sort().map(function (key) {
    var item = groups[key];
    return {
      bidder: item.bidder,
      responses: item.responses,
      noBids: item.noBids,
      timeouts: item.timeouts,
      wins: item.wins,
      averageCpm: item.responses ? Math.round(item.cpmTotal / item.responses * 10000) / 10000 : 0,
      maxCpm: Math.round(item.maxCpm * 10000) / 10000,
      averageResponseMs: item.responses ? Math.round(item.responseMsTotal / item.responses) : 0
    };
  });
  console.group('[PP Debug] Bidder diagnostics');
  console.table(rows);
  console.log('Scope:', { adUnit: selectedAdUnit || 'all', bidder: selectedBidder || 'all' });
  console.groupEnd();
  return rows;
`);
}

function winningBidsCommand(scope: DebugScope): string {
  return wrapCommand('Winning and highest CPM bids', scope, `
  var pbjs = window.pbjs;
  if (!pbjs) {
    console.error('[PP Debug] Prebid is not available.');
    return;
  }
  var winning = typeof pbjs.getAllWinningBids === 'function' ? pbjs.getAllWinningBids() : [];
  var highest = typeof pbjs.getHighestCpmBids === 'function' ? pbjs.getHighestCpmBids(selectedAdUnit || undefined) : [];
  winning = winning.filter(function (bid) { return matchesUnit(bid) && matchesBidder(bid); });
  highest = highest.filter(function (bid) { return matchesUnit(bid) && matchesBidder(bid); });
  function row(bid) {
    return {
      adUnitCode: unitName(bid),
      bidder: bidderName(bid),
      cpm: bid.cpm,
      currency: bid.currency || '',
      size: bid.width && bid.height ? bid.width + 'x' + bid.height : '',
      adId: bid.adId || '',
      auctionId: bid.auctionId || ''
    };
  }
  console.group('[PP Debug] Winning and highest CPM bids');
  console.info('Winning bids');
  console.table(winning.map(row));
  console.info('Highest CPM bids');
  console.table(highest.map(row));
  console.groupEnd();
  return { winning: winning, highest: highest };
`);
}

function prebidConfigCommand(scope: DebugScope): string {
  return wrapCommand('Prebid configuration snapshot', scope, `
  var pbjs = window.pbjs;
  if (!pbjs || typeof pbjs.getConfig !== 'function') {
    console.error('[PP Debug] Prebid configuration is not available.');
    return;
  }
  var config = pbjs.getConfig() || {};
  var snapshot = {
    bidderTimeout: config.bidderTimeout,
    timeoutBuffer: config.timeoutBuffer,
    priceGranularity: config.priceGranularity,
    currency: config.currency,
    floors: config.floors,
    userSync: config.userSync,
    consentManagement: config.consentManagement,
    consentManagementGpp: config.consentManagementGpp,
    ortb2: config.ortb2,
    schain: config.schain,
    sizeConfig: config.sizeConfig,
    debug: config.debug
  };
  console.group('[PP Debug] Prebid configuration snapshot');
  console.log(snapshot);
  console.log('Full config:', config);
  console.groupEnd();
  return snapshot;
`);
}

function consentCommand(scope: DebugScope): string {
  return wrapCommand('Consent state', scope, `
  var pbjs = window.pbjs;
  var config = pbjs && typeof pbjs.getConfig === 'function' ? pbjs.getConfig() : {};
  var report = {
    generatedAt: new Date().toISOString(),
    cmpModeHint: window.ADOPS_CMP_MODE || window.CMP_MODE || null,
    consentTimeout: window.__PP_CONSENT_TIMEOUT || null,
    apis: {
      tcf: typeof window.__tcfapi === 'function',
      gpp: typeof window.__gpp === 'function',
      usp: typeof window.__uspapi === 'function'
    },
    prebid: {
      tcf: config.consentManagement || null,
      gpp: config.consentManagementGpp || null
    },
    tcfPing: null,
    tcData: null,
    gppPing: null,
    uspData: null
  };

  function show() {
    console.group('[PP Debug] Consent state');
    console.log(report);
    console.groupEnd();
    window.__PP_DEBUG_CONSENT = report;
  }

  show();
  try {
    if (report.apis.tcf) {
      window.__tcfapi('ping', 2, function (data, success) {
        report.tcfPing = { success: success, data: data };
        show();
      });
      window.__tcfapi('getTCData', 2, function (data, success) {
        report.tcData = { success: success, data: data };
        show();
      });
    }
  } catch (error) {
    report.tcfError = String(error);
  }
  try {
    if (report.apis.gpp) {
      window.__gpp('ping', function (data, success) {
        report.gppPing = { success: success, data: data };
        show();
      });
    }
  } catch (error) {
    report.gppError = String(error);
  }
  try {
    if (report.apis.usp) {
      window.__uspapi('getUSPData', 1, function (data, success) {
        report.uspData = { success: success, data: data };
        show();
      });
    }
  } catch (error) {
    report.uspError = String(error);
  }
  window.setTimeout(show, 1200);
  return report;
`);
}

function userIdsCommand(scope: DebugScope): string {
  return wrapCommand('User ID state', scope, `
  var pbjs = window.pbjs;
  if (!pbjs) {
    console.error('[PP Debug] Prebid is not available.');
    return;
  }
  var config = typeof pbjs.getConfig === 'function' ? pbjs.getConfig() : {};
  var storageKeys = [];
  try {
    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      if (key && /id5|criteo|shared|lotame|pubcid|uid2|identity|user.?id/i.test(key)) storageKeys.push(key);
    }
  } catch (_) {}
  var report = {
    ids: typeof pbjs.getUserIds === 'function' ? pbjs.getUserIds() : null,
    eids: typeof pbjs.getUserIdsAsEids === 'function' ? pbjs.getUserIdsAsEids() : null,
    userSyncConfig: config.userSync || null,
    detectedStorageKeyNames: storageKeys.sort()
  };
  console.group('[PP Debug] User ID state');
  console.log(report);
  console.info('Only storage key names are listed; localStorage values are not read by this command.');
  console.groupEnd();
  return report;
`);
}

function schainCommand(scope: DebugScope): string {
  return wrapCommand('SChain state', scope, `
  var pbjs = window.pbjs;
  if (!pbjs) {
    console.error('[PP Debug] Prebid is not available.');
    return;
  }
  var config = typeof pbjs.getConfig === 'function' ? pbjs.getConfig() : {};
  var configured = config.ortb2 && config.ortb2.source && config.ortb2.source.schain
    ? config.ortb2.source.schain
    : config.schain || null;
  var events = typeof pbjs.getEvents === 'function' ? pbjs.getEvents() : [];
  var relatedEvents = events.filter(function (event) {
    try {
      var text = JSON.stringify(event.args || {});
      if (text.indexOf('schain') < 0) return false;
      if (selectedBidder && text.indexOf(selectedBidder) < 0) return false;
      return true;
    } catch (_) {
      return false;
    }
  });
  var report = { configured: configured, relatedEvents: relatedEvents };
  console.group('[PP Debug] SChain state');
  console.log('Configured SChain:', configured);
  console.log('Events containing SChain data:', relatedEvents);
  console.groupEnd();
  return report;
`);
}

function refreshViewabilityCommand(scope: DebugScope): string {
  return wrapCommand('Refresh and viewability snapshot', scope, `
  function visiblePercent(element) {
    if (!element) return 0;
    var rect = element.getBoundingClientRect();
    var visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    var visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    var area = Math.max(1, rect.width * rect.height);
    return Math.round((visibleWidth * visibleHeight / area) * 1000) / 10;
  }

  function inspect(ids, slots) {
    var rows = ids.map(function (id) {
      var element = document.getElementById(id);
      var slot = slots.find(function (candidate) { return candidate.getSlotElementId() === id; });
      var rect = element ? element.getBoundingClientRect() : null;
      var response = slot && typeof slot.getResponseInformation === 'function' ? slot.getResponseInformation() : null;
      return {
        id: id,
        present: Boolean(element),
        connected: Boolean(element && element.isConnected),
        width: rect ? Math.round(rect.width) : 0,
        height: rect ? Math.round(rect.height) : 0,
        visiblePct: visiblePercent(element),
        iframeCount: element ? element.querySelectorAll('iframe').length : 0,
        refreshBucket: slot && slot.getTargeting ? slot.getTargeting('refresh_bucket').join(', ') : '',
        hbBidder: slot && slot.getTargeting ? slot.getTargeting('hb_bidder').join(', ') : '',
        lineItemId: response && response.lineItemId || null,
        documentVisibility: document.visibilityState
      };
    });

    var exposed = {};
    Object.keys(window).filter(function (key) {
      return /^(?:__PP|PP_|ADOPS_)/.test(key) && /refresh|dwell|view|consent/i.test(key);
    }).forEach(function (key) {
      try { exposed[key] = window[key]; } catch (_) { exposed[key] = '[unreadable]'; }
    });

    console.group('[PP Debug] Refresh and viewability snapshot');
    console.table(rows);
    console.log('Exposed runtime state:', exposed);
    console.info('Private wrapper counters cannot be read unless the runtime explicitly exposes them on window.');
    console.groupEnd();
    return { rows: rows, exposed: exposed };
  }

  if (window.googletag && window.googletag.cmd) {
    window.googletag.cmd.push(function () {
      var slots = window.googletag.pubads().getSlots();
      var ids = selectedAdUnit ? [selectedAdUnit] : slots.map(function (slot) { return slot.getSlotElementId(); });
      inspect(ids, slots);
    });
  } else {
    inspect(selectedAdUnit ? [selectedAdUnit] : [], []);
  }
`);
}

function liveLoggerCommand(scope: DebugScope): string {
  return wrapCommand('Live Prebid event logger', scope, `
  var pbjs = window.pbjs;
  if (!pbjs || typeof pbjs.onEvent !== 'function') {
    console.error('[PP Debug] Prebid event API is not available.');
    return;
  }

  if (window.__PP_DEBUG_BID_LOGGER && typeof window.__PP_DEBUG_BID_LOGGER.stop === 'function') {
    window.__PP_DEBUG_BID_LOGGER.stop();
  }

  var eventNames = [
    'auctionInit', 'auctionEnd', 'bidRequested', 'bidResponse', 'noBid',
    'bidTimeout', 'bidWon', 'bidderDone', 'setTargeting',
    'adRenderSucceeded', 'adRenderFailed'
  ];
  var handlers = {};

  eventNames.forEach(function (eventName) {
    var handler = function (args) {
      var text = '';
      try { text = JSON.stringify(args || {}); } catch (_) {}
      if (selectedAdUnit && text.indexOf(selectedAdUnit) < 0) return;
      if (selectedBidder && text.indexOf(selectedBidder) < 0) return;
      console.log('[PP Prebid Event] ' + eventName, args);
    };
    handlers[eventName] = handler;
    pbjs.onEvent(eventName, handler);
  });

  window.__PP_DEBUG_BID_LOGGER = {
    handlers: handlers,
    stop: function () {
      eventNames.forEach(function (eventName) {
        try {
          if (typeof pbjs.offEvent === 'function') pbjs.offEvent(eventName, handlers[eventName]);
        } catch (_) {}
      });
      console.info('[PP Debug] Live Prebid event logger stopped.');
      delete window.__PP_DEBUG_BID_LOGGER;
    }
  };

  console.info('[PP Debug] Live Prebid event logger started. Run __PP_DEBUG_BID_LOGGER.stop() to stop it.');
  return window.__PP_DEBUG_BID_LOGGER;
`);
}

function buildCommands(scope: DebugScope): DebugCommand[] {
  return [
    {id:'ab-inspect',category:'Runtime',title:'A/B experiment inspect',description:'Inspect selected packages, Prebid, duplicate loader attempts and loading errors. Copies JSON in DevTools; execution counts remain unknown without runtime evidence.',code:experimentInspectCommand},
    {
      id: 'full-diagnostic',
      category: 'Overview',
      title: 'Full diagnostic bundle',
      description: 'Collect runtime metadata, Prebid state, GPT slots and DOM slot visibility. The resulting JSON is saved as window.__PP_DEBUG_EXPORT and copied when DevTools allows it.',
      code: fullDiagnosticCommand(scope),
    },
    {
      id: 'environment',
      category: 'Overview',
      title: 'Environment summary',
      description: 'Confirm the page, runtime release, generator profile, Prebid, GPT and consent APIs currently loaded.',
      code: environmentCommand(scope),
    },
    {
      id: 'gpt-slots',
      category: 'GAM',
      title: 'GPT slot snapshot',
      description: 'List slot IDs, GAM paths, sizes, response information and refresh_bucket targeting.',
      code: gptSlotsCommand(scope),
    },
    {
      id: 'gam-targeting',
      category: 'GAM',
      title: 'GAM targeting',
      description: 'Print the complete targeting map for the selected slot or every GPT slot.',
      code: targetingCommand(scope),
    },
    {
      id: 'bid-responses',
      category: 'Prebid',
      title: 'Bid responses',
      description: 'Flatten Prebid bid responses and filter them by ad unit and bidder.',
      code: bidResponsesCommand(scope),
    },
    {
      id: 'auction-history',
      category: 'Prebid',
      title: 'Auction history',
      description: 'Show recorded Prebid events for the current page, including auction, bid and timeout events.',
      code: auctionHistoryCommand(scope),
    },
    {
      id: 'bidder-diagnostics',
      category: 'Prebid',
      title: 'Bidder diagnostics',
      description: 'Summarize responses, no-bids, timeouts, wins, CPM and response time by bidder.',
      code: bidderDiagnosticsCommand(scope),
    },
    {
      id: 'winning-bids',
      category: 'Prebid',
      title: 'Winning and highest CPM bids',
      description: 'Compare winning bids with the highest CPM bids available for the selected scope.',
      code: winningBidsCommand(scope),
    },
    {
      id: 'prebid-config',
      category: 'Prebid',
      title: 'Prebid configuration',
      description: 'Inspect timeout, currency, floors, consent, User ID, ORTB2, SChain and responsive configuration.',
      code: prebidConfigCommand(scope),
    },
    {
      id: 'live-logger',
      category: 'Prebid',
      title: 'Live Prebid event logger',
      description: 'Start filtered live logging for auction, bid, timeout, win and render events. The command includes a stop helper.',
      code: liveLoggerCommand(scope),
    },
    {
      id: 'consent',
      category: 'Privacy',
      title: 'Consent state',
      description: 'Inspect Prebid consent configuration and query the available TCF, GPP and US Privacy APIs.',
      code: consentCommand(scope),
    },
    {
      id: 'user-ids',
      category: 'Privacy',
      title: 'User ID state',
      description: 'Print Prebid User ID and EID state plus matching localStorage key names without reading stored values.',
      code: userIdsCommand(scope),
    },
    {
      id: 'schain',
      category: 'Privacy',
      title: 'SChain state',
      description: 'Show the configured SupplyChain object and Prebid events that contain SChain data.',
      code: schainCommand(scope),
    },
    {
      id: 'refresh-viewability',
      category: 'Runtime',
      title: 'Refresh and viewability snapshot',
      description: 'Measure current DOM visibility, iframe presence, GAM response data and refresh_bucket targeting.',
      code: refreshViewabilityCommand(scope),
    },
  ];
}

function downloadCommand(command: DebugCommand, publisherId: string): void {
  const blob = new Blob([command.code], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `debug-${publisherId}-${command.id}.js`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export default function DebugConsolePanel({ publisherId, siteName, domain }: Props) {
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [bidders, setBidders] = useState<Bidder[]>([]);
  const [selectedAdUnit, setSelectedAdUnit] = useState(ALL);
  const [customAdUnit, setCustomAdUnit] = useState('');
  const [selectedBidder, setSelectedBidder] = useState(ALL);
  const [customBidder, setCustomBidder] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loadedAdUnits, loadedBidders] = await Promise.all([
        api.listAdUnits(publisherId),
        api.listBidders(publisherId),
      ]);
      setAdUnits(
        loadedAdUnits
          .filter((unit) => unit.enabled && unit.type !== 'DRAFT')
          .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code)),
      );
      setBidders(
        loadedBidders
          .slice()
          .sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.bidder.localeCompare(right.bidder)),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Debug options could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const scope = useMemo<DebugScope>(() => ({
    siteId: publisherId,
    siteName,
    domain,
    adUnit: selectedAdUnit === ALL ? '' : selectedAdUnit === CUSTOM ? customAdUnit.trim() : selectedAdUnit,
    bidder: selectedBidder === ALL ? '' : selectedBidder === CUSTOM ? customBidder.trim() : selectedBidder,
  }), [customAdUnit, customBidder, domain, publisherId, selectedAdUnit, selectedBidder, siteName]);

  const commands = useMemo(() => buildCommands(scope), [scope]);
  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => `${command.category} ${command.title} ${command.description}`.toLowerCase().includes(needle));
  }, [commands, query]);

  const grouped = useMemo(() => CATEGORY_ORDER.map((category) => ({
    category,
    commands: filteredCommands.filter((command) => command.category === category),
  })).filter((group) => group.commands.length), [filteredCommands]);

  async function copyCommand(command: DebugCommand): Promise<void> {
    try {
      await copyText(command.code);
      setCopiedId(command.id);
      window.setTimeout(() => setCopiedId((current) => current === command.id ? null : current), 1800);
    } catch {
      setError('Clipboard access was blocked. Open the command preview and copy it manually.');
    }
  }

  const fullCommand = commands.find((command) => command.id === 'full-diagnostic') ?? commands[0];
  const scopeUnit = scope.adUnit || 'All ad units';
  const scopeBidder = scope.bidder || 'All bidders';

  if (loading) return <div className="config-loading">Loading Debug Console…</div>;

  return (
    <section className="debug-console-page">
      <header className="debug-console-heading">
        <div>
          <span className="panel-kicker">Browser diagnostics</span>
          <h2>Debug Console</h2>
          <p>
            Choose an ad unit and bidder, copy a command, then run it in DevTools Console on <strong>{domain}</strong> after the ad runtime has loaded.
          </p>
        </div>
        <div className="debug-console-heading-actions">
          <button className={copiedId === 'full-diagnostic' ? 'button success' : 'button primary'} onClick={() => void copyCommand(fullCommand)} type="button">
            {copiedId === 'full-diagnostic' ? '✓ Copied full diagnostic' : 'Copy full diagnostic'}
          </button>
          <button className="button secondary" onClick={() => void load()} type="button">Reload options</button>
        </div>
      </header>

      {error ? <div className="form-error debug-console-error">{error}</div> : null}

      <article className="debug-scope-card">
        <div className="debug-scope-grid">
          <label>
            <span>Ad unit scope</span>
            <select onChange={(event) => setSelectedAdUnit(event.target.value)} value={selectedAdUnit}>
              <option value={ALL}>All ad units</option>
              {adUnits.map((unit) => <option key={unit.id} value={unit.code}>{unit.code}</option>)}
              <option value={CUSTOM}>Custom ad unit…</option>
            </select>
          </label>
          {selectedAdUnit === CUSTOM ? (
            <label>
              <span>Custom ad unit code / div ID</span>
              <input onChange={(event) => setCustomAdUnit(event.target.value)} placeholder="Billboard2_Homepage" value={customAdUnit} />
            </label>
          ) : null}
          <label>
            <span>Bidder scope</span>
            <select onChange={(event) => setSelectedBidder(event.target.value)} value={selectedBidder}>
              <option value={ALL}>All bidders</option>
              {bidders.map((bidder) => (
                <option key={bidder.id} value={bidder.bidder}>
                  {bidder.bidder}{bidder.enabled ? '' : ' · saved, disabled'}
                </option>
              ))}
              <option value={CUSTOM}>Custom bidder…</option>
            </select>
          </label>
          {selectedBidder === CUSTOM ? (
            <label>
              <span>Custom bidder code</span>
              <input onChange={(event) => setCustomBidder(event.target.value)} placeholder="richaudience" value={customBidder} />
            </label>
          ) : null}
          <label className="debug-search-field">
            <span>Find command</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="bids, targeting, consent…" value={query} />
          </label>
        </div>
        <div className="debug-scope-summary">
          <span><strong>Site</strong>{siteName}</span>
          <span><strong>Ad unit</strong>{scopeUnit}</span>
          <span><strong>Bidder</strong>{scopeBidder}</span>
          <span><strong>Commands</strong>{filteredCommands.length}</span>
        </div>
      </article>

      <div className="debug-console-note">
        <strong>Safe workflow:</strong>
        <span>These commands only read the current page state and print to your local browser console. The live event logger adds temporary Prebid listeners and includes its own stop command.</span>
      </div>

      {grouped.map((group) => (
        <section className="debug-command-section" key={group.category}>
          <div className="debug-command-section-heading">
            <h3>{group.category}</h3>
            <span>{group.commands.length} command{group.commands.length === 1 ? '' : 's'}</span>
          </div>
          <div className="debug-command-grid">
            {group.commands.map((command) => (
              <article className="debug-command-card" key={command.id}>
                <div className="debug-command-card-heading">
                  <div>
                    <span>{command.category}</span>
                    <h4>{command.title}</h4>
                  </div>
                  <button className={copiedId === command.id ? 'button success' : 'button secondary'} onClick={() => void copyCommand(command)} type="button">
                    {copiedId === command.id ? '✓ Copied' : 'Copy command'}
                  </button>
                </div>
                <p>{command.description}</p>
                <div className="debug-command-scope">
                  <code>{scopeUnit}</code>
                  <code>{scopeBidder}</code>
                </div>
                <details className="debug-command-preview">
                  <summary>Preview command</summary>
                  <pre>{command.code}</pre>
                </details>
                <button className="debug-download-button" onClick={() => downloadCommand(command, publisherId)} type="button">Download .js</button>
              </article>
            ))}
          </div>
        </section>
      ))}

      {!filteredCommands.length ? (
        <div className="debug-empty-state">
          <strong>No matching commands</strong>
          <span>Clear the search field or use a broader term.</span>
        </div>
      ) : null}
    </section>
  );
}
