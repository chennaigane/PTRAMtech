import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {checkProduction} from '../scripts/check-production.mjs';

const {privateKey} = generateKeyPairSync('rsa', {modulusLength:2048});
const valid = {
  NODE_ENV:'production', APP_ORIGIN:'https://work.company.in',
  DATABASE_PATH:'/srv/ptraam/data/ptraam.sqlite', WORKFORCE_JOB_TOKEN:'a'.repeat(40),
  GOOGLE_SPREADSHEET_ID:'workbook-id', GOOGLE_CLIENT_EMAIL:'reports@company.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}).replace(/\n/g,'\\n'),
  GOOGLE_REPORT_VIEWERS:JSON.stringify({admin:'admin@company.in'}),
};
test('production config accepts escaped RSA PEM and optional disabled relay', () => {
  assert.deepEqual(checkProduction(valid), []);
});
test('production config rejects placeholders, unsafe database location and malformed secrets without exposing them', () => {
  const errors = checkProduction({...valid,APP_ORIGIN:'https://app.example.com',DATABASE_PATH:'/srv/ptraam/app/data.sqlite',GOOGLE_PRIVATE_KEY:'private-secret-marker',WORKFORCE_JOB_TOKEN:'short',EMERGENCY_WEBHOOK_URL:'https://evil.invalid/exec'});
  assert.ok(errors.length >= 6);
  assert.ok(!errors.join(' ').includes('private-secret-marker'));
});
