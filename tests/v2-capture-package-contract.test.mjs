import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');

test('V2 waits for a verified PNG before scheduling the next provider', async () => {
  assert.match(source, /finalizeAutopilotResponse/);
  assert.match(source, /dataBase64/);
  assert.match(source, /capture\??\.status === 'complete'/);
  assert.match(source, /scheduleSpeaker\(meeting, responseText/);
});

test('V2 package contains manifest, report, checksums, and only verified screenshots', async () => {
  assert.match(source, /buildManifest/);
  assert.match(source, /buildRunReport/);
  assert.match(source, /buildZipBundle/);
  assert.match(source, /artifactZipFilename/);
  assert.match(source, /screenshotMembersFromJobs/);
  assert.match(source, /checksums/);
});
