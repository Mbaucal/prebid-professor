import {
  createAdUnit,
  deleteAdUnit,
  duplicateAdUnit,
  listAdUnits,
  updateAdUnit,
} from './ad-units';
import {
  createBidder,
  createBidderOverride,
  deleteBidder,
  deleteBidderOverride,
  duplicateBidder,
  duplicateBidderOverride,
  listBidders,
  updateBidder,
  updateBidderOverride,
} from './bidders';
import { apiError, json } from './http';
import { applyCsvImport, previewCsvImport } from './imports';
import {
  createPublisherAccount,
  deletePublisherAccount,
  getPublisherAccount,
  listPublisherAccounts,
  updatePublisherAccount,
} from './publisher-accounts';
import {
  createPublisher,
  createSite,
  deleteSite,
  duplicatePublisher,
  duplicateSite,
  getPublisher,
  listPublishers,
  type DatabaseEnv,
} from './publishers';
import { moveSite, updateSite } from './site-management';
import {
  createSizeMap,
  deleteSizeMap,
  duplicateSizeMap,
  listSizeMaps,
  updateSizeMap,
} from './size-maps';
import {
  createUnitRule,
  deleteUnitRule,
  duplicateUnitRule,
  listUnitRules,
  updateUnitRule,
} from './unit-rules';

interface Env extends DatabaseEnv {
  ASSETS: Fetcher;
}

async function databaseStatus(env: Env): Promise<'connected' | 'not-bound' | 'error'> {
  if (!env.DB) return 'not-bound';
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return 'connected';
  } catch {
    return 'error';
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/api/health') {
      return json({
        ok: true,
        service: 'prebid-professor',
        environment: 'foundation',
        database: await databaseStatus(env),
        timestamp: new Date().toISOString(),
      });
    }

    // Publisher account/company -> multiple sites/domains.
    if (pathname === '/api/publisher-accounts') {
      if (request.method === 'GET') return listPublisherAccounts(env);
      if (request.method === 'POST') return createPublisherAccount(request, env);
      return apiError('Method not allowed.', 405);
    }

    const publisherAccountMatch = pathname.match(/^\/api\/publisher-accounts\/([^/]+)$/);
    if (publisherAccountMatch) {
      const accountId = decodeURIComponent(publisherAccountMatch[1]);
      if (request.method === 'GET') return getPublisherAccount(env, accountId);
      if (request.method === 'PATCH') return updatePublisherAccount(request, env, accountId);
      if (request.method === 'DELETE') return deletePublisherAccount(request, env, accountId);
      return apiError('Method not allowed.', 405);
    }

    if (pathname === '/api/sites') {
      if (request.method === 'GET') return listPublishers(env);
      if (request.method === 'POST') return createSite(request, env);
      return apiError('Method not allowed.', 405);
    }

    const siteDuplicateMatch = pathname.match(/^\/api\/sites\/([^/]+)\/duplicate$/);
    if (siteDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateSite(request, env, decodeURIComponent(siteDuplicateMatch[1]));
    }

    const siteMoveMatch = pathname.match(/^\/api\/sites\/([^/]+)\/move$/);
    if (siteMoveMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return moveSite(request, env, decodeURIComponent(siteMoveMatch[1]));
    }

    const siteMatch = pathname.match(/^\/api\/sites\/([^/]+)$/);
    if (siteMatch) {
      const siteId = decodeURIComponent(siteMatch[1]);
      if (request.method === 'GET') return getPublisher(env, siteId);
      if (request.method === 'PATCH') return updateSite(request, env, siteId);
      if (request.method === 'DELETE') return deleteSite(request, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    // Legacy endpoint: these rows are now sites, kept for config routes.
    if (pathname === '/api/publishers') {
      if (request.method === 'GET') return listPublishers(env);
      if (request.method === 'POST') return createPublisher(request, env);
      return apiError('Method not allowed.', 405);
    }

    const importMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/imports\/(preview|apply)$/);
    if (importMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      const siteId = decodeURIComponent(importMatch[1]);
      return importMatch[2] === 'preview'
        ? previewCsvImport(request, env, siteId)
        : applyCsvImport(request, env, siteId);
    }

    const adUnitDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ad-units\/([^/]+)\/duplicate$/,
    );
    if (adUnitDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateAdUnit(
        request,
        env,
        decodeURIComponent(adUnitDuplicateMatch[1]),
        decodeURIComponent(adUnitDuplicateMatch[2]),
      );
    }

    const adUnitMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ad-units\/([^/]+)$/);
    if (adUnitMatch) {
      const siteId = decodeURIComponent(adUnitMatch[1]);
      const adUnitId = decodeURIComponent(adUnitMatch[2]);
      if (request.method === 'PATCH') return updateAdUnit(request, env, siteId, adUnitId);
      if (request.method === 'DELETE') return deleteAdUnit(request, env, siteId, adUnitId);
      return apiError('Method not allowed.', 405);
    }

    const adUnitsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ad-units$/);
    if (adUnitsMatch) {
      const siteId = decodeURIComponent(adUnitsMatch[1]);
      if (request.method === 'GET') return listAdUnits(env, siteId);
      if (request.method === 'POST') return createAdUnit(request, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const sizeMapDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/size-maps\/([^/]+)\/duplicate$/,
    );
    if (sizeMapDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateSizeMap(
        request,
        env,
        decodeURIComponent(sizeMapDuplicateMatch[1]),
        decodeURIComponent(sizeMapDuplicateMatch[2]),
      );
    }

    const sizeMapMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/size-maps\/([^/]+)$/,
    );
    if (sizeMapMatch) {
      const siteId = decodeURIComponent(sizeMapMatch[1]);
      const sizeMapId = decodeURIComponent(sizeMapMatch[2]);
      if (request.method === 'PATCH') return updateSizeMap(request, env, siteId, sizeMapId);
      if (request.method === 'DELETE') return deleteSizeMap(request, env, siteId, sizeMapId);
      return apiError('Method not allowed.', 405);
    }

    const sizeMapsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/size-maps$/);
    if (sizeMapsMatch) {
      const siteId = decodeURIComponent(sizeMapsMatch[1]);
      if (request.method === 'GET') return listSizeMaps(env, siteId);
      if (request.method === 'POST') return createSizeMap(request, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const unitRuleDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/unit-rules\/([^/]+)\/duplicate$/,
    );
    if (unitRuleDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateUnitRule(
        request,
        env,
        decodeURIComponent(unitRuleDuplicateMatch[1]),
        decodeURIComponent(unitRuleDuplicateMatch[2]),
      );
    }

    const unitRuleMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/unit-rules\/([^/]+)$/,
    );
    if (unitRuleMatch) {
      const siteId = decodeURIComponent(unitRuleMatch[1]);
      const unitRuleId = decodeURIComponent(unitRuleMatch[2]);
      if (request.method === 'PATCH') return updateUnitRule(request, env, siteId, unitRuleId);
      if (request.method === 'DELETE') return deleteUnitRule(request, env, siteId, unitRuleId);
      return apiError('Method not allowed.', 405);
    }

    const unitRulesMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/unit-rules$/);
    if (unitRulesMatch) {
      const siteId = decodeURIComponent(unitRulesMatch[1]);
      if (request.method === 'GET') return listUnitRules(env, siteId);
      if (request.method === 'POST') return createUnitRule(request, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const bidderDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/bidders\/([^/]+)\/duplicate$/,
    );
    if (bidderDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateBidder(
        request,
        env,
        decodeURIComponent(bidderDuplicateMatch[1]),
        decodeURIComponent(bidderDuplicateMatch[2]),
      );
    }

    const bidderOverridesCreateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/bidders\/([^/]+)\/overrides$/,
    );
    if (bidderOverridesCreateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return createBidderOverride(
        request,
        env,
        decodeURIComponent(bidderOverridesCreateMatch[1]),
        decodeURIComponent(bidderOverridesCreateMatch[2]),
      );
    }

    const bidderMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/bidders\/([^/]+)$/);
    if (bidderMatch) {
      const siteId = decodeURIComponent(bidderMatch[1]);
      const bidderId = decodeURIComponent(bidderMatch[2]);
      if (request.method === 'PATCH') return updateBidder(request, env, siteId, bidderId);
      if (request.method === 'DELETE') return deleteBidder(request, env, siteId, bidderId);
      return apiError('Method not allowed.', 405);
    }

    const biddersMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/bidders$/);
    if (biddersMatch) {
      const siteId = decodeURIComponent(biddersMatch[1]);
      if (request.method === 'GET') return listBidders(env, siteId);
      if (request.method === 'POST') return createBidder(request, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const overrideDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/bidder-overrides\/([^/]+)\/duplicate$/,
    );
    if (overrideDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateBidderOverride(
        request,
        env,
        decodeURIComponent(overrideDuplicateMatch[1]),
        decodeURIComponent(overrideDuplicateMatch[2]),
      );
    }

    const overrideMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/bidder-overrides\/([^/]+)$/,
    );
    if (overrideMatch) {
      const siteId = decodeURIComponent(overrideMatch[1]);
      const overrideId = decodeURIComponent(overrideMatch[2]);
      if (request.method === 'PATCH') return updateBidderOverride(request, env, siteId, overrideId);
      if (request.method === 'DELETE') return deleteBidderOverride(request, env, siteId, overrideId);
      return apiError('Method not allowed.', 405);
    }

    const legacyDuplicateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/duplicate$/);
    if (legacyDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicatePublisher(request, env, decodeURIComponent(legacyDuplicateMatch[1]));
    }

    const legacyPublisherMatch = pathname.match(/^\/api\/publishers\/([^/]+)$/);
    if (legacyPublisherMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return getPublisher(env, decodeURIComponent(legacyPublisherMatch[1]));
    }

    if (pathname.startsWith('/api/')) {
      return apiError('API route not found.', 404, { path: pathname });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
