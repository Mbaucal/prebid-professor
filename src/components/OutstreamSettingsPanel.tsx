import {useEffect,useRef,useState} from 'react';
type Settings={format:'banner'|'outstream'|'banner-outstream';playerSize?:number[];playerSizing?:'size-map';playerSizes?:Record<string,number[]>;minDuration?:number;maxDuration?:number;playbackMethod?:number;placement?:number;plcmt?:number;partner?:{bidder:string;adapter:string;outstreamAU:string;activationConfirmed:boolean};cacheUrl?:string};
type SizeRow={key:string;viewport:[number,number];disabled:boolean;sizes:number[][]};
type SizeMap={name:string;rows:SizeRow[]};
type Payload={revision:string;outstream:{schemaVersion:1;units:Record<string,Settings>};prebidVersion:string|null;modules:string[];bidders:{bidder:string;enabled:boolean}[];enablePrebid:boolean;runtimeEligible:boolean;responsiveSizing?:boolean;sizeMaps?:Record<string,{maps?:SizeMap[];error?:string}>};
const equalSize=(a:number[]|undefined,b:number[])=>a?.length===2&&a.every((value,index)=>value===b[index]);
const sizeLabel=(size:number[])=>size.join(' × ');
const rowLabel=(map:SizeMap,row:SizeRow)=>`${map.name} · from ${row.viewport[0]}px wide${row.viewport[1]?` / ${row.viewport[1]}px high`:''}`;
const defaults:Settings={format:'banner',playerSize:[640,360],minDuration:5,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'',activationConfirmed:false},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'};
export default function OutstreamSettingsPanel({publisherId,code,onClose,onSaved,endpoint,onOpenSizeMaps}:{publisherId:string;code:string;onClose:()=>void;onSaved:()=>void;endpoint?:string;onOpenSizeMaps?:()=>void}) {
  const dialog=useRef<HTMLElement>(null),[data,setData]=useState<Payload|null>(null),[draft,setDraft]=useState<Settings>(defaults),[busy,setBusy]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  const alive=useRef(true),feedback=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(error||message){feedback.current?.scrollIntoView({block:'center'});feedback.current?.focus();}},[error,message]);
  useEffect(()=>{alive.current=true;const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>{alive.current=false;previous?.focus();};},[]);
  async function request(body?:unknown){const response=await fetch(endpoint??`/api/publishers/${encodeURIComponent(publisherId)}/outstream-settings`,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const value=await response.json() as Payload&{error?:string};if(!response.ok)throw Error(value.error||'Could not load format settings.');return value;}
  function accept(value:Payload){
    setData(value);const saved=value.outstream.units[code];
    const next={...defaults,...saved,partner:{...defaults.partner!,...saved?.partner}};
    if(saved?.playerSizing==='size-map'||value.responsiveSizing&&(!saved||saved.format==='banner')){
      const {playerSize,...rest}=next;setDraft({...rest,playerSizing:'size-map',playerSizes:saved?.playerSizes??{}});
    }else setDraft(next);
  }
  async function load(){setBusy(true);setError('');setMessage('');try{const value=await request();if(alive.current)accept(value);}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
  useEffect(()=>{void load();},[publisherId,code,endpoint]);
  function videoSettings():Settings{
    if(draft.playerSizing!=='size-map')return draft;
    const {playerSize,...settings}=draft;
    const choices=Object.fromEntries((data?.sizeMaps?.[code]?.maps??[]).flatMap(map=>map.rows).filter(row=>!row.disabled&&row.sizes.length>1).map(row=>[row.key,draft.playerSizes?.[row.key]]).filter((entry):entry is [string,number[]]=>Array.isArray(entry[1])));
    return {...settings,playerSizes:choices};
  }
  async function save(){if(!data)return;setBusy(true);setError('');setMessage('');try{const units={...data.outstream.units,[code]:draft.format==='banner'?{format:'banner' as const}:videoSettings()};const value=await request({revision:data.revision,outstream:{schemaVersion:1,units}});if(alive.current){accept(value);setMessage('Saved for the next revenue preview release. Existing scripts are unchanged.');onSaved();}}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
  const video=draft.format!=='banner',available=data?.enablePrebid&&data.prebidVersion==='11.34.0'&&data.modules.includes('pubmaticBidAdapter')&&data.bidders.some(b=>b.bidder==='pubmatic'&&b.enabled);
  const responsive=draft.playerSizing==='size-map',sizeMap=data?.sizeMaps?.[code],maps=sizeMap?.maps??[];
  const rows=maps.flatMap(map=>map.rows),enabledRows=rows.filter(row=>!row.disabled);
  const sizingIssue=responsive?(sizeMap?.error||(!enabledRows.length?'Enable at least one breakpoint in this position’s size map.':enabledRows.some(row=>!row.sizes.length)?'Add a video size to the marked size-map rows. Both width and height must be between 144 and 1920px. Sizes such as 728 × 90 and fluid remain available for banners.':null)):null;
  const missingChoice=responsive&&enabledRows.some(row=>row.sizes.length>1&&!row.sizes.some(size=>equalSize(draft.playerSizes?.[row.key],size)));
  function useSizeMap(){
    const choices=Object.fromEntries(rows.filter(row=>!row.disabled&&row.sizes.length>1&&row.sizes.some(size=>equalSize(draft.playerSize,size))).map(row=>[row.key,draft.playerSize!]));
    const {playerSize,...rest}=draft;setDraft({...rest,playerSizing:'size-map',playerSizes:choices});setMessage('');
  }
  const update=(value:Partial<Settings>)=>{setDraft(current=>({...current,...value}));setMessage('');};
  return <div className="modal-backdrop"><section ref={dialog} tabIndex={-1} className="modal-card ad-unit-modal" role="dialog" aria-modal="true" aria-labelledby="outstream-heading" onKeyDown={event=>{
    if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
    if(event.key==='Tab'){const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')??[]);const first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  }}>
    <div className="modal-heading"><div><span className="panel-kicker">Ad position</span><h2 id="outstream-heading">Formats · {code}</h2></div><button className="icon-button" disabled={busy} aria-label="Close format settings" onClick={onClose}>×</button></div>
    <div className="publisher-form" style={{gridTemplateColumns:'minmax(0,1fr)'}}>
      {busy?<p role="status">{data?'Saving format settings…':'Loading format settings…'}</p>:null}
      {error?<p ref={feedback} tabIndex={-1} className="form-error" role="alert">{error}</p>:null}{message?<p ref={feedback} tabIndex={-1} role="status">{message}</p>:null}
      {data?<>
        <label><span>Ad format</span><select aria-label="Ad format" value={draft.format} disabled={busy} onChange={e=>update({format:e.target.value as Settings['format']})}><option value="banner">Banner</option><option value="outstream">Outstream</option><option value="banner-outstream">Banner + Outstream</option></select></label>
        <p>Banner sizes, size map and partner parameters remain saved when you change this choice.</p>
        {!data.runtimeEligible?<p>Serving requires the explicitly selected 3.16 revenue preview runtime. Older generators cannot apply enabled video settings.</p>:null}
        {video?<>
          {!available?<p className="form-error" role="alert">Enable PubMatic and the checked Prebid 11.34.0 build before saving video settings.</p>:null}
          {responsive?<>
            <div><h3>Player sizes from size maps</h3><p>Each screen width uses its saved size-map row. A single video size is selected automatically. If a row has several video sizes, choose one below.</p></div>
            {maps.map(map=><div className="form-options" key={map.name} style={{minWidth:0,overflowWrap:'anywhere'}}><strong>Size map: {map.name}</strong>{map.rows.map(row=><div key={row.key}>
              {row.disabled?<p><strong>{rowLabel(map,row)}</strong><br/>Ads disabled at this breakpoint.</p>:row.sizes.length===1?<p><strong>{rowLabel(map,row)}</strong><br/>{sizeLabel(row.sizes[0])} px · Automatic</p>:row.sizes.length>1?<label><span>Video size · {rowLabel(map,row)}</span><select disabled={busy} value={row.sizes.some(size=>equalSize(draft.playerSizes?.[row.key],size))?draft.playerSizes?.[row.key]?.join('x'):''} onChange={event=>{const choices={...draft.playerSizes};if(event.target.value)choices[row.key]=event.target.value.split('x').map(Number);else delete choices[row.key];update({playerSizes:choices});}}><option value="">Choose a video size</option>{row.sizes.map(size=><option key={size.join('x')} value={size.join('x')}>{sizeLabel(size)} px</option>)}</select></label>:<p className="form-error"><strong>{rowLabel(map,row)}</strong><br/>No video size available in this row.</p>}
            </div>)}</div>)}
            {sizingIssue?<p className="form-error" role="alert">{sizingIssue}</p>:null}
            {missingChoice?<p>Choose a video size for each row with several options before saving.</p>:null}
            {endpoint?.startsWith('/test-api/')?<a href="/site-settings#maps" aria-disabled={busy} onClick={event=>{if(busy)event.preventDefault();}}>Open size maps</a>:onOpenSizeMaps?<button className="button secondary" disabled={busy} onClick={onOpenSizeMaps}>Open size maps</button>:<p>To edit these dimensions, close Formats and open Size maps for this site.</p>}
          </>:<>
            <label><span>Player width (px)</span><input type="number" min={144} max={1920} disabled={busy} value={draft.playerSize?.[0]??640} onChange={e=>update({playerSize:[Number(e.target.value),draft.playerSize?.[1]??360]})}/></label>
            <label><span>Player height (px)</span><input type="number" min={144} max={1920} disabled={busy} value={draft.playerSize?.[1]??360} onChange={e=>update({playerSize:[draft.playerSize?.[0]??640,Number(e.target.value)]})}/></label>
            <p>This fixed player size must appear in the size map at every enabled breakpoint.</p>
            {data.responsiveSizing?<div className="form-options"><p>This position has a saved fixed player size. Use its size map to choose different video sizes for mobile and desktop. The change applies when you save.</p><button className="button secondary" disabled={busy} onClick={useSizeMap}>Use size map</button></div>:<p>To use different video sizes per breakpoint, select script version 3.16.0-revenue.preview.3 in Script setup.</p>}
          </>}
          <label><span>Minimum duration (seconds)</span><input type="number" min={1} max={120} disabled={busy} value={draft.minDuration??5} onChange={e=>update({minDuration:Number(e.target.value)})}/></label>
          <label><span>Maximum duration (seconds)</span><input type="number" min={1} max={120} disabled={busy} value={draft.maxDuration??30} onChange={e=>update({maxDuration:Number(e.target.value)})}/></label>
          <p>Muted autoplay · standalone outstream. PubMatic's bid renderer runs only when its creative wins in GAM. Automatic refresh is disabled for this position.</p>
          <label><span>PubMatic outstream renderer ID</span><input disabled={busy} value={draft.partner?.outstreamAU??''} onChange={e=>update({partner:{...draft.partner!,outstreamAU:e.target.value}})}/></label>
          <label className="check-row"><input type="checkbox" disabled={busy} checked={draft.partner?.activationConfirmed??false} onChange={e=>update({partner:{...draft.partner!,activationConfirmed:e.target.checked}})}/><span>PubMatic confirmed this placement is activated for outstream.</span></label>
          <p>Uses Prebid VAST cache. This is separate from bid reuse. GAM needs a compatible Prebid Universal Creative in a regular iframe; SafeFrame video is not supported in this pilot. Player end, close and layout behavior still require partner verification before a live rollout.</p>
        </>:null}
        <button className="button primary" disabled={busy||(video&&(!available||!draft.partner?.activationConfirmed||!draft.partner.outstreamAU.trim()||!!sizingIssue||missingChoice))} onClick={()=>void save()}>Save format settings</button>
      </>:null}
      {error?<button className="button secondary" disabled={busy} onClick={()=>void load()}>Reload format settings</button>:null}
    </div>
  </section></div>;
}
