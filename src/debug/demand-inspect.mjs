export const demandInspectCommand = `(function () {
  var pb = window.pbjs;
  if (!pb || typeof pb.getConfig !== 'function') return console.info('Prebid is not active on this page.');
  var rows = new Map();
  (typeof pb.getEvents === 'function' ? pb.getEvents() : []).forEach(function (event) {
    if (event.eventType !== 'bidRequested') return;
    var request = event.args || {};
    (request.bids || []).forEach(function (bid) {
      var ext = bid.ortb2Imp && bid.ortb2Imp.ext || {};
      var code = bid.adUnitCode || bid.code;
      var bidder = bid.bidder || request.bidderCode;
      rows.set(code + '|' + bidder, {position:code, bidder:bidder, gpid:ext.gpid || '(missing)',
        gamSlot:ext.data && ext.data.adserver && ext.data.adserver.adslot || '(missing)', auction:request.auctionId});
    });
  });
  console.info({enableSendAllBids:pb.getConfig('enableSendAllBids'), targetingControls:pb.getConfig('targetingControls')});
  console.table(Array.from(rows.values()));
  console.info('Latest retained Prebid bidder-request metadata per position/partner. Confirm serialized SSP requests in Network; this view does not prove transmission or revenue. No user identifiers are included.');
})();`;
