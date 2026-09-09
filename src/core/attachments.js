/**
 * Images attached to a message.
 *
 * Two things a phone forces you to handle. iPhones shoot HEIC, which most model
 * APIs will not accept, and they shoot large — a 12 MP photo is several
 * megabytes and becomes an enormous number of tokens once it is base64'd into a
 * request. So everything is normalised to JPEG and bounded on the long edge
 * before it is stored. `sips` ships with macOS, so this needs no dependency.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_EDGE = 1568;      // beyond this, models downscale anyway
export const MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff']);
export const isImage = (name) => IMAGE_EXT.has(path.extname(name).toLowerCase());

export function attachmentsDir(userDataDir, sessionId) {
  return path.join(userDataDir, 'attachments', sessionId);
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout ?? '').trim(), err: (stderr ?? '').trim() }));
  });

/**
 * Store one uploaded image, converting and shrinking as needed.
 * Returns the record that goes on the message.
 */
export async function store(userDataDir, sessionId, { name, buffer }) {
  if (buffer.length > MAX_BYTES) throw new Error(`image is ${Math.round(buffer.length / 1e6)} MB; limit is 25 MB`);

  const dir = attachmentsDir(userDataDir, sessionId);
  await fs.mkdir(dir, { recursive: true });

  const safe = (name || 'image').replace(/[^\w.-]+/g, '_').slice(-60);
  const stamp = Date.now().toString(36);
  const raw = path.join(dir, `${stamp}-raw${path.extname(safe) || '.img'}`);
  await fs.writeFile(raw, buffer);

  // Normalise to JPEG and cap the long edge. HEIC in particular has to go.
  const out = path.join(dir, `${stamp}-${safe.replace(/\.[^.]+$/, '')}.jpg`);
  const conv = await run('sips', ['-s', 'format', 'jpeg', '-Z', String(MAX_EDGE), raw, '--out', out]);

  if (!conv.ok) {
    // Fall back to the original bytes rather than losing the upload entirely.
    const st = await fs.stat(raw);
    return { name: safe, path: raw, mime: 'application/octet-stream', bytes: st.size, converted: false };
  }

  await fs.rm(raw, { force: true });
  const st = await fs.stat(out);
  return { name: safe, path: out, mime: 'image/jpeg', bytes: st.size, converted: true };
}

/** Read an attachment back as a data URL, for providers that inline images. */
export async function toDataUrl(att) {
  const buf = await fs.readFile(att.path);
  return `data:${att.mime === 'application/octet-stream' ? 'image/jpeg' : att.mime};base64,${buf.toString('base64')}`;
}
