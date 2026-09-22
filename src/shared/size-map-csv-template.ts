import sizeMaps from '../../shared/inventory/size-maps.json' with { type: 'json' };

export const sizeMapsTemplateCsv = [
  'name,minWidth,minHeight,sizes',
  ...Object.entries(sizeMaps).flatMap(([name, breakpoints]) =>
    breakpoints.map(({ minViewPort, sizes }) => [
      name,
      ...minViewPort,
      sizes.map((size) => Array.isArray(size) ? size.join('x') : size).join('|'),
    ].join(',')),
  ),
].join('\n');
