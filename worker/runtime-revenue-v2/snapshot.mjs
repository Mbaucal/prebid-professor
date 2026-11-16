import {previewInput as positionsInput} from '../runtime-next/snapshot.mjs';
import {buildDealInput} from '../../shared/deals/contract.mjs';
import {buildOutstreamInput} from '../../shared/outstream/settings-v2.mjs';

export function previewInput(snapshot,descriptor,timestamp,takeOver) {
  const input=positionsInput(snapshot,descriptor,timestamp,takeOver);
  input.deals=buildDealInput(snapshot);
  input.outstream=buildOutstreamInput(snapshot);
  for(const code of input.outstream.disabledRefreshCodes) {
    if(code===input.overlay?.code || code===input.options.sticky.bottomAdUnitId || code===input.options.sticky.topAdUnitId)
      throw Error('The Outstream pilot supports standard in-page positions only. Keep Sticky and TakeOver on Banner.');
    if(!input.core.explicitUnits.some(unit=>unit.id===code))throw Error('Enable the saved Outstream position before generating.');
  }
  return input;
}
