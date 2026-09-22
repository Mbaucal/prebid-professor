import {previewCsvImport} from '../imports.ts';
import {previewFlexibleSizeMapCsv} from '../size-map-compat.ts';
import {sizeMapsTemplateCsv,adUnitsTemplateCsv} from '../../src/shared/inventory-csv-templates.ts';
import {jsonBody,TEST_SITE,WorkspaceError} from './boundary.mjs';
// The TEST import only previews CSV. Application remains the editor's existing
// revision-checked draft transaction; no second write path or production router.
export async function inventoryImportResponse(request,env,headers){
 const url=new URL(request.url);
 const file=url.pathname.match(/^\/test-api\/inventory-template\/(size-maps|ad-units)\.csv$/);
 if(file&&request.method==='GET'&&!url.search)return new Response(file[1]==='size-maps'?sizeMapsTemplateCsv:adUnitsTemplateCsv,{headers:{...headers,'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${file[1]}-template.csv"`}});
 if(url.pathname!=='/test-api/inventory-preview')return null;
 if(request.method!=='POST'||url.search)throw new WorkspaceError(404,'Not found.');
 const body=await jsonBody(request,['kind','csv'],262144);
 if(!['size-maps','ad-units'].includes(body.kind)||typeof body.csv!=='string')throw new WorkspaceError(422,'Choose ad units or size maps and provide CSV text.');
 const response=await (body.kind==='size-maps'?previewFlexibleSizeMapCsv:previewCsvImport)(new Request(request.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),env,TEST_SITE);
 return new Response(response.body,{status:response.status,headers:{...headers,'content-type':'application/json; charset=utf-8'}});
}
