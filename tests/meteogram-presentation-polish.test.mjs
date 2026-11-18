import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMeteogramModel} from '../weather-meteogram-core.js';
import {buildMeteogramSvgMarkup} from '../weather-meteogram.js';
import {buildMeteogramPrintPlan,resolveMeteogramPrintRange} from '../weather-meteogram-print.js';
import {meteogramSolarPhase} from '../weather-meteogram-solar.js';
const report=(station,time,body)=>({station,product:'METAR',timestamp:time,raw:`${station} ${time.slice(8,10)}${time.slice(11,13)}${time.slice(14,16)}Z ${body}`});
test('unknown station clear sky is neutral, never an invented sun or moon',()=>{
 const model=buildMeteogramModel([report('ZZZZ','2026-11-18T01:00:00Z','00000KT 9999 NCD 08/07 Q1013')],{station:'ZZZZ',now:new Date('2026-11-18T01:00:00Z')});
 const svg=buildMeteogramSvgMarkup(model);
 assert.match(svg,/data-weather-symbol="neutral-clear"/);assert.match(svg,/day\/night unavailable/);
 assert.doesNotMatch(svg,/data-weather-symbol="(?:sun|moon)"/);assert.doesNotMatch(svg,/>☀<\/text>/);
});
function forecastModel(){
 return buildMeteogramModel([report('LOWL','2026-11-18T10:50:00Z','27018KT 9999 FEW050 12/06 Q1013')],{
 station:'LOWL',now:new Date('2026-11-18T10:51:00Z'),tafReports:[{station:'LOWL',product:'TAF',timestamp:'2026-11-18T10:00:00Z',raw:'TAF LOWL 181000Z 1810/1900 27018KT 9999 SCT050 TEMPO 1811/1818 27025G35KT -SHRA'}]});
}
test('NOW reference line cannot strike time/TAF/weather labels and is behind data',()=>{
 const model=forecastModel(),svg=buildMeteogramSvgMarkup(model);
 assert.match(svg,/<line class="aviation-meteogram-now-divider"[^>]*y1="122"/);
 assert.ok(svg.indexOf('class="aviation-meteogram-now-divider"')<svg.indexOf('class="aviation-meteogram-observation'));
 assert.ok(svg.indexOf('class="aviation-meteogram-now-label"')>svg.indexOf('class="aviation-meteogram-observation'));
});
test('conditional wind uses separate heading/speed lines and print grants extra room without losing times',()=>{
 const model=forecastModel(),before=JSON.stringify(model),settings={windUnit:'MPH'};
 const svg=buildMeteogramSvgMarkup(model,settings);
 assert.match(svg,/data-wind-qualifier="heading"[^>]*>TMP 270°<\/text>/);
 assert.match(svg,/data-wind-qualifier="speed"[^>]*>29 G40 MPH<\/text>/);
 const range=resolveMeteogramPrintRange({model,settings});
 const plan=buildMeteogramPrintPlan({model,settings,range});
 assert.ok(plan.pages.filter(p=>p.model.timeline.some(o=>o.conditional?.some(e=>e.conditions?.windSpeedKt!=null))).every(p=>p.model.timeline.length<=8));
 assert.deepEqual(plan.pages.flatMap(p=>p.model.timeline.map(o=>o.validZ||o.observedZ)),model.timeline.map(o=>o.validZ||o.observedZ));
 assert.equal(JSON.stringify(model),before);
});

test('LOWL clear night uses moon and noon uses sun in live and PDF snapshots',()=>{
 for(const [time,phase,symbol] of [['2026-11-17T18:50:00Z','night','moon'],['2026-11-18T00:20:00Z','night','moon'],['2026-11-18T12:00:00Z','day','sun']]){
  assert.equal(meteogramSolarPhase(time,{station:'LOWL'}),phase);
  const model=buildMeteogramModel([report('LOWL',time,'00000KT 9999 NCD 08/07 Q1013')],{station:'LOWL',now:new Date(time)});
  const settings={timeMode:'LOCAL'};
  const svg=buildMeteogramSvgMarkup(model,settings);
  assert.match(svg,new RegExp(`data-weather-symbol="${symbol}"`));
  assert.match(svg,new RegExp(`during LOWL ${phase==='day'?'daylight':'nighttime'}`));
  const plan=buildMeteogramPrintPlan({model,settings,range:resolveMeteogramPrintRange({model,settings})});
  assert.match(plan.pages[0].svg,new RegExp(`data-weather-symbol="${symbol}"`));
 }
});
test('multiple conditional wind groups stay separate and width-bounded, all exact values retained',()=>{
 const model=forecastModel();
 for(const forecast of model.forecasts){forecast.conditional=[
  {type:'TEMPO',conditions:{windDirectionDeg:270,windSpeedKt:25,windGustKt:35}},
  {type:'PROBABILITY',probability:30,conditions:{windDirectionDeg:240,windSpeedKt:40,windGustKt:55}},
  {type:'BECOMING',conditions:{windDirectionDeg:180,windSpeedKt:12,windGustKt:20}},
 ];}
 const svg=buildMeteogramSvgMarkup(model,{windUnit:'MPH'},{viewportWidth:400});
 assert.match(svg,/data-wind-qualifier="group"/);
 assert.match(svg,/lengthAdjust="spacingAndGlyphs"/);
 assert.match(svg,/270° 29 MPH G40/);assert.match(svg,/240° 46 MPH G63/);assert.match(svg,/180° 14 MPH G23/);
 const groups=[...svg.matchAll(/<text[^>]*data-wind-qualifier="group"[^>]*y="(\d+)"[^>]*>/g)];
 assert.ok(groups.length>0);assert.ok(groups.every(g=>['446','458'].includes(g[1])));
});
