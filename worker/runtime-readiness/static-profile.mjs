import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {bootStaticAA,instrumentFullRuntime} from '../experiments/static-aa-v1.mjs';
import {createConsentEpoch} from '../runtime-cache/consent-epoch.mjs';
import {createBidReadinessObserver} from './observer.mjs';

export const READINESS_RELEASE='tanjug-aa-observed-1.0.0';
export function instrumentObservedRuntime(source,positions) {
  let output=instrumentFullRuntime(source,READINESS_RELEASE);
  const marker='    window.__TESSERA_RUNTIME_STARTED = {';
  assert.equal(output.split(marker).length,2,'Review observer install location');
  const setup=`
    var readinessConsent, readinessObserver;
    try {
      readinessConsent=(${createConsentEpoch.toString()})(window);
      readinessObserver=(${createBidReadinessObserver.toString()})({pbjs:window.pbjs,
        service:window.googletag.pubads(),codes:${JSON.stringify(positions)},
        contextForCode:function(code){
          var state=readinessConsent.read(),slot=window.adSlots&&window.adSlots[code];
          if(!slot)return null;
          var unit=adUnitFromCode(code);
          return {slot:slot,epoch:state.epoch,consentReady:state.cacheAllowed,
            sizes:unit&&unit.mediaTypes&&unit.mediaTypes.banner&&unit.mediaTypes.banner.sizes||[],
            currency:AD_SERVER_CURRENCY,floor:HARD_FLOOR_EUR,bidderFloors:BIDDER_FLOORS};
        }});
      window.AdBidReadiness=Object.freeze({snapshot:readinessObserver.snapshot,
        inspect:function(){var s=readinessObserver.snapshot();console.table(s.rows.map(function(r){return {
          position:r.position,candidates:r.candidates,expiresInSeconds:r.earliestExpiryMs===null?null:Math.floor(r.earliestExpiryMs/1000),
          submitted:r.counters.submitted,renderSucceeded:r.counters.renderSucceeded,
          rejected:JSON.stringify(r.rejected)};}));console.log(s);return s;},
        stop:function(){readinessObserver.stop();readinessConsent.stop();}});
    }catch(_){
      if(readinessObserver)readinessObserver.stop();if(readinessConsent)readinessConsent.stop();
      window.AdBidReadiness=Object.freeze({snapshot:function(){return {profile:'bid-readiness-observer-1.0.0',mode:'observe-only',error:'observer-unavailable',rows:[]};}});
    }
`;
  // Install after GPT readiness, before owned slots can start auctions. The
  // original runtime defines GPT lazily, so the setup belongs inside its cmd.
  const gptMarker='            var newlyDefinedSlots = [];';
  assert.equal(output.split(gptMarker).length,2,'Review slot setup before installing observer');
  output=output.replace(gptMarker,'            if(!window.AdBidReadiness){'+setup+'}\n'+gptMarker);
  parse(output,{ecmaVersion:'latest'});return output;
}
export function observedLoader(config) {
  assert.equal(config.release,READINESS_RELEASE);
  assert.deepEqual(Object.keys(config.arms).sort(),['A','B']);
  assert.equal(config.arms.A.integrity,config.arms.B.integrity);
  // Reuse the immutable proven loader, with a separate release identity.
  const source='('+bootStaticAA.toString()+')('+JSON.stringify(config).replace(/</g,'\\u003c')+');\n';
  const extension=`(function(){
    if(window.__adVariantDelivery&&window.__adVariantDelivery.release===${JSON.stringify(READINESS_RELEASE)}&&window.AdVariant&&!window.AdVariant.bidReadiness){
      var original=window.AdVariant;
      window.AdVariant=Object.freeze({snapshot:function(){return Object.assign({},original.snapshot(),{bidReadiness:window.AdBidReadiness?window.AdBidReadiness.snapshot():null});},
        inspect:function(){original.inspect();if(window.AdBidReadiness&&window.AdBidReadiness.inspect)window.AdBidReadiness.inspect();return this.snapshot();},
        bidReadiness:function(){return window.AdBidReadiness?window.AdBidReadiness.snapshot():null;}});
    }
  })();\n`;
  parse(source+extension,{ecmaVersion:'latest'});return source+extension;
}
