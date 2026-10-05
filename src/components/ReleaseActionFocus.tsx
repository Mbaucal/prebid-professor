import './release-action-focus.css';
import {useEffect,useRef,useState,type ReactNode} from 'react';
export type ReleaseActionRequest={siteId:string;sequence:number;action:'generate'|'publish'};
/** Navigation only: never activates an action, changes form state or writes a release. */
export default function ReleaseActionFocus({request,siteId,children}:{request:ReleaseActionRequest|null;siteId:string;children:ReactNode}){
 const root=useRef<HTMLDivElement>(null),[message,setMessage]=useState('');
 useEffect(()=>{
  setMessage('');if(!request || request.siteId!==siteId || !root.current)return;
  const node=root.current;let done=false,previous:Element|null=null;
  const focus=(target:HTMLElement|null,text:string)=>{
   setMessage(text);if(target && target!==previous){previous=target;target.focus({preventScroll:true});target.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
  };
  const check=()=>{
   if(done)return;
   if(node.querySelector('[data-release-loading]')){focus(node,'Loading the release workflow…');return;}
   const error=node.querySelector<HTMLElement>('[data-release-retry]');
   if(error){focus(error,'Release details could not load. Retry to continue.');return;}
   if(node.querySelector('[data-release-busy]')){focus(node,'A release action is in progress. Your next step will be shown when it finishes.');return;}
   const enabled=(name:string)=>node.querySelector<HTMLElement>(`[data-release-target="${name}"]:not(:disabled)`);
   const generate=enabled('generate'),setup=enabled('setup'),blocked=enabled('blocked'),preview=enabled('preview'),testOnly=!!node.querySelector('[data-release-test-only]');
   if(request.action==='generate')focus(blocked||setup||generate||node,blocked?'Resolve the release error below before generating a package.':setup?'Complete script setup before generating a package.':'Review your settings and release note, then generate a saved package.');
   else {
    const publish=enabled('publish'),stage=enabled('stage');
    focus(publish||stage||preview||blocked||setup||generate||node,publish?'Review the staged package, then publish when ready.':stage?'No package is staged. Stage a saved package before publishing.':preview?'Use TEST deployments to preview this saved package.':blocked?'Resolve the release error below before continuing.':setup?'Complete script setup, then generate a saved package.':testOnly?'Generate a saved package, then use TEST deployments for preview delivery.':'No package is ready to publish. Generate a saved package, then stage it.');
   }
   done=true;
  };
  const observer=new MutationObserver(check);observer.observe(node,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','data-release-loading','data-release-busy']});check();
  return()=>observer.disconnect();
 },[request,siteId]);
 return <div className="release-action-navigation" ref={root} tabIndex={-1} aria-label="Release workflow">{message?<p className="runtime-message" role="status">{message}</p>:null}{children}</div>;
}
