import { loadSecrets } from './secrets.js';

export const TRANSCRIPTION_KEY = '__transcription';
export const MAX_AUDIO_BYTES = 20_000_000;
const formats = { 'audio/mp4': 'mp4', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };
const failure = (status, message) => Object.assign(new Error(message), { status });

export async function transcriptionKey(dir) {
  return (await loadSecrets(dir))[TRANSCRIPTION_KEY] || process.env.OPENAI_API_KEY || '';
}

export async function transcribe(req, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw failure(503, 'Add your OpenAI API key using Voice setup in Settings.');
  const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!formats[mime]) throw failure(415, 'Unsupported recording format. Try Safari or Chrome.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw failure(413, 'Recording too large. Please record a shorter message.');
    chunks.push(chunk);
  }
  if (!size) throw failure(400, 'The recording was empty. Please try again.');
  const form = new FormData();
  form.set('model', 'gpt-transcribe');
  form.set('file', new Blob(chunks, { type: mime }), `recording.${formats[mime]}`);
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw failure(502, 'Transcription could not reach OpenAI. Please retry.');
  }
  if (!response.ok) {
    const message = response.status === 401 ? 'OpenAI rejected the API key. Update it in Voice setup.'
      : response.status === 429 ? 'OpenAI transcription quota or rate limit reached. Check API billing or retry shortly.'
        : 'OpenAI could not transcribe this recording. Please retry.';
    throw failure(502, message);
  }
  const result = await response.json();
  if (typeof result.text !== 'string') throw failure(502, 'OpenAI returned no transcript. Please retry.');
  return { text: result.text.trim() };
}
