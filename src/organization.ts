import {useCallback,useEffect,useState} from 'react';
export type Agency={id:string;name:string;logo:string|null;revision:number;createdAt:string;updatedAt:string};
export type Membership={publisherId:string;agencyId:string|null;revision:number};
export type Organization={agencies:Agency[];memberships:Membership[]};
export type OrganizationController=ReturnType<typeof useOrganization>;
export function agencyFor(data:Organization,publisherId?:string){return data.agencies.find(a=>a.id===data.memberships.find(m=>m.publisherId===publisherId)?.agencyId)??null;}
export function inAgency(data:Organization,publisherId:string,filter:string){return filter==='all'||(agencyFor(data,publisherId)?.id??'none')===filter;}
export function useOrganization(endpoint='/api/organization'){
  const [data,setData]=useState<Organization>({agencies:[],memberships:[]});
  const [error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
  const request=useCallback(async(path='',body?:unknown)=>{
    const response=await fetch(endpoint+path,{credentials:'same-origin',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Agency request failed.');
    return result as Organization;
  },[endpoint]);
  const reload=useCallback(async()=>{setLoading(true);try{setData(await request());setError(null);}catch(e){setError((e as Error).message);}finally{setLoading(false);}},[request]);
  useEffect(()=>{void reload();},[reload]);
  async function save(path:string,body:unknown){
    setSaving(true);try{setData(await request(path,body));setError(null);}finally{setSaving(false);}
  }
  return {data,error,loading,saving,reload,save};
}
export async function prepareAgencyLogo(file:File):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024)throw Error('Choose a PNG, JPG or WebP image up to 5 MB.');
  const bitmap=await createImageBitmap(file);
  try{
    const scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');if(!context)throw Error('Logo processing is unavailable.');
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const png=canvas.toDataURL('image/png');if(png.length>174784)throw Error('Choose a simpler or smaller logo.');
    return png;
  }finally{bitmap.close();}
}
