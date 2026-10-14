// Positions included by the reviewed named-script generator.
export const CACHE_POSITIONS = Object.freeze(['Billboard','Billboard_2','Billboard_3','Branding_Left','Branding_Right',
  ...Array.from({length:8},(_,i)=>`P${i+1}`),...Array.from({length:5},(_,i)=>`InText_${i+1}`),'Sticky']);

export function positionCacheOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length > CACHE_POSITIONS.length
    || Object.entries(value).some(([code,enabled])=>!CACHE_POSITIONS.includes(code)||typeof enabled!=='boolean')) {
    throw Object.assign(Error('Choose bid caching on or off for a supported ad position.'),{status:422});
  }
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
}
export const hasBidCache = settings => settings.enabled || Object.values(settings.positionOverrides ?? {}).some(value=>value===true);
