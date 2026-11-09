type CreativeSize = readonly [number, number] | 'fluid';

/** A standard slot's CSS reservation, not a browser-height condition or a creative limit. */
export function reservedHeightSummary(sizes: readonly CreativeSize[]) {
  const heightPx = sizes.reduce((height, size) => size === 'fluid' ? height : Math.max(height, size[1]), 0);
  const hasFluid = sizes.includes('fluid');
  const disabled = sizes.length === 0;
  const label = disabled ? '0px · no ad' : `${heightPx}px${hasFluid ? ' · fluid varies' : ''}`;
  const detail = disabled
    ? 'This breakpoint requests no ad and needs no reserved space.'
    : hasFluid
      ? `${heightPx ? 'The largest fixed size sets the reservation. ' : 'No fixed size sets a reservation. '}Fluid content has a variable height; this is not a maximum creative height.`
      : 'Derived from the tallest fixed size. This reserves space; it does not limit creative height.';
  return { heightPx, hasFluid, disabled, label, detail };
}
