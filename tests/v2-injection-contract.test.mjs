import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const background = fs.readFileSync(path.join(import.meta.dirname, '..', 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(import.meta.dirname, '..', 'content.js'), 'utf8');

test('background verifies packet injection before running a V2 turn', () => {
  assert.match(background, /SEND_TLA_ROLE_PACKET/);
  assert.match(background, /VERIFY_TLA_MESSAGE/);
  assert.match(background, /INJECTION_VERIFIED/);
  assert.match(background, /packetId/);
});

test('content packet delivery uses a normal user composer message', () => {
  assert.match(content, /SEND_TLA_ROLE_PACKET/);
  assert.match(content, /sendStandalonePrompt/);
  assert.match(content, /TLA ROLE PACKET/);
});
