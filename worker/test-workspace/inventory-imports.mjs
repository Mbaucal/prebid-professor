import {previewCsvImport,previewFlexibleSizeMapCsv} from '../../.generated/inventory-preview.mjs';
import {sizeMapsTemplateCsv,adUnitsTemplateCsv} from '../../src/shared/inventory-csv-templates.ts';
import {jsonBody,TEST_SITE,WorkspaceError} from './boundary.mjs';
// The TEST import only previews CSV. Application remains the editor's existing
// revision-checked draft transaction; no second write path or production router.
// Ad-unit rows may name size maps that so far exist only in that unsaved draft; the
// editor checks those names when it adds the rows and on its save.
export async function inventoryImportResponse(request,env,headers){
 const url=new URL(request.url);
 const file=url.pathname.match(/^\/test-api\/inventory-template\/(size-maps|ad-units)\.csv$/);
 if(file&&request.method==='GET'&&!url.search)return new Response(file[1]==='size-maps'?sizeMapsTemplateCsv:adUnitsTemplateCsv,{headers:{...headers,'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${file[1]}-template.csv"`}});
 if(url.pathname!=='/test-api/inventory-preview')return null;
 if(request.method!=='POST'||url.search)throw new WorkspaceError(404,'Not found.');
 const body=await jsonBody(request,['kind','csv'],262144);
 if(!['size-maps','ad-units'].includes(body.kind)||typeof body.csv!=='string')throw new WorkspaceError(422,'Choose ad units or size maps and provide CSV text.');
 const preview=new Request(request.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const response=body.kind==='size-maps'?await previewFlexibleSizeMapCsv(preview,env,TEST_SITE):await previewCsvImport(preview,env,TEST_SITE,{draftSizeMaps:true});
 return new Response(response.body,{status:response.status,headers:{...headers,'content-type':'application/json; charset=utf-8'}});
}
