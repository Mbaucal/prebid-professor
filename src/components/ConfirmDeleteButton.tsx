import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import './confirm-delete.css';

/** No is the initial focus. Opening, Escape and backdrop clicks never mutate data. */
export default function ConfirmDeleteButton({name,description,onConfirm,disabled=false,label='Delete'}:{
  name:string;description:string;onConfirm:()=>Promise<void>;disabled?:boolean;label?:string;
}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),lock=useRef(false),id=useId();
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  function close(){if(lock.current)return;dialog.current?.close();setOpen(false);trigger.current?.focus();}
  async function confirm(){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{await onConfirm();lock.current=false;close();}
    catch(e){setError(e instanceof Error?e.message:'Could not delete. Please retry.');}
    finally{lock.current=false;setBusy(false);}
  }
  return <><button ref={trigger} type="button" className="button danger" disabled={disabled||busy}
    onClick={()=>{setError('');setOpen(true);}}>{label}</button>
    {open?createPortal(<dialog ref={dialog} className="confirm-delete" aria-labelledby={id+'-title'} aria-describedby={id+'-description'}
      onCancel={e=>{e.preventDefault();close();}} onClose={()=>{if(!lock.current)setOpen(false);}}
      onClick={e=>{if(e.target===e.currentTarget)close();}}>
      <div><h2 id={id+'-title'}>Are you sure?</h2><p className="confirm-delete-name">{name}</p><p id={id+'-description'}>{description}</p>
      {error?<p role="alert">{error}</p>:null}
      <div className="confirm-delete-actions"><button type="button" className="button secondary" autoFocus disabled={busy} onClick={close}>No</button>
      <button type="button" className="button danger" disabled={busy} onClick={()=>void confirm()}>{busy?'Deleting…':'Yes'}</button></div></div>
    </dialog>,document.body):null}</>;
}
