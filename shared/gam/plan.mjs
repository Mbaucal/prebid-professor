export class GamError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
export function text(value, label, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f]/.test(value)) throw new GamError(`${label}: unesite ispravnu vrednost (do ${max} znakova).`);
  return value.trim();
}
export function numericId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) throw new GamError('Neispravan GAM ID ili network code.');
  return value;
}
export function unitCode(value) {
  const code = text(value, 'Code', 100);
  if (!/^[A-Za-z0-9_.:-]+$/.test(code)) throw new GamError('Code: koristite slova, brojeve, tačku, crticu, donju crtu ili dvotačku.');
  return code;
}
export function parseSizes(value) {
  if (typeof value !== 'string' || value.length > 3000) throw new GamError('Unesite veličine, npr. 300x250; 300x600; Fluid.');
  const sizes = [], seen = new Set(); let fluid = false;
  for (const token of value.split(/[;,\n]/).map(x => x.trim()).filter(Boolean)) {
    if (/^fluid$/i.test(token)) { fluid = true; continue; }
    const m = token.match(/^([1-9]\d{0,3})\s*[x×]\s*([1-9]\d{0,3})$/i);
    if (!m) throw new GamError(`Neispravna veličina: ${token.slice(0,40)}.`);
    const size = `${Number(m[1])}x${Number(m[2])}`;
    if (!seen.has(size)) { seen.add(size); sizes.push({ width:Number(m[1]), height:Number(m[2]) }); }
  }
  if (!sizes.length && !fluid) throw new GamError('Dodajte bar jednu veličinu ili Fluid.');
  if (sizes.length > 50) throw new GamError('Najviše 50 veličina po poziciji.');
  return { sizes, fluid, label:[...sizes.map(s => `${s.width}x${s.height}`), ...(fluid ? ['Fluid'] : [])].join('; ') };
}
export function expandGroup(group) {
  const count = Number(group.count), start = Number(group.start);
  if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(start) || start < 1 || start > 1000) throw new GamError('Količina: 1–100; početni broj: 1–1000.');
  const names = group.names?.trim() ? group.names.split('\n').map(x => x.trim()).filter(Boolean) : null;
  if (names?.length > 100) throw new GamError('Najviše 100 naziva po unosu.');
  if (!names && count > 1 && !group.pattern.includes('{n}')) throw new GamError('Za više pozicija dodajte {n} u naziv, npr. Billboard_{n}.');
  const parsed = parseSizes(group.sizes);
  return (names || Array.from({length:count},(_,i) => group.pattern.replaceAll('{n}', String(start+i)))).map((name,i) => ({
    name:text(name,'Naziv'), code:unitCode(name), sizes:parsed.label,
    description:String(group.description || '').replaceAll('{n}',String(start+i)).replaceAll('{pos}',name),
  }));
}
export function normalizePlan(value) {
  if (!value || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 100) throw new GamError('Izaberite između 1 i 100 ad unita.');
  const networkCode = numericId(value.networkCode);
  const p = value.parent;
  if (!p || !['existing','new'].includes(p.mode)) throw new GamError('Izaberite postojeći ili novi parent.');
  const parent = p.mode === 'existing' ? {mode:'existing',id:numericId(p.id)} : {mode:'new',name:text(p.name,'Parent naziv'),code:unitCode(p.code)};
  const codes = new Set(), names = new Set();
  const rows = value.rows.map(r => {
    const name = text(r.name,'Naziv'), code = unitCode(r.code), sizes = parseSizes(r.sizes).label;
    if (codes.has(code.toLowerCase()) || names.has(name.toLowerCase())) throw new GamError(`Dupliran naziv ili code: ${code}.`);
    codes.add(code.toLowerCase()); names.add(name.toLowerCase());
    const description = typeof r.description === 'string' ? r.description : '';
    if (description.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(description)) throw new GamError('Opis je predugačak ili sadrži nedozvoljene znakove.');
    return {name,code,sizes,description};
  });
  return {networkCode,parent,rows,siteLabel:typeof value.siteLabel==='string'?value.siteLabel.trim().slice(0,255):''};
}
export function compareRows(rows, existing) {
  return rows.map(row => {
    const matches = existing.filter(x => x.code.toLowerCase() === row.code.toLowerCase());
    const byName = existing.find(x => x.name.toLowerCase() === row.name.toLowerCase());
    if (matches.length > 1 || (!matches.length && byName)) return {...row,state:'conflict',message:'Naziv ili code je već zauzet.'};
    const found = matches[0];
    if (!found) return {...row,state:'new'};
    if (found.code !== row.code || found.name !== row.name || found.status !== 'ACTIVE') return {...row,state:'conflict',existing:found,message:'Postojeći ad unit ima drugi naziv, code ili nije aktivan.'};
    const expected = parseSizes(row.sizes);
    const actual = [...found.sizes].map(s=>`${s.width}x${s.height}`).sort().join(';');
    const requested = expected.sizes.map(s=>`${s.width}x${s.height}`).sort().join(';');
    const differences = [];
    if (actual !== requested || found.fluid !== expected.fluid) differences.push('veličine');
    if ((found.description || '') !== row.description) differences.push('opis');
    return {...row,state:'existing',existing:found,differences};
  });
}
