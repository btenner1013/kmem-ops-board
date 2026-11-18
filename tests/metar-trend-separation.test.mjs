import test from 'node:test';
import assert from 'node:assert/strict';
import {splitMetarSections,decodeMetarReport,decodeTafReport} from '../aviation-weather-lookup-core.js';
import {parseMeteogramObservation} from '../weather-meteogram-core.js';
const raw='LOWL 171050Z 09005KT 060V120 9999 -RA FEW005 SCT010 BKN050 08/07 Q0997 TEMPO 3000 RA BR BKN005';
const report=(raw)=>({station:'LOWL',timestamp:'2026-11-17T10:50:00Z',raw,source:'IEM ASOS archive'});
test('exact LOWL 171050Z observed weather and ceiling exclude appended trend',()=>{
 const value=parseMeteogramObservation(report(raw));
 assert.deepEqual(value.weatherCodes,['-RA']);assert.equal(value.clouds.ceilingFt,5000);
 assert.equal(value.clouds.layers.length,3);assert.equal(value.visibilityQualifier,'≥');
 assert.equal(value.windSpeedKt,5);assert.equal(value.trendRaw,'TEMPO 3000 RA BR BKN005');
 assert.equal(value.raw,raw);assert.equal(value.source,'IEM ASOS archive');
 const decoded=decodeMetarReport(report(raw));
 assert.deepEqual(decoded.conditions.weather,['Light rain']);assert.equal(decoded.conditions.sky.length,3);
 assert.ok(decoded.sections.some(s=>s.heading==='Trend forecast (not observed)'&&s.lines[0].value===value.trendRaw));
});
test('BECMG and standalone FM/TL/AT cannot fill missing observed fields or import CAVOK',()=>{
 for(const prefix of ['BECMG FM1100 TL1200','TEMPO AT1100','FM1100','TL1200','AT1100']){
  const value=parseMeteogramObservation(report(`LOWL 171050Z /////KT 4000 -SN OVC020 00/M01 Q0997 ${prefix} 27030G40KT CAVOK`));
  assert.equal(value.windSpeedKt,null);assert.equal(value.visibilityDisplay,'4000 M');
  assert.deepEqual(value.weatherCodes,['-SN']);assert.equal(value.clouds.ceilingFt,2000);assert.equal(value.clouds.cavok,false);
  const decoded=decodeMetarReport(report(`LOWL 171050Z 09005KT 4000 -SN OVC020 00/M01 Q0997 ${prefix} 27030G40KT CAVOK`));
  assert.equal(decoded.conditions.winds.length,1);assert.equal(decoded.conditions.visibility.length,1);
 }
});
test('NOSIG retained as trend; recent weather and remarks do not become current weather',()=>{
 const original='LOWL 171050Z 09005KT 9999 FEW050 08/07 Q0997 RERA NOSIG RMK AO2 P0012';
 const v=parseMeteogramObservation(report(original));assert.deepEqual(v.weatherCodes,[]);assert.equal(v.trendRaw,'NOSIG');
 assert.equal(v.precipitation.liquidEquivalentIn,.12);assert.equal(v.precipitation.rainObserved,false);
 assert.equal(splitMetarSections(original).remarksRaw,'AO2 P0012');
});
test('trend snow does not invent observed snowfall and remarks survive',()=>{
 const v=parseMeteogramObservation(report('LOWL 171050Z 09005KT 9999 FEW050 08/07 Q0997 TEMPO 1000 SN BKN005 RMK AO2'));
 assert.equal(v.precipitation.snowObserved,false);assert.equal(v.clouds.ceilingFt,null);assert.deepEqual(v.weatherCodes,[]);
});
test('TAF change groups remain forecast blocks, not stripped as METAR trend',()=>{
 const d=decodeTafReport('TAF LOWL 171000Z 1710/1810 09005KT 9999 FEW050 TEMPO 1711/1713 3000 RA BR BKN005',{referenceTime:new Date('2026-11-17T10:00:00Z')});
 assert.equal(d.blocks.length,2);assert.equal(d.blocks[1].type,'TEMPORARY');assert.deepEqual(d.blocks[1].conditions.weather,['rain','mist']);
});

test('all observed graph fields are invariant under international trend additions',()=>{
 const bodies=[
  '09005KT 9999 -RA FEW005 SCT010 BKN050 08/07 Q0997',
  'VRB03KT CAVOK 12/10 Q1015',
  '27012G22KT 1 1/2SM -TSRA BR BKN015CB OVC030 18/17 A2992',
  '00000KT M1/4SM FG VV002 M02/M03 A3002',
  '12010MPS 1500 R18/0600U +SN BKN006 M05/M06 Q0992',
  '/////KT //// ////// 08/07 Q1000',
 ];
 const trends=['TEMPO FM1100 TL1200 3000 RA BR BKN005','BECMG AT1200 27020G35KT CAVOK','TEMPO 1/4SM +SN OVC001','NOSIG'];
 for(const body of bodies)for(const trend of trends){
  const base=`LOWL 171050Z ${body}`;
  const baseline=parseMeteogramObservation(report(`${base} RMK AO2 P0001`));
  const changed=parseMeteogramObservation(report(`${base} ${trend} RMK AO2 P0001`));
  for(const key of Object.keys(baseline).filter(k=>!['raw','trendRaw'].includes(k)))assert.deepEqual(changed[key],baseline[key],`${body}: ${trend}: ${key}`);
  const decodedBase=decodeMetarReport(report(`${base} RMK AO2 P0001`));
  const decodedChanged=decodeMetarReport(report(`${base} ${trend} RMK AO2 P0001`));
  for(const key of ['conditions','temperatureC','dewPointC','remarks'])assert.deepEqual(decodedChanged[key],decodedBase[key],`decoded ${key}`);
 }
});

test('0000 is less than 50 metres, NDV does not erase visibility or alter its limits', async()=>{
 const {formatMeteogramVisibility,buildTafForecastBuckets}=await import('../weather-meteogram-core.js');
 for(const [token,metres,qualifier] of [['0000',50,'<'],['0000NDV',50,'<'],['9999NDV',10000,'≥'],['3500NDV',3500,'']]){
  const value=parseMeteogramObservation(report(`LOWL 171050Z AUTO 09005KT ${token} FG VV001 08/07 Q0997 TEMPO 9999 NSW`));
  assert.equal(value.visibilitySm,metres/1609.344);assert.equal(value.visibilityQualifier,qualifier);
  assert.equal(formatMeteogramVisibility(value,'M'),`${qualifier}${metres.toLocaleString('en-US')} m`);
  const decoded=decodeMetarReport(report(`LOWL 171050Z AUTO 09005KT ${token} FG VV001 08/07 Q0997`));
  assert.equal(decoded.conditions.visibility.length,1);
  if(token.startsWith('0000'))assert.equal(decoded.conditions.visibility[0],'Less than 50 metres');
 }
 const result=buildTafForecastBuckets({station:'LOWL',timestamp:'2026-11-17T10:00:00Z',product:'TAF',raw:'TAF LOWL 171000Z 1710/1810 09005KT 0000 FG VV001'},{station:'LOWL',now:new Date('2026-11-17T10:50:00Z')});
 assert.ok(result.buckets.length);assert.equal(result.buckets[0].visibilityQualifier,'<');
 assert.equal(formatMeteogramVisibility(result.buckets[0],'M'),'<50 m');
});
