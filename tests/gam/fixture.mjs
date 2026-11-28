import { parseSizes } from '../../shared/gam/plan.mjs';
export class MemoryBucket {
  data=new Map();
  async get(key){const v=this.data.get(key);return v?{etag:v.etag,json:async()=>JSON.parse(v.body)}:null;}
  async put(key,body,options={}){if(options.onlyIf?.etagMatches&&this.data.get(key)?.etag!==options.onlyIf.etagMatches)return null;if(options.onlyIf?.etagDoesNotMatch==='*'&&this.data.has(key))return null;const etag=crypto.randomUUID();this.data.set(key,{body,etag});return {etag};}
  async list({prefix='',limit=1000}={}){return {objects:[...this.data.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(key=>({key})),truncated:false};}
}
export function fixture(){
  const network={networkCode:'123456',name:'GAM sintetička provera',rootId:'1'};
  const units=[{id:'1',parentId:'',name:'Root',code:'root',status:'ACTIVE',description:'',sizes:[],fluid:false,parentPath:[]}];
  const counters={reads:0,creates:0};let failCreate=0;
  const client={
    async network(){counters.reads++;return structuredClone(network);},
    async children(id){counters.reads++;return structuredClone(units.filter(u=>u.parentId===id));},
    async get(id){counters.reads++;const u=units.find(u=>u.id===id);if(!u)throw Error('Missing parent');return structuredClone(u);},
    async create(rows,parentId){
      counters.creates++;if(failCreate===counters.creates)throw Error('Synthetic timeout');
      if(rows.some(r=>units.some(u=>u.parentId===parentId&&u.code===r.code)))throw Error('Duplicate');
      const parent=units.find(u=>u.id===parentId);
      const created=rows.map(r=>{const parsed=r.sizes?parseSizes(r.sizes):{sizes:[],fluid:false};const u={id:String(units.length+1),parentId,name:r.name,code:r.code,status:'ACTIVE',description:r.description||'',sizes:parsed.sizes,fluid:parsed.fluid,parentPath:[...parent.parentPath,{id:parent.id,name:parent.name,code:parent.code}]};units.push(u);return u;});
      return structuredClone(created);
    },
  };
  return {env:{BUILDS:new MemoryBucket(),GAM_CREDENTIALS_KEY:'synthetic-encryption-key-only-for-local-tests'},client,network,units,counters,failOnCreate:n=>{failCreate=n;}};
}
