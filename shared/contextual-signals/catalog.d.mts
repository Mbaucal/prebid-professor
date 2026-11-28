export type ContextualTaxonomy = 'iab-content-2.2' | 'iab-content-3.0';
export const CONTEXTUAL_TAXONOMIES: {
  id: ContextualTaxonomy;
  label: string;
  segtax: number;
  sourceSha256: string;
  categories: {id: string; name: string; sensitive: boolean}[];
}[];
