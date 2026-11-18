import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveStationTimeZone,formatStationLocalTime} from '../aviation-weather-lookup-core.js';
import {formatMeteogramTime,buildMeteogramModel} from '../weather-meteogram-core.js';
import {meteogramCalendarDayRange,buildMeteogramPrintPlan,buildMeteogramPrintPagesMarkup,resolveMeteogramPrintRange} from '../weather-meteogram-print.js';
test('overseas airports override their misleading European ICAO prefix',()=>{
 assert.equal(resolveStationTimeZone('EGYP'),'Atlantic/Stanley');
 for(const id of ['LFVP','LFVM'])assert.equal(resolveStationTimeZone(id),'America/Miquelon');
 for(const date of ['2026-01-15T12:00:00Z','2026-07-15T12:00:00Z'])assert.equal(formatMeteogramTime(date,{station:'EGYP',mode:'LOCAL'}).time,'09:00');
 assert.equal(formatMeteogramTime('2026-01-15T12:00:00Z',{station:'LFVP',mode:'LOCAL'}).time,'09:00');
 assert.equal(formatMeteogramTime('2026-07-15T12:00:00Z',{station:'LFVM',mode:'LOCAL'}).time,'10:00');
});
test('station local time is independent of device timezone across world regions',()=>{
 const original=process.env.TZ;
 const cases=[['LOWL','13:00','14:00'],['KJFK','07:00','08:00'],['KPHX','05:00','05:00'],['PHNL','02:00','02:00'],['VIDP','17:30','17:30'],['YPAD','22:30','21:30'],['NZAA','01:00','00:00'],['RJTT','21:00','21:00'],['GCRR','12:00','13:00']];
 try{
  for(const deviceZone of ['Pacific/Honolulu','Asia/Tokyo','Europe/London']){
   process.env.TZ=deviceZone;
   for(const [station,winter,summer]of cases){
    assert.equal(formatMeteogramTime('2026-01-15T12:00:00Z',{station,mode:'LOCAL'}).time,winter,`${station} winter on ${deviceZone}`);
    assert.equal(formatMeteogramTime('2026-07-15T12:00:00Z',{station,mode:'LOCAL'}).time,summer,`${station} summer on ${deviceZone}`);
   }
  }
 }finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original}
});
test('LOWL DST repeat has distinct UTC offsets and calendar-day PDF ranges use 23/25 hours',()=>{
 const a=formatMeteogramTime('2026-10-25T00:30:00Z',{station:'LOWL',mode:'LOCAL'});
 const b=formatMeteogramTime('2026-10-25T01:30:00Z',{station:'LOWL',mode:'LOCAL'});
 assert.equal(a.time,'02:30');assert.equal(b.time,'02:30');assert.notEqual(a.zone,b.zone);
 assert.equal(meteogramCalendarDayRange({date:'2026-03-29',timeMode:'LOCAL',timeZone:'Europe/Vienna'}).durationHours,23);
 assert.equal(meteogramCalendarDayRange({date:'2026-10-25',timeMode:'LOCAL',timeZone:'Europe/Vienna'}).durationHours,25);
});
test('PDF station-local labels use station zone even when host device is elsewhere; unknown fails closed',()=>{
 const model=buildMeteogramModel([{station:'LOWL',timestamp:'2026-11-18T12:00:00Z',raw:'LOWL 181200Z 00000KT 9999 NCD 08/07 Q1013',product:'METAR'}],{station:'LOWL',now:new Date('2026-11-18T12:00:00Z')});
 const settings={timeMode:'LOCAL'},range=resolveMeteogramPrintRange({model,settings});
 const plan=buildMeteogramPrintPlan({model,settings,range});
 assert.match(plan.pages[0].svg,/>13:00<\/text>/);assert.match(plan.pages[0].svg,/GMT\+1/);
 assert.match(buildMeteogramPrintPagesMarkup(plan),/LOCAL/);
 assert.equal(resolveStationTimeZone('ZZZZ'),null);assert.equal(formatStationLocalTime('2026-11-18T12:00:00Z','ZZZZ'),'LOCAL TIME UNAVAILABLE');
 assert.equal(formatMeteogramTime('2026-11-18T12:00:00Z',{station:'ZZZZ',mode:'LOCAL'}).zone,'Z');
 assert.equal(resolveMeteogramPrintRange({model:{...model,station:'ZZZZ',timeZone:null},settings}).ok,false);
});
test('decoded/local text disambiguates repeated station clock hour with UTC offset',()=>{
 const early=formatStationLocalTime('2026-10-25T00:30:00Z','LOWL');
 const late=formatStationLocalTime('2026-10-25T01:30:00Z','LOWL');
 assert.match(early,/0230L \(UTC\+2\)/);assert.match(late,/0230L \(UTC\+1\)/);
 assert.notEqual(early,late);
});
