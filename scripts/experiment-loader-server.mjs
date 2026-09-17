// Loopback-only synthetic browser fixture. Never imported or deployed by a Worker.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { experimentFixture, experimentConfig } from '../tests/support/experiment-fixture.mjs';
import { createExperimentDelivery } from '../worker/experiments/delivery.mjs';
const [key,cert]=process.argv.slice(2);
if(!key||!cert)throw Error('Local TLS files required');
const a=await experimentFixture('A',{prebid:true}), b=await experimentFixture('B',{prebid:true});
const cases=new Map();
for(const name of ['a','b','aa','stopped','corrupt','corruptads','blocked','legacy']) {
  const other=name==='aa'?a:b;
  cases.set(name,await createExperimentDelivery(experimentConfig(a,other,{trafficB:name==='a'?0:100,enabled:name!=='stopped'}),
    {[a.descriptor.packageSha256]:a,[other.descriptor.packageSha256]:other}));
}
const marker={'x-tessera-local-fixture':'experiment-loader','cache-control':'no-store'};
createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
  try {
    const path=new URL(req.url,'https://experiment.invalid').pathname;
    if(path==='/health'){res.writeHead(200,marker);res.end('ready');return;}
    const match=path.match(/^\/case\/([a-z]+)(\/.*)?$/),name=match?.[1],tail=match?.[2]||'/';
    if(!cases.has(name)){res.writeHead(404,marker);res.end();return;}
    if(tail==='/') {
      const csp=name==='blocked'?"default-src 'none'; script-src 'nonce-fixture'":"default-src 'none'; script-src 'nonce-fixture' 'strict-dynamic'";
      res.writeHead(200,{...marker,'content-type':'text/html','content-security-policy':csp});
      res.end('<!doctype html><title>Synthetic A/B loader</title><p>Local synthetic verification only</p>'+
        (name==='legacy'?'<script nonce="fixture" src="legacy.js"></script>':'')+
        '<script nonce="fixture" src="ads.js"></script><script nonce="fixture" src="ads.js"></script>');return;
    }
    if(tail==='/legacy.js'){res.writeHead(200,{...marker,'content-type':'application/javascript'});res.end('window.pbjs={legacy:true};');return;}
    const response=cases.get(name).fetch(new Request('https://experiment.invalid'+tail));
    let body=await response.text();
    if((name==='corrupt'&&tail.endsWith('/prebid.js'))||(name==='corruptads'&&tail.startsWith('/releases/')&&tail.endsWith('/ads.js')))body+='/* deliberately tampered */';
    // In this scenario remove the nonce from dynamic scripts via the loader source
    // solely in the local harness, to prove a restrictive CSP fails closed.
    if(name==='blocked'&&tail==='/ads.js')body=body.replace('var nonce = current.nonce;','var nonce = "";');
    res.writeHead(response.status,{...Object.fromEntries(response.headers),...marker});res.end(body);
  }catch(e){res.writeHead(500,marker);res.end(String(e.message));}
}).listen(8877,'127.0.0.1',()=>console.log('Local experiment loader ready'));
