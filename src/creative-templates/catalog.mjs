/** Native GAM UI import format (formatter/variableType, not SOAP snippet/xsi:type).
 * Structure checked against the vendor's published GAM export, 2026-09-22:
 * https://cdn.jeengapis.com/gam/templates/jeeng-native-2.0.zip
 * All creative code below is original Tessera code. No network/account IDs. */
export const TEMPLATE_VERSION = '1.0.0';
export const CREATIVE_RUNTIME_VERSION = '3.11.0-tessera.preview.1';
export const templates = [
  {id:'image',name:'Image banner',summary:'Jedna slika u standardnom oglasnom slotu.',kind:'standard',size:'300 × 250',defaults:{width:300,height:250},fields:['width','height'],safeFrame:true},
  {id:'responsive',name:'Responsive image',summary:'Slika se prilagođava širini slota. Opciono druga slika za uži slot.',kind:'standard',size:'Prilagodljiv',defaults:{width:970,height:250,breakpoint:600},fields:['width','height','breakpoint'],safeFrame:true},
  {id:'incorner',name:'InCorner',summary:'Oglas u donjem uglu sa jednim X, bez prazne sticky trake.',kind:'overlay',size:'300 × 250',defaults:{width:300,height:250,side:'right',offset:16,minViewport:0},fields:['width','height','side','offset','minViewport'],safeFrame:false},
  {id:'branding',name:'Side branding',summary:'Levi ili desni bočni oglas, prikazan kada ima dovoljno mesta uz sadržaj.',kind:'overlay',size:'160 × 600',defaults:{width:160,height:600,side:'left',offset:16,minViewport:1366,contentWidth:1000},fields:['width','height','side','offset','minViewport','contentWidth'],safeFrame:false},
];
export function getTemplate(id){const template=templates.find(t=>t.id===id);if(!template)throw Error('Nepoznat šablon.');return template;}
export function normalizeOptions(id,options={}){
  const template=getTemplate(id),out={...template.defaults};
  for(const [key,value] of Object.entries(options)){
    if(!template.fields.includes(key))throw Error('Nepoznato podešavanje šablona.');
    if(key==='side'){if(!['left','right'].includes(value))throw Error('Izaberite levu ili desnu stranu.');out[key]=value;continue;}
    const range=key==='width'||key==='height'?[1,2000]:key==='offset'?[0,100]:[0,4000];
    if(typeof value!=='number'||!Number.isInteger(value)||value<range[0]||value>range[1])throw Error(`${key}: unesite ceo broj ${range[0]}–${range[1]}.`);
    out[key]=value;
  }
  return out;
}
const variable=(name,type,description,required=true,extra={})=>({label:name,uniqueName:name,description,isRequired:required,variableType:type,...extra});
const asset=(name,description,required=true)=>variable(name,'ASSET',description,required,{mimeTypes:['PNG','GIF','JPG']});
const url=(name,description)=>variable(name,'URL',description,true,{sampleValue:'https://example.com/campaign',isTrackingUrl:false,urlType:'STANDARD_HTTP'});
// Each GAM macro appears once. URI_ENCODE protects JS strings, including quotes,
// backslashes and </script>. Decode custom fields only after substitution.
function creativeSource(id,options){
  const overlay=getTemplate(id).kind==='overlay';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;overflow:hidden}img{border:0;display:block}a{display:block}</style></head><body><script>
(function(){'use strict';
var image=decodeURIComponent("[%URI_ENCODE:Image%]");
var landing=decodeURIComponent("[%URI_ENCODE:ClickURL%]");
var alt=decodeURIComponent("[%URI_ENCODE:AltText%]")||'Advertisement';
var clickPrefix=decodeURIComponent("%%CLICK_URL_ESC%%");
var cfg=${JSON.stringify({...options,kind:id})};
function https(value){try{return new URL(value).protocol==='https:';}catch(_){return false;}}
if(!https(image)||!https(landing))return;
cfg.image=image;cfg.click=clickPrefix+landing;cfg.alt=alt;
${overlay?`// Friendly iframe + Tessera 3.11 is required. SafeFrame is deliberately off.
// Fail closed if the matching publisher runtime is absent; never create a second X.
var p=window;
for(var i=0;i<10;i++){
 try{if(p.__tesseraCreativesV1){p.__tesseraCreativesV1.mount(window,cfg);return;}if(p===p.parent)break;p=p.parent;}catch(_){break;}
}
console.warn('Tessera ${id}: select script version ${CREATIVE_RUNTIME_VERSION} and disable SafeFrame for this creative.');`:`var link=document.createElement('a'),img=document.createElement('img');
link.href=cfg.click;link.target='_blank';link.rel='noopener noreferrer';
img.alt=alt;img.width=cfg.width;img.height=cfg.height;
${id==='responsive'?`var small=decodeURIComponent("[%URI_ENCODE:MobileImage%]");
img.style.width='100%';img.style.maxWidth=cfg.width+'px';img.style.height='auto';
function resize(){var next=window.innerWidth<=cfg.breakpoint&&https(small)?small:image;if(img.getAttribute('src')!==next)img.src=next;}
window.addEventListener('resize',resize);resize();`:`img.src=image;`}
link.appendChild(img);document.body.appendChild(link);`}
})();
</script></body></html>`;
}
export function gamTemplate(id,options={}){
  const template=getTemplate(id),normalized=normalizeOptions(id,options);
  return {name:`Tessera ${template.name} v${TEMPLATE_VERSION}`,description:`${template.summary} ${template.kind==='overlay'?`Requires Tessera ${CREATIVE_RUNTIME_VERSION}; friendly iframe; standard display creative, not Out-of-page.`:'Standard display creative; GAM click tracking included.'}`,
    variables:[asset('Image','Slika oglasa (HTTPS nakon GAM uploada).'),url('ClickURL','Odredišna HTTPS adresa kampanje.'),variable('AltText','STRING','Opis slike za čitače ekrana.',false),...(id==='responsive'?[asset('MobileImage','Opciona slika za uži slot.',false)]:[])],
    formatter:creativeSource(id,normalized),omidPartnerName:'',type:'USER_DEFINED',isInterstitial:false,isNativeEligible:false,isNativeVideoEligible:false,isSafeFrameCompatible:template.safeFrame};
}
export const exportFilename=id=>`tessera-${getTemplate(id).id}-v${TEMPLATE_VERSION}.json`;
export const exportJson=(id,options={})=>JSON.stringify(gamTemplate(id,options),null,2)+'\n';
export function instructions(id,options={}){
 const t=getTemplate(id),o=normalizeOptions(id,options);
 return `Tessera ${t.name} v${TEMPLATE_VERSION}\n\n1. GAM: Delivery → Creatives → Creative templates → New creative template → Import.\n2. Izaberite ${exportFilename(id)}, zatim Submit i Save. JSON fajl je šablon, a ZIP je samo paket fajlova; raspakujte ga pre uvoza.\n3. Napravite creative za oglašivača, izaberite Custom creative template i ovaj šablon. Dodajte Image i HTTPS ClickURL, opciono AltText${id==='responsive'?' i MobileImage':''}.\n4. Koristite standardnu display veličinu koju postojeći slot i size map zaista traže. Nemojte birati Out-of-page.\n${t.kind==='overlay'?`5. U Tesseri izaberite skriptu ${CREATIVE_RUNTIME_VERSION}, generišite paket i prvo proverite na test stranici. U GAM-u isključite SafeFrame za ovaj creative.\n6. ${id==='incorner'?'Targetirajte sticky ad unit. Creative može biti npr. 320x50 ako je to dozvoljena veličina sticky slota; vidljivi InCorner koristi dimenzije iz ovog šablona. Nije potrebno dodavati 1x1 u mapu. Sticky traka i njen X se uklanjaju tek kada šablon preuzme prikaz.':'Targetirajte odgovarajući Branding_Left ili Branding_Right ad unit. Koristite size map sa praznim veličinama ispod minimalnog viewport-a da se oglas tada ne traži.'}\n7. ${id==='incorner'?'Zatvaranje gasi InCorner i sticky za ostatak stranice; nema automatskog osvežavanja dok je prikazan.':'Prikaz se sklanja ako nema mesta uz centralni sadržaj. Šablon ne menja drugi, sticky oglas.'}\n`:`5. SafeFrame može ostati uključen. ${id==='responsive'?'Izbor MobileImage zavisi od širine samog slota/iframe-a, a ne cele stranice. Šablon ne menja GAM size map.':''}\n`}\nIzabrana podešavanja: ${JSON.stringify(o)}\n\nUvoz šablona ne kreira order, line item niti kampanju. Ovo je verzionisani test kandidat; stvarni GAM uvoz i isporuku proveriti u svojoj mreži pre aktivacije. Novi export uvozite kao novi šablon ako menjate ponašanje postojećih kampanja.\n`;
}
