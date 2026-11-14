import maps from './size-maps.json' with {type:'json'};
export const sizeMapDefaults=maps;
export const presetMapKeys={'billboard':'Billboard','branding-left':'Branding_Map','branding-right':'Branding_Map','infeed':'InFeed','intext':'InText','sidebar':'P','sticky':'Sticky','under-article':'Under_Article'};
export const sizeLabel=s=>s==='fluid'?'fluid':s.join('x');
export function mapSizes(name){return [...new Set((maps[name]??[]).flatMap(row=>row.sizes.map(sizeLabel)))].join('; ');}
export function inferMapKey(code){
  return /^(Billboard)(?:_\d+)?$/i.test(code)?'Billboard':/^Sticky(?:_\d+)?$/i.test(code)?'Sticky':/^InFeed(?:_\d+)?$/i.test(code)?'InFeed':/^InText(?:_\d+)?$/i.test(code)?'InText':/^P\d*$/i.test(code)?'P':/^Branding_(Left|Right)(?:_\d+)?$/i.test(code)?'Branding_Map':/^Under_Article(?:_\d+)?$/i.test(code)?'Under_Article':null;
}
export const sizeMapsTemplateCsv=['name,minWidth,minHeight,sizes',...Object.entries(maps).flatMap(([name,rows])=>rows.map(row=>[name,...row.minViewPort,row.sizes.map(sizeLabel).join('|')].join(',')))].join('\n');
const positions=[['Billboard',1,'Billboard','ATF'],['Branding_Left',1,'Branding_Map','ATF'],['Branding_Right',1,'Branding_Map','ATF'],['InFeed_{n}',6,'InFeed','BTF'],['InText_{n}',10,'InText','BTF'],['P{n}',5,'P','BTF'],['Sticky',1,'Sticky','ATF'],['Under_Article_{n}',1,'Under_Article','BTF']];
export const adUnitsTemplateCsv=['code,type,mediaType,sizeMapKey,enabled,sortOrder,notes',...positions.flatMap(([pattern,count,map,type])=>Array.from({length:count},(_,i)=>[pattern.replace('{n}',i+1),type,'banner',map,'true'])).map((r,i)=>[...r,i+1,''].join(','))].join('\n');
