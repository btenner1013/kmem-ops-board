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
