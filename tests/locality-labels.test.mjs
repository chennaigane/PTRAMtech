import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localityName,tripLocationLabel} from '../lib/trip-labels.ts';
import {parseAddress} from '../lib/reverse-geocode.ts';

const full='Hospital landmark, Main Street, 600001, India';
const parse=properties=>parseAddress({features:[{properties:{formatted:full,...properties}}]});
test('locality takes precedence over city, district, POIs, streets, postcodes and countries',()=>{
  const address=parse({suburb:'Royapuram',neighbourhood:'Smaller area',city:'Chennai',district:'Chennai district',name:'Hospital',street:'Main Street',postcode:'600001',country:'India'});
  assert.equal(address.name,'Royapuram');
  assert.equal(address.formatted,full);
  assert.equal(address.country,'India');
  assert.equal(tripLocationLabel({startLocation:{address}},'start'),'Royapuram');
  for(const area of ['Mylapore','Guindy','Manapakkam','Tambaram','Anna Nagar']){
    assert.equal(parse({suburb:area,city:'Chennai'}).name,area);
  }
});
test('worldwide structured locality names keep native spelling without appending country or city',()=>{
  for(const [field,name] of [['suburb','Kreuzberg'],['neighbourhood','Gr\u00e0cia'],['neighborhood','Brooklyn'],['suburb','\u65b0\u5bbf'],['suburb','\u0bae\u0baf\u0bbf\u0bb2\u0bbe\u0baa\u0bcd\u0baa\u0bc2\u0bb0\u0bcd']]){
    const address=parse({[field]:name,city:'Other city',country:'Country'});
    assert.equal(address.name,name);
    assert.equal(tripLocationLabel({endLocation:{address},status:'Pending'},'end'),name);
  }
});
test('fallback order is town, village, city, then district; whitespace and invalid fields are skipped',()=>{
  for(const [fields,expected] of [
    [{town:' Bath ',village:'Village',city:'City',district:'District'},'Bath'],
    [{suburb:' ',neighbourhood:null,town:42,village:'Hampi',city:'City',district:'District'},'Hampi'],
    [{city:'Tokyo',district:'District'},'Tokyo'],
    [{district:'West District'},'West District'],
  ]){
    assert.equal(parse(fields).name,expected);
    assert.equal(localityName(fields),expected);
  }
});
test('full addresses never become a fallback, including previously stored name and legacy strings',()=>{
  const address=parse({name:'Hospital',street:'Main Street',postcode:'600001',country:'India',state:'State'});
  assert.equal(address.name,'');assert.equal(address.formatted,full);
  assert.equal(tripLocationLabel({startLocation:{address}},'start'),'Locality unavailable');
  assert.equal(tripLocationLabel({startLocation:{address:{name:full,formatted:full,country:'India'}},from:full},'start'),'Locality unavailable');
  assert.equal(tripLocationLabel({from:full,to:full,status:'Pending'},'end'),'Locality unavailable');
  assert.equal(tripLocationLabel({startLocation:{lat:1,lng:2}},'start'),'Locality pending');
});
test('formatting old history is read-only and ignores the old combined display name',()=>{
  const data={from:full,to:full,startLocation:{lat:13,lng:80,accuracy:5,time:1,address:{locality:'Guindy',city:'Chennai',name:full,formatted:full}},endLocation:{lat:14,lng:81,accuracy:7,time:2,address:{locality:'Tambaram',city:'Chennai',name:full,formatted:full}},points:[{lat:13,lng:80,time:1},{lat:14,lng:81,time:2}],km:5.5,status:'Approved'};
  const before=structuredClone(data);
  assert.equal(tripLocationLabel(data,'start'),'Guindy');
  assert.equal(tripLocationLabel(data,'end'),'Tambaram');
  assert.deepEqual(data,before);
  assert.equal(tripLocationLabel({...data,status:'Travelling'},'end'),'Travelling');
});
