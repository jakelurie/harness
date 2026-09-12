import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { transcribe, MAX_AUDIO_BYTES } from '../src/core/transcription.js';

function request(chunks, mime = 'audio/mp4;codecs=mp4a.40.2') {
  return Object.assign(Readable.from(chunks), { headers: { 'content-type': mime } });
}
let calls = 0;
const upstream = async (url, options) => {
  calls++;
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(options.body.get('model'), 'gpt-transcribe');
  assert.equal(options.body.get('file').name, 'recording.mp4');
  assert.equal(await options.body.get('file').text(), 'audio');
  return Response.json({ text: ' Hello from my phone. ' });
};
assert.deepEqual(await transcribe(request([Buffer.from('audio')]), 'test-key', upstream), { text: 'Hello from my phone.' });
for (const [req, key, status] of [
  [request([]), '', 503],
  [request([]), 'test-key', 400],
  [request([], 'text/html'), 'test-key', 415],
  [request([Buffer.alloc(MAX_AUDIO_BYTES + 1)]), 'test-key', 413],
]) {
  await assert.rejects(() => transcribe(req, key, upstream), (error) => error.status === status);
}
assert.equal(calls, 1, 'invalid requests never reach OpenAI');
await assert.rejects(() => transcribe(request([Buffer.from('audio')]), 'test-key', async () => Response.json({ error: 'secret upstream detail' }, { status: 401 })), /rejected the API key/);
await assert.rejects(() => transcribe(request([Buffer.from('audio')]), 'test-key', async () => { throw new Error('private detail'); }), /could not reach OpenAI/);
await assert.rejects(() => transcribe(request([Buffer.from('audio')]), 'test-key', async () => Response.json({})), /no transcript/);
console.log('PASS transcription uploads, validation, size limit, and safe errors');
