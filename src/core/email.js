/**
 * Sending mail from a session.
 *
 * Every session can reach the user by email, which is the one channel that
 * works when he is away from the harness entirely. Delivery goes through
 * Resend: an API key rather than his Google password, and no OAuth dance.
 *
 * The key lives in the harness's secrets store, which sessions cannot read —
 * they call this tool, they never see the credential. The destination is fixed
 * to the configured owner address for the same reason: a session's job is to
 * tell the user something, not to be a general mail relay that could be aimed
 * anywhere.
 */

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend will send from `onboarding@resend.dev` without a verified domain,
 * which is what makes this work with nothing but an API key.
 */
const DEFAULT_FROM = 'Harness <onboarding@resend.dev>';

export function isConfigured(cfg) {
  return Boolean(cfg?.apiKey && cfg?.to);
}

/**
 * @param cfg  { apiKey, to, from? }
 * @param msg  { subject, text, session? }
 */
export async function sendEmail(cfg, { subject, text, session }, { fetchImpl = fetch } = {}) {
  if (!cfg?.apiKey) throw new Error('no Resend API key configured — add one in the harness settings');
  if (!cfg?.to) throw new Error('no destination address configured in the harness settings');
  if (!subject?.trim()) throw new Error('an email needs a subject');
  if (!text?.trim()) throw new Error('an email needs a body');

  // Which session sent it matters when several are running unattended.
  const footer = session ? `\n\n—\nsent by harness session: ${session}` : '';

  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: cfg.from || DEFAULT_FROM,
      to: [cfg.to],
      subject: subject.trim(),
      text: text.trim() + footer,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Resend's own message is more useful than the status code alone, and a
    // session that cannot mail out should be told why rather than left to
    // guess it worked.
    throw new Error(`resend refused (${res.status}): ${body.message ?? body.name ?? 'unknown error'}`);
  }
  return { id: body.id ?? null, to: cfg.to };
}
