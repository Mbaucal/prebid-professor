import type { PublisherAccount } from './shared/types';
import type { Organization } from './organization';

export const globalSections = ['Publishers', 'Agencies', 'Releases', 'Prebid builds', 'API integracije', 'Audit log', 'Settings'] as const;
export const siteTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Test page', 'Export', 'Mockup', 'Monitoring', 'Debug', 'Ads.txt'] as const;
export type GlobalSection = (typeof globalSections)[number];
export type PublisherTab = (typeof siteTabs)[number];
const sectionKeys = ['publishers', 'agencies', 'releases', 'prebid-builds', 'integrations', 'audit-log', 'settings'];
const tabKeys = ['overview', 'config', 'prebid', 'releases', 'test-page', 'export', 'mockup', 'monitoring', 'debug', 'ads-txt'];
const keys = ['section', 'publisher', 'site', 'tab', 'agency'] as const;

export type DashboardNavigation = {
  section: GlobalSection;
  publisherId: string | null;
  siteId: string | null;
  tab: PublisherTab;
  agencyFilter: string;
};
export type NavigationRequest = DashboardNavigation & { defaultSelection: boolean; invalid: boolean };
export const emptyNavigation: DashboardNavigation = {section:'Publishers', publisherId:null, siteId:null, tab:'Overview', agencyFilter:'all'};

export function readDashboardNavigation(search: string): NavigationRequest {
  const params = new URLSearchParams(search);
  const section = params.has('section') ? globalSections[sectionKeys.indexOf(params.get('section')!)] : 'Publishers';
  const tab = params.has('tab') ? siteTabs[tabKeys.indexOf(params.get('tab')!)] : 'Overview';
  const invalid = !section || !tab || keys.some(key => params.getAll(key).length > 1 || (params.has(key) && (!params.get(key)?.trim() || params.get(key)!.length > 128)));
  return {...emptyNavigation, section:section ?? 'Publishers', tab:tab ?? 'Overview', publisherId:params.get('publisher'), siteId:params.get('site'), agencyFilter:params.get('agency') ?? 'all', invalid, defaultSelection:!keys.some(key => params.has(key))};
}

export function dashboardURL(current: string, navigation: DashboardNavigation): string {
  const url = new URL(current);
  for (const key of keys) url.searchParams.delete(key);
  url.searchParams.set('section', sectionKeys[globalSections.indexOf(navigation.section)]);
  if (navigation.publisherId) url.searchParams.set('publisher', navigation.publisherId);
  if (navigation.siteId) url.searchParams.set('site', navigation.siteId);
  url.searchParams.set('tab', tabKeys[siteTabs.indexOf(navigation.tab)]);
  if (navigation.agencyFilter !== 'all') url.searchParams.set('agency', navigation.agencyFilter);
  return url.pathname + url.search + url.hash;
}

export function resolveDashboardNavigation(request: NavigationRequest, publishers: PublisherAccount[], organization: Organization) {
  let navigation: DashboardNavigation = {...request};
  const unavailable = (error: string) => ({navigation:{...emptyNavigation, section:navigation.section}, publisher:null, site:null, error});
  if (request.invalid) return unavailable('This dashboard link is invalid.');
  if (!['all','none'].includes(request.agencyFilter) && !organization.agencies.some(agency => agency.id === request.agencyFilter)) {
    return unavailable('The agency in this link is no longer available.');
  }
  if (request.defaultSelection) {
    const first = publishers[0];
    navigation = {...navigation, publisherId:first?.id ?? null, siteId:first?.sites[0]?.id ?? null};
  }
  const siteOwner = navigation.siteId ? publishers.find(account => account.sites.some(site => site.id === navigation.siteId)) : null;
  if (navigation.siteId && !siteOwner) return unavailable('The site in this link is no longer available.');
  if (siteOwner && navigation.publisherId && siteOwner.id !== navigation.publisherId) {
    return unavailable('The site in this link no longer belongs to this publisher.');
  }
  const publisher = siteOwner ?? publishers.find(account => account.id === navigation.publisherId) ?? null;
  if (navigation.publisherId && !publisher) return unavailable('The publisher in this link is no longer available.');
  const agencyId = organization.memberships.find(member => member.publisherId === publisher?.id)?.agencyId ?? 'none';
  if (publisher && navigation.agencyFilter !== 'all' && navigation.agencyFilter !== agencyId) {
    return unavailable('The selected site or publisher is outside this agency filter.');
  }
  const site = publisher?.sites.find(item => item.id === navigation.siteId) ?? null;
  if (!site && navigation.tab !== 'Overview') return unavailable('This site section needs a selected site.');
  navigation = {...navigation, publisherId:publisher?.id ?? null};
  return {navigation, publisher, site, error:null};
}
