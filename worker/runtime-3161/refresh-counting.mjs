/** Compile-time correction for automatic-refresh counters in the new runtime.
 * An attempted refresh does not consume a cap or schedule step. Count only a
 * marked, still-owned slot reaching the final GPT visibility gate.
 * Apply within3.16.1 after its remaining-gap timer correction: a timer queued
 * before asynchronous dispatch may otherwise repeat the previous sequence step.
 */
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Refresh counting insertion point changed: ' + before);
  return source.replace(before, () => after);
}

export function transform(source) {
  source = once(source, '  var _refreshCounts = {};', '  var _refreshCounts = {};\n  var _tesseraRefreshPending = Object.create(null);\n  var _tesseraLastRefreshSentAt = Object.create(null);');
  source = once(source, '    _gamReporting.plan(slot,effectiveMinGapSec);',
    '    if (!slotHasCurrentViewportSizes(id)) return;\n    _gamReporting.plan(slot,effectiveMinGapSec);');
  source = once(source, '    _lastRefreshAt[id]=now(); _refreshCounts[id]=(_refreshCounts[id]||0)+1;',
    '    _lastRefreshAt[id]=now(); _tesseraRefreshPending[id]=slot;');
  source = once(source, '          return _gamReporting.send(orig,pa,allow,opts);', `          var countedRefreshes=[],previousSendTimes=[];
          allow.forEach(function(slot){
            var id=sid(slot);
            var owned=id&&((window.adSlots&&window.adSlots[id]===slot)||slot===_takeOverSlot||slot===_takeOverCodelessGuardSlot);
            if(!owned)return;
            previousSendTimes.push({id:id,present:Object.prototype.hasOwnProperty.call(_tesseraLastRefreshSentAt,id),at:_tesseraLastRefreshSentAt[id]});
            _tesseraLastRefreshSentAt[id]=now();
            if(_tesseraRefreshPending[id]===slot){
              delete _tesseraRefreshPending[id];
              _refreshCounts[id]=(_refreshCounts[id]||0)+1;
              countedRefreshes.push({id:id,slot:slot});
            }
          });
          try{return _gamReporting.send(orig,pa,allow,opts);}
          catch(error){
            previousSendTimes.forEach(function(item){
              if(item.present)_tesseraLastRefreshSentAt[item.id]=item.at;
              else delete _tesseraLastRefreshSentAt[item.id];
            });
            countedRefreshes.forEach(function(item){
              _refreshCounts[item.id]=Math.max(0,(_refreshCounts[item.id]||0)-1);
              if(!_tesseraRefreshPending[item.id])_tesseraRefreshPending[item.id]=item.slot;
            });
            throw error;
          }`);
  return source;
}
