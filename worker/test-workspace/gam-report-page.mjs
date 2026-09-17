export function gamReportPage(plan) {
  const data=JSON.stringify({experimentId:plan.experimentId,comparison:plan.comparison,values:plan.arms.map(a=>a.value)}).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · GAM report preview</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf0f5;color:#202a3b;font:16px system-ui}main{max-width:1050px;margin:32px auto;padding:0 20px}.card{background:white;border:1px solid #d7dfec;border-radius:16px;padding:24px;margin:20px 0}h1{margin:8px 0}h2{font-size:20px}p{line-height:1.6}.muted,small{color:#617087}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}label{display:grid;gap:8px;min-width:0}select,input,button{font:inherit;border:1px solid #bdc8d8;border-radius:9px;padding:12px;max-width:100%;min-width:0}button{cursor:pointer;background:white;font-weight:650}button.primary{background:#f47725;border-color:#f47725}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:20px}button:disabled{opacity:.45}a{color:#a4430c}code{overflow-wrap:anywhere}.error{color:#af2727}#message{min-height:24px;margin-top:18px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:12px 8px;border-bottom:1px solid #e4e8ef;overflow-wrap:anywhere}th{background:#f6f7fa}ul{padding-left:22px}li{margin:10px 0}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #f47725;outline-offset:2px}@media(max-width:600px){main{padding:0 12px;margin:16px auto}.card{padding:16px}.grid{grid-template-columns:1fr}td,th{padding:9px 4px;font-size:12px}}
</style></head><body><main><a href="/experiments">← Back to experiments</a><section class="card"><small>Private TEST · Report preview</small><h1>Review GAM report</h1><p>Upload a daily report for this experiment. Review A/B totals and missing data before comparing performance.</p><p id="identity" class="muted"></p><details><summary>CSV format and GAM columns</summary><p>Use one row per day and experiment value, for the same inventory and metric scope. Convert the GAM export to this template; keep missing rows missing. Do not include totals or other dimensions.</p><p><a id="template" download>Download CSV template</a></p><table><thead><tr><th>Template column</th><th>GAM source</th></tr></thead><tbody><tr><td>date, value</td><td>Date and tessera_ab value</td></tr><tr><td>impressions</td><td>Total impressions</td></tr><tr><td>revenue</td><td>The revenue metric selected below</td></tr><tr><td>adRequests, responsesServed</td><td>Total ad requests, Total responses served</td></tr><tr><td>measurableImpressions, viewableImpressions</td><td>Total Active View measurable and viewable impressions</td></tr></tbody></table><p>The last two metric pairs may be blank when unavailable. Use whole counts and a decimal point for revenue, without currency symbols or thousands separators. Do not change a report's time zone label to make it match.</p><div id="values"></div></details></section>
<section class="card"><form id="report-form"><div class="grid"><label>Start date<input id="start-date" type="date" required></label><label>End date<input id="end-date" type="date" required></label><label>Report currency<input id="currency" placeholder="e.g. EUR" pattern="[A-Z]{3}" maxlength="3" required></label><label>Report time zone<input id="time-zone" placeholder="e.g. Europe/Belgrade or UTC" maxlength="64" required></label><label>Revenue metric<select id="revenue-metric" required><option value="">Choose the exported metric</option><option value="total">Total revenue (CPM, CPC and CPD)</option><option value="cpm-cpc">Total CPM and CPC revenue</option></select></label><label>Revenue basis<select id="revenue-basis"><option value="unknown">Not verified</option><option value="net">Net</option><option value="gross">Gross</option></select></label><label>CSV file<input id="report-file" type="file" accept=".csv,text/csv" required></label></div><div class="actions"><button id="analyze" class="primary" type="submit">Preview report</button></div><p class="muted">Preview only. Download the result to keep it; uploaded reports are not saved here.</p></form><div id="message" role="status"></div></section>
<section class="card" id="results" hidden><h2>Reported results</h2><p id="report-summary"></p><p id="period"></p><table><thead><tr><th>Metric</th><th>A</th><th>B</th></tr></thead><tbody id="metrics"></tbody></table><h2>Before comparing</h2><ul id="blockers"></ul><p id="missing"></p><p class="muted">A script load is not an impression. Received TEST assignments are not site pageviews. This preview does not calculate page RPM or choose a winner.</p><button id="download" type="button">Download review (JSON)</button></section></main><script id="report-plan" type="application/json">${data}</script><script src="/experiment-report.js" defer></script></body></html>`;
}

function reportUI() {
  'use strict';
  const el=id=>document.getElementById(id),plan=JSON.parse(el('report-plan').textContent);
  let result=null;
  const message=(s,error=false)=>{el('message').textContent=s;el('message').classList.toggle('error',error);};
  el('identity').textContent=plan.comparison+' · '+plan.experimentId;
  el('identity').style.overflowWrap='anywhere';
  el('template').href='/test-api/experiments/reporting/'+plan.experimentId+'/template.csv';
  for(const [index,value] of plan.values.entries()){
    const p=document.createElement('p'),code=document.createElement('code');p.textContent=(index===0?'A: ':'B: ');code.textContent=value;p.append(code);el('values').append(p);
  }
  el('report-form').addEventListener('input',()=>{result=null;el('results').hidden=true;message('');});
  function render(value){
    result=value;el('results').hidden=false;
    el('report-summary').textContent=value.dataComplete?'Daily report rows complete. Comparison is not verified.':'Report incomplete or not ready for comparison.';
    el('period').textContent=value.period.startDate+' to '+value.period.endDate+' · '+value.period.timeZone+' · '+value.source.currency+' · '+value.source.revenueBasis;
    const fields=[['Rows supplied','rowCount'],['Impressions in supplied rows','impressions'],['Revenue ('+value.source.currency+')','revenue'],['Revenue / 1,000 impressions','revenuePerThousandImpressions'],['Ad requests','adRequests'],['Responses served','responsesServed'],['Responses / requests (%)','responseRatePercent'],['Measurable impressions','measurableImpressions'],['Viewable impressions','viewableImpressions'],['Viewability (%)','viewabilityPercent'],['Received TEST assignments (separate sample)','receivedAssignments']];
    el('metrics').replaceChildren();
    for(const [label,key] of fields){
      const row=document.createElement('tr'),name=document.createElement('th');name.scope='row';name.textContent=label;row.append(name);
      for(const variant of ['A','B']){const cell=document.createElement('td'),v=value.totals[variant][key];cell.textContent=v===null?'Unavailable':typeof v==='number'&&!Number.isInteger(v)?v.toFixed(3):String(v);row.append(cell);}el('metrics').append(row);
    }
    el('blockers').replaceChildren();for(const text of value.blockers){const li=document.createElement('li');li.textContent=text;el('blockers').append(li);}
    el('missing').textContent=value.missingRows.length?'Missing rows: '+value.missingRows.length+'. '+value.missingRows.slice(0,8).map(r=>r.date+' '+r.variant).join(', ')+(value.missingRows.length>8?'…':''):'';
  }
  el('report-form').addEventListener('submit',async event=>{
    event.preventDefault();result=null;el('results').hidden=true;message('Checking report…');
    const controls=[...el('report-form').querySelectorAll('input,select,button')];controls.forEach(e=>e.disabled=true);
    try{
      const file=el('report-file').files[0];if(!file||file.size>131072)throw Error('Choose a CSV file of at most 128 KB.');
      const csv=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      const body={experimentId:plan.experimentId,csv,startDate:el('start-date').value,endDate:el('end-date').value,currency:el('currency').value,timeZone:el('time-zone').value,revenueBasis:el('revenue-basis').value,revenueMetric:el('revenue-metric').value};
      const response=await fetch('/test-api/experiments/reporting/analyze',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Report could not be checked.');render(value);message('Report checked. Review the results and remaining limitations.');
    }catch(error){message(error.message,true);}finally{controls.forEach(e=>e.disabled=false);}
  });
  el('download').addEventListener('click',()=>{
    if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)+'\n'],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=plan.experimentId+'-report-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
}
export const gamReportScript='('+reportUI.toString()+')();\n';
