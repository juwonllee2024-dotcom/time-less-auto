import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const content = fs.readFileSync(path.join(import.meta.dirname, '..', 'content.js'), 'utf8');

test('content exposes plan response and real-message verification hooks', () => {
  assert.match(content, /SEND_TLA_PLAN_PROMPT/);
  assert.match(content, /READ_TLA_PLAN_RESPONSE/);
  assert.match(content, /VERIFY_TLA_MESSAGE/);
  assert.match(content, /TLA_ROLE_PACKET/);
});
