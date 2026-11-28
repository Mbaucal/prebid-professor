import {useEffect,useRef,useState} from 'react';

const A='original-source-4cd44c2fb51e614be765b55dc2735b4eacd91aa18edf55d00ea1c516c279eb3b';
const B='original-source-d45ed2bc5009fd04b8fccd43f76089e26f8bb081b9704f8b867092a8fcf42b26';
type Props={disabled:boolean;onSaved:(a:string,b:string)=>void|Promise<void>};
export default function OriginalScriptSources({disabled,onSaved}:Props){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const active=useRef(true),lock=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function save(){
    if(lock.current||disabled)return;lock.current=true;setBusy(true);setError('');setMessage('Verifying and saving the two original scripts…');
    try{
      const response=await fetch('/api/publishers/politika/ab-tests/original-sources',{method:'POST',credentials:'same-origin',cache:'no-store'});
      const body=await response.json() as {error?:string;versions?:{id:string;state:string}[]};
      if(!response.ok)throw Error(body.error||'The original scripts could not be saved. Retry.');
      if(![A,B].every(id=>body.versions?.some(v=>v.id===id&&v.state==='stored')))throw Error('The save could not be confirmed. Retry to finish the same save.');
      if(!active.current)return;
      await onSaved(A,B);
      if(active.current)setMessage('Both original scripts are saved and selected as A and B below. Enter a test name and check compatibility.');
    }catch(failure){if(active.current){setMessage('');setError(failure instanceof Error?failure.message:'The save could not be confirmed. Retry to finish the same save.');}}
    finally{lock.current=false;if(active.current)setBusy(false);}
  }
  return <section aria-label="Original Politika scripts" className="ab-original-sources">
    <h3>Original Politika A/B scripts</h3>
    <p>Save the exact files from the 17 November 2026 deployment. This keeps their original code and does not generate a replacement from the current Config.</p>
    <ul><li><strong>A — original, cache off</strong> · build 20260813_125447</li>
      <li><strong>B — 3.25.0, cache on</strong> · build 20261117_111338</li></ul>
    <p className="ab-tests-help">These scripts keep the existing page, CMP, GPT and Prebid setup. The test compares all changes between the versions. Saving them does not publish a test.</p>
    <button type="button" disabled={disabled||busy} onClick={()=>void save()}>{busy?'Saving original scripts…':'Save original A and B'}</button>
    {message?<p role="status" className="ab-tests-status">{message}</p>:null}
    {error?<p role="alert" className="runtime-error">{error}</p>:null}
  </section>;
}
