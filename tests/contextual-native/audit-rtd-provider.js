/** Synthetic second RTD provider, built only by the isolated native test kit. */
import {submodule} from '../src/hook.js';

submodule('realTimeData', {
  name: 'contextualAudit',
  init: function() { return true; },
  getBidRequestData: function(request, callback) {
    window.__contextualAuditCalls = (window.__contextualAuditCalls || 0) + 1;
    callback();
  }
});
