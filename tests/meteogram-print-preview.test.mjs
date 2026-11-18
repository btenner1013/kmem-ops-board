import test from 'node:test';
import assert from 'node:assert/strict';
import {meteogramPreviewStyles,openMeteogramPrintPreview} from '../meteogram-print-preview.js';
const doc=()=>({baseURI:'https://example.test/board/',styleSheets:['aviation-weather-lookup','weather-meteogram'].map(name=>({href:`https://example.test/board/${name}.css`,cssRules:[{cssText:'.chart { fill: red; }'},{conditionText:'print',cssRules:[{cssText:'body.aviation-meteogram-printing .chart { fill: black; }'}]}]}))});
test('snapshot includes base and print rules for screen and later PDF capture',()=>{
 const css=meteogramPreviewStyles(doc());assert.match(css,/fill: red/);assert.match(css,/fill: black/);assert.doesNotMatch(css,/@media print/);
});
test('missing styles and blocked popups are explicit failures, never print dashboard',()=>{
 assert.throws(()=>meteogramPreviewStyles({styleSheets:[]}),/not ready/);
 assert.equal(openMeteogramPrintPreview({doc:doc(),view:{open:()=>null},markup:'test'}),false);
});
test('separate preview contains selected snapshot only and survives repeat print/cancel',()=>{
 let written='',prints=0,closed=0;const events={};
 const preview={document:{open(){},write(v){written=v},close(){},getElementById(id){return{addEventListener(type,fn){events[id]=fn}}}},print(){prints++},close(){closed++},focus(){}};
 assert.equal(openMeteogramPrintPreview({doc:doc(),view:{open:()=>preview},markup:'<article>selected chart</article>',station:'KMEM'}),true);
 assert.match(written,/<title>KMEM meteogram/);assert.match(written,/@page\{size:letter landscape;margin:\.28in\}/);assert.match(written,/selected chart/);assert.doesNotMatch(written,/weather\.json|afterprint|REFRESH IN|NOTAMS|aviation-lookup-panel/);
 events.previewPrint();events.previewPrint();assert.equal(prints,2);assert.equal(closed,0);assert.match(written,/selected chart/);events.previewClose();assert.equal(closed,1);
});

test('silent or unsupported native print keeps actionable browser-menu fallback',()=>{
 let written='';const events={},nodes={};
 const preview={document:{open(){},write(v){written=v},close(){},getElementById(id){return nodes[id] ||= {addEventListener(type,fn){events[id]=fn},textContent:''}}},print(){throw new Error('not supported')},close(){},focus(){}};
 openMeteogramPrintPreview({doc:doc(),view:{open:()=>preview},markup:'selected chart'});
 assert.match(written,/DuckDuckGo/);assert.match(written,/Landscape/);
 assert.doesNotThrow(()=>events.previewPrint());
 assert.match(nodes.previewPrintStatus.textContent,/browser’s menu → Print/);
 assert.match(written,/aria-live="polite"/);
});

test('print SVG text has no outline that can obscure glyphs in iOS PDF',async()=>{
 const {readFile}=await import('node:fs/promises');
 const css=await readFile(new URL('../weather-meteogram.css',import.meta.url),'utf8');
 assert.match(css,/@media print\{\s*body\.aviation-meteogram-printing \.aviation-meteogram-svg-print text,\s*body\.aviation-meteogram-printing \.aviation-meteogram-svg-print tspan\{\s*stroke:none!important;\s*stroke-width:0!important;\s*opacity:1!important;/);
});

test('dense print pages split without losing observations or boundary reports',async()=>{
 const {paginateMeteogramPrintModel,sliceMeteogramModelForPrint}=await import('../weather-meteogram-print.js');
 const start=Date.parse('2026-11-18T00:00:00Z');
 const observations=Array.from({length:25},(_,i)=>({validZ:new Date(start+i*1800000).toISOString(),source:'METAR'}));
 const model={observations,forecasts:[]};
 const range={startZ:observations[0].validZ,endZ:observations.at(-1).validZ,includeEnd:true};
 const pages=paginateMeteogramPrintModel(model,range);
 assert.equal(pages.length,2);assert.equal(pages[0].endZ,pages[1].startZ);
 const sliced=pages.map(p=>sliceMeteogramModelForPrint(model,p).observations);
 assert.ok(sliced.every(rows=>rows.length<=14));
 assert.deepEqual(sliced.flat(),observations);
 assert.equal(pages[0].includeEnd,false);assert.equal(pages.at(-1).includeEnd,true);
});

test('print row subtitles wrap at print font size instead of clipping at screen measurements',async()=>{
 const {denseThunderstormMeteogramFixture}=await import('./fixtures/weather-meteogram-dense-thunderstorm.mjs');
 const {buildMeteogramPrintPlan,resolveMeteogramPrintRange}=await import('../weather-meteogram-print.js');
 const model=denseThunderstormMeteogramFixture(),settings={timeMode:'LOCAL',temperatureUnit:'F',windUnit:'MPH'};
 const range=resolveMeteogramPrintRange({model,settings});
 const plan=buildMeteogramPrintPlan({model,settings,range});
 assert.ok(plan.ok);
 for(const page of plan.pages){
  const wind=page.svg.match(/<g class="aviation-meteogram-row-label" data-row-key="windSpeed"[\s\S]*?<\/g>/)?.[0];
  assert.ok(wind); assert.match(wind,/data-row-wrapped="true"/);
  assert.match(wind,/WIND SPEED \/ GUST/);
  assert.match(wind,/SOLID SUSTAINED/); assert.match(wind,/GUST WHISKER/); assert.match(wind,/MPH/);
 }
});

function sharingPreview({shareError=null,canShare=true}={}){
 const events={},nodes={},links=[],shared=[];
 const preview={
  document:{open(){},write(){},close(){},body:{append(a){links.push(a)}},
   getElementById(id){return nodes[id] ||= {textContent:'',disabled:false,hidden:false,addEventListener(type,fn){events[id]=fn}}},
   createElement(){return {click(){this.clicked=true},remove(){this.removed=true}}}},
  File:class{constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type}},
  URL:{createObjectURL(){return 'blob:pdf'}},
  navigator:{canShare(){return canShare},async share(args){shared.push(args);if(shareError)throw shareError}},
  print(){},close(){},focus(){},
 };
 return{preview,events,nodes,links,shared};
}
test('prepare PDF then share or download without invoking native print',async()=>{
 const f=sharingPreview();let creates=0;
 openMeteogramPrintPreview({doc:doc(),view:{open:()=>f.preview},markup:'chart',station:'KMEM',createPdf:async()=>{creates++;return new Blob(['pdf'])}});
 await f.events.previewCreatePdf();await f.events.previewCreatePdf();assert.equal(creates,1);
 assert.equal(f.nodes.previewDownloadPdf.disabled,false);assert.equal(f.nodes.previewSharePdf.hidden,false);
 await f.events.previewSharePdf();assert.equal(f.shared[0].files[0].name,'KMEM-meteogram.pdf');
 assert.match(f.nodes.previewPdfStatus.textContent,/Share sheet closed/);
 f.events.previewDownloadPdf();assert.equal(f.links[0].href,'blob:pdf');assert.equal(f.links[0].download,'KMEM-meteogram.pdf');assert.ok(f.links[0].clicked);
});
test('failed preparation can retry; share cancellation retains prepared file',async()=>{
 const f=sharingPreview({shareError:{name:'AbortError'}});let attempts=0;
 openMeteogramPrintPreview({doc:doc(),view:{open:()=>f.preview},markup:'chart',createPdf:async()=>{if(++attempts===1)throw new Error('raster failed');return new Blob(['pdf'])}});
 await f.events.previewCreatePdf();assert.equal(f.nodes.previewCreatePdf.disabled,false);assert.match(f.nodes.previewPdfStatus.textContent,/Could not create/);
 await f.events.previewCreatePdf();await f.events.previewSharePdf();assert.match(f.nodes.previewPdfStatus.textContent,/Sharing canceled/);
 assert.equal(f.nodes.previewSharePdf.disabled,false);f.events.previewDownloadPdf();assert.ok(f.links[0].clicked);
});
test('browsers without file sharing still offer a downloadable PDF',async()=>{
 const f=sharingPreview({canShare:false});
 openMeteogramPrintPreview({doc:doc(),view:{open:()=>f.preview},markup:'chart',createPdf:async()=>new Blob(['pdf'])});
 await f.events.previewCreatePdf();assert.equal(f.nodes.previewSharePdf.hidden,true);assert.equal(f.nodes.previewDownloadPdf.disabled,false);
});

test('closing preview releases prepared PDF and ignores late generation',async()=>{
 const f=sharingPreview();let revoked=null;
 f.preview.URL.revokeObjectURL=url=>{revoked=url};
 openMeteogramPrintPreview({doc:doc(),view:{open:()=>f.preview},markup:'chart',createPdf:async()=>new Blob(['pdf'])});
 await f.events.previewCreatePdf();f.events.previewClose();assert.equal(revoked,'blob:pdf');
 const g=sharingPreview();let complete;
 openMeteogramPrintPreview({doc:doc(),view:{open:()=>g.preview},markup:'chart',createPdf:()=>new Promise(resolve=>{complete=resolve})});
 const pending=g.events.previewCreatePdf();g.events.previewClose();complete(new Blob(['pdf']));await pending;
 assert.notEqual(g.nodes.previewCreatePdf.textContent,'PDF ready');
});
