import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLandscapeImagePdf,wrapCanvasText,createMeteogramPdf} from '../meteogram-pdf-export.js';
test('PDF has fixed landscape pages and accurate binary object offsets',async()=>{
 const blob=buildLandscapeImagePdf([{jpeg:new Uint8Array([255,216,255,217]),width:2376,height:1836},{jpeg:new Uint8Array([255,216,0,255,217]),width:2376,height:1836}]);
 assert.equal(blob.type,'application/pdf');
 const data=new Uint8Array(await blob.arrayBuffer()); const text=new TextDecoder('latin1').decode(data);
 assert.equal((text.match(/\/MediaBox \[0 0 792 612\]/g)||[]).length,2);
 assert.match(text,/\/Count 2/); assert.match(text,/\/Length 5/);
 const xref=Number(text.match(/startxref\n(\d+)/)[1]); assert.equal(new TextDecoder().decode(data.slice(xref,xref+4)),'xref');
 const entries=text.slice(text.indexOf('0000000000 65535 f')).split('\n').slice(1,9);
 entries.forEach((e,i)=>assert.equal(new TextDecoder().decode(data.slice(Number(e.slice(0,10)),Number(e.slice(0,10))+7)),`${i+1} 0 obj`));
});
test('rejects empty or invalid images',()=>{
 assert.throws(()=>buildLandscapeImagePdf([]),/No meteogram/);
 assert.throws(()=>buildLandscapeImagePdf([{jpeg:null,width:4,height:3}]),/Invalid/);
});
test('metadata wraps without dropping words',()=>{
 const ctx={measureText:s=>({width:s.length})};
 assert.deepEqual(wrapCanvasText(ctx,'one two three four',9),['one two','three','four']);
});
test('export rejects missing pages and bad resolution',async()=>{
 await assert.rejects(()=>createMeteogramPdf({querySelectorAll:()=>[]}),/No meteogram/);
 await assert.rejects(()=>createMeteogramPdf({}, {pixelRatio:NaN}),/resolution/);
});

test('SVG export preserves computed styles but removes destructive text outlines',async()=>{
 const {inlineSvgStyles}=await import('../meteogram-pdf-export.js');
 const copied=[];
 const make=(tag)=>({tagName:tag,style:{setProperty:(k,v)=>copied.push([tag,k,v])}});
 const text=make('text');const tspan=make('tspan');const clone={...make('svg'),querySelectorAll:()=>[text,tspan],setAttribute:(k,v)=>copied.push(['svg',k,v])};
 const svg={tagName:'svg',cloneNode:()=>clone,querySelectorAll:()=>[{tagName:'text'},{tagName:'tspan'}],viewBox:{baseVal:{width:1540,height:1000}}};
 const view={getComputedStyle:()=>({getPropertyValue:p=>p==='stroke'?'white':p==='fill'?'black':'1'}),XMLSerializer:class{serializeToString(){return '<svg/>';}}};
 assert.equal(inlineSvgStyles(svg,view),'<svg/>');
 for(const tag of ['text','tspan']) assert.ok(copied.some(v=>v[0]===tag&&v[1]==='stroke'&&v[2]==='none'));
 assert.ok(copied.some(v=>v[1]==='width'&&v[2]==='1540'));
});

test('export includes per-page metadata, no-data message and releases canvas memory',async()=>{
 const drawn=[];const canvases=[];
 const page={querySelector:s=>s==='h1'?{textContent:'LOWL AVIATION METEOGRAM'}:s.includes('header p')?{textContent:'18 NOV 00:00 GMT+1'}:s.includes('coverage')?{textContent:'AVAILABLE COVERAGE'}:null,querySelectorAll:()=>[{textContent:'LOCAL · °F · MPH'},{textContent:'PAGE 1 OF 1'},{textContent:'FOR REFERENCE ONLY'}]};
 const ctx={scale(){},fillRect(){},fillText:s=>drawn.push(s),measureText:s=>({width:s.length*4})};
 const doc={defaultView:{},fonts:{ready:Promise.resolve()},querySelectorAll:()=>[page],createElement:()=>{const canvas={width:0,height:0,getContext:()=>ctx,toBlob:cb=>cb(new Blob([new Uint8Array([255,216,255,217])]))};canvases.push(canvas);return canvas;}};
 const pdf=await createMeteogramPdf(doc);
 assert.equal(pdf.type,'application/pdf');
 assert.ok(drawn.includes('LOWL AVIATION METEOGRAM'));
 assert.ok(drawn.some(s=>s.includes('FOR REFERENCE ONLY')));
 assert.ok(drawn.includes('NO DATA IN THIS INTERVAL'));
 assert.equal(canvases[0].width,0);assert.equal(canvases[0].height,0);
});
