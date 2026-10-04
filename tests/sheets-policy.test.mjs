import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sharingIssues,canonicalCells} from '../lib/sheets-policy.ts';
const account='integration@example.com',viewer='admin@example.com';
const permissions=[{type:'user',role:'owner',emailAddress:'owner@example.com'},{type:'user',role:'writer',emailAddress:account},{type:'user',role:'reader',emailAddress:viewer}];
test('only integration writer and approved viewers, with owner exception',()=>{assert.deepEqual(sharingIssues(permissions,account,[viewer],false),[]);});
test('employee, public, group and extra editor access are rejected',()=>{for(const p of [{type:'user',role:'reader',emailAddress:'employee@example.com'},{type:'anyone',role:'reader'},{type:'group',role:'reader',emailAddress:viewer},{type:'user',role:'writer',emailAddress:viewer}])assert.ok(sharingIssues([...permissions,p],account,[viewer],false).length);});
test('viewer copying, integration Editor and missing viewer checks',()=>{assert.ok(sharingIssues(permissions,account,[viewer],true).length);assert.ok(sharingIssues(permissions.slice(0,1),account,[viewer],false).length);});
test('normalization preserves types, formulas, interior blanks and extra rows',()=>{assert.equal(canonicalCells([['a',null],[]]),canonicalCells([['a']]));for(const cells of [[[1]],[['=1']],[['', 'a']],[['a'],['extra']]])assert.notEqual(canonicalCells(cells),canonicalCells([['a']]));assert.notEqual(canonicalCells([[1]]),canonicalCells([['1']]));});
