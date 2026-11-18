import test from 'node:test';
import assert from 'node:assert/strict';
import {convertVisibility,formatMeteogramVisibility,buildMeteogramModel} from '../weather-meteogram-core.js';
import {buildMeteogramSvgMarkup,buildMeteogramAccessibleTableMarkup,meteogramRowLabelDescriptors} from '../weather-meteogram.js';
import {buildMeteogramPrintPlan,buildMeteogramPrintPagesMarkup,resolveMeteogramPrintRange} from '../weather-meteogram-print.js';
const point=(visibilitySm,visibilityDisplay,visibilityQualifier='')=>({visibilitySm,visibilityDisplay,visibilityQualifier});
test('visibility conversion uses exact statute-mile factor; missing values stay missing',()=>{
 assert.equal(convertVisibility(1,'M'),1609.344);assert.equal(convertVisibility(.25,'M'),402.336);
 assert.equal(convertVisibility(null,'M'),null);assert.equal(convertVisibility(undefined,'M'),null);
 assert.equal(formatMeteogramVisibility(point(null,'—'),'M'),'—');
 assert.equal(formatMeteogramVisibility(point(.25,'1/4 SM'),'SM'),'1/4 SM');
 assert.equal(formatMeteogramVisibility(point(.25,'1/4 SM'),'M'),'402 m');
});
test('upper/lower bounds, metric thresholds and CAVOK remain bounds',()=>{
 assert.equal(formatMeteogramVisibility(point(6,'>6 SM','>'),'M'),'>9,656 m');
 assert.equal(formatMeteogramVisibility(point(.25,'<1/4 SM','<'),'M'),'<402 m');
 const high=point(10000/1609.344,'≥10 KM','≥');
 assert.equal(formatMeteogramVisibility(high,'M'),'≥10,000 m');
 assert.equal(formatMeteogramVisibility(high,'SM'),'≥6.21 SM');
 assert.equal(formatMeteogramVisibility(point(3000/1609.344,'3000 M'),'M'),'3,000 m');
});
function fixture(){return buildMeteogramModel([
 {station:'KMEM',product:'METAR',timestamp:'2026-11-18T12:00:00Z',raw:'KMEM 181200Z 20010KT P6SM SCT050 20/10 A2992'},
 {station:'KMEM',product:'METAR',timestamp:'2026-11-18T13:00:00Z',raw:'KMEM 181300Z 21010KT M1/4SM FG VV002 20/10 A2992'},
 ],{station:'KMEM',now:new Date('2026-11-18T13:00:00Z')});}
test('live SVG, text table and PDF snapshot use selected visibility unit without changing source data',()=>{
 const model=fixture();assert.equal(model.observations.length,2);
 const before=JSON.stringify(model),settings={visibilityUnit:'M',temperatureUnit:'F',windUnit:'MPH',timeMode:'Z'};
 const svg=buildMeteogramSvgMarkup(model,settings);
 assert.match(svg,/METERS/);assert.match(svg,/9,656/);assert.match(svg,/402/);
 const table=buildMeteogramAccessibleTableMarkup(model,settings);assert.match(table,/Visibility meters/);assert.match(table,/9,656 m/);
 const plan=buildMeteogramPrintPlan({model,settings,range:resolveMeteogramPrintRange({model,settings})});
 assert.equal(plan.settings.visibilityUnit,'M');assert.match(buildMeteogramPrintPagesMarkup(plan),/VIS METERS/);
 assert.match(plan.pages[0].svg,/9,656/);assert.equal(JSON.stringify(model),before);
 const labels=meteogramRowLabelDescriptors(settings);assert.equal(labels.find(x=>x.key==='visibility').unit,'METERS');
});

test('international 9999 and CAVOK retain the ten-kilometer minimum after conversion',()=>{
 for(const visibility of ['9999','CAVOK']){
  const model=buildMeteogramModel([{station:'LOWL',product:'METAR',timestamp:'2026-11-18T12:00:00Z',raw:`LOWL 181200Z 20010KT ${visibility} 20/10 Q1013`}],{station:'LOWL',now:new Date('2026-11-18T12:00:00Z')});
  assert.equal(formatMeteogramVisibility(model.observations[0],'M'),'≥10,000 m');
  assert.equal(formatMeteogramVisibility(model.observations[0],'SM'),'≥6.21 SM');
 }
});
test('conditional forecast visibility is converted in each group without changing its probability or timing',()=>{
 const model=fixture(),obs=model.observations[0];
 obs.kind='forecast'; obs.conditional=[{type:'TEMPO',conditions:point(1.5,'1 1/2 SM')}];
 // Same source point through both presentation units keeps qualifiers and group identity.
 const metric=buildMeteogramSvgMarkup(model,{visibilityUnit:'M'});
 const statute=buildMeteogramSvgMarkup(model,{visibilityUnit:'SM'});
 assert.match(metric,/TMP 2,414 m/);assert.match(statute,/TMP 1 1\/2 SM/);
 assert.equal(obs.conditional[0].conditions.visibilityDisplay,'1 1/2 SM');
});

test('LOWL observed rain and ceiling remain separate from METAR trend in live chart and PDF',()=>{
 const raw='LOWL 171050Z 09005KT 060V120 9999 -RA FEW005 SCT010 BKN050 08/07 Q0997 TEMPO 3000 RA BR BKN005';
 const model=buildMeteogramModel([{station:'LOWL',product:'METAR',timestamp:'2026-11-17T10:50:00Z',raw}],{station:'LOWL',now:new Date('2026-11-17T10:50:00Z')});
 const obs=model.observations[0];
 assert.deepEqual(obs.weatherCodes,['-RA']);assert.equal(obs.clouds.ceilingFt,5000);
 assert.equal(obs.weather.icon,'🌧️');assert.equal(formatMeteogramVisibility(obs,'M'),'≥10,000 m');
 assert.equal(obs.trendRaw,'TEMPO 3000 RA BR BKN005');
 const settings={visibilityUnit:'M'};
 const svg=buildMeteogramSvgMarkup(model,settings);
 assert.match(svg,/>🌧️<\/text>/);assert.doesNotMatch(svg,/>☂<\/text>/);
 assert.match(svg,/METAR TREND FORECAST \(not observed\)/);
 assert.match(buildMeteogramAccessibleTableMarkup(model,settings),/METAR TREND FORECAST \(not observed\): TEMPO 3000 RA BR BKN005/);
 const plan=buildMeteogramPrintPlan({model,settings,range:resolveMeteogramPrintRange({model,settings})});
 const pages=buildMeteogramPrintPagesMarkup(plan);
 assert.match(pages,/METAR TREND FORECASTS EXCLUDED FROM OBSERVATIONS/);
 assert.match(pages,/>🌧️<\/text>/);
 assert.equal(plan.pages[0].model.observations[0].clouds.ceilingFt,5000);
});
test('rain-cloud icon does not replace thunder or snow distinctions',()=>{
 for(const [wx,icon] of [['-RA','🌧️'],['DZ','🌧️'],['VCSH','🌧️'],['TSRA','⚡'],['-SN','❄']]){
  const model=buildMeteogramModel([{station:'KMEM',product:'METAR',timestamp:'2026-11-18T12:00:00Z',raw:`KMEM 181200Z 20010KT 6SM ${wx} BKN020 20/10 A2992`}],{station:'KMEM',now:new Date('2026-11-18T12:00:00Z')});
  assert.equal(model.observations[0].weather.icon,icon,wx);
 }
});
