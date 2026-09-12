/**
 * Real text messages, by way of a carrier's email-to-SMS gateway.
 *
 * Every phone carrier accepts mail at an address derived from the number and
 * turns it into an SMS. That makes a genuine text possible with nothing but an
 * email account — no SMS provider, no number to rent, no monthly bill.
 *
 * Gmail is the sender because it is already his. It needs an app password
 * rather than the account password, which is a credential Google issues for
 * exactly this and can revoke on its own.
 *
 * A small SMTP client lives here instead of a dependency. The protocol needed
 * for one authenticated message is a handful of commands, and a mail library
 * would be a large amount of code to carry for that.
 */

import tls from 'node:tls';

/** Where each carrier accepts mail for a number. */
export const GATEWAYS = {
  verizon: 'vtext.com',
  att: 'txt.att.net',
  tmobile: 'tmomail.net',
  googlefi: 'msg.fi.google.com',
  sprint: 'messaging.sprintpcs.com',
  uscellular: 'email.uscc.net',
  cricket: 'mms.cricketwireless.net',
  boost: 'sms.myboostmobile.com',
  mint: 'tmomail.net',
  visible: 'vtext.com',
};

/** Ten digits, however the number was typed. */
export function digitsOf(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

export function addressFor(phone, carrier) {
  const host = GATEWAYS[String(carrier ?? '').toLowerCase()];
  const num = digitsOf(phone);
  if (!host || num.length !== 10) return null;
  return `${num}@${host}`;
}

/** Every gateway, for the first send when the carrier is not known yet. */
export function allAddressesFor(phone) {
  const num = digitsOf(phone);
  if (num.length !== 10) return [];
  return [...new Set(Object.values(GATEWAYS))].map((host) => `${num}@${host}`);
}

/**
 * One SMTP conversation over implicit TLS.
 *
 * Each command waits for its reply code; anything outside the 2xx/3xx range it
 * expects ends the session with the server's own words, because "it didn't
 * arrive" with no reason is the failure mode this whole feature exists to avoid.
 */
function smtpSend({ host, port, user, pass, from, to, subject, text, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host });
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);

    let buffer = '';
    let pending = null;
    const done = (result) => {
      if (!socket.destroyed) socket.end();
      resolve(result);
    };

    const expect = (codes) => new Promise((ok, fail) => { pending = { codes, ok, fail }; });

    socket.on('data', (chunk) => {
      buffer += chunk;
      // A reply may span lines; the last one has a space after the code.
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      const said = lines.join(' ').slice(0, 200);
      buffer = '';
      if (!pending) return;
      const { codes, ok, fail } = pending;
      pending = null;
      if (codes.includes(code)) ok(said);
      else fail(new Error(`${code}: ${said}`));
    });

    socket.on('timeout', () => done({ ok: false, reason: `no reply from ${host} within ${timeoutMs / 1000}s` }));
    socket.on('error', (e) => done({ ok: false, reason: e.message }));

    const say = (line) => socket.write(`${line}\r\n`);
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

    (async () => {
      try {
        await expect([220]);
        say('EHLO harness');
        await expect([250]);

        say('AUTH LOGIN');
        await expect([334]);
        say(b64(user));
        await expect([334]);
        // Google prints app passwords in groups of four; the spaces are display
        // only and must come out before it is sent.
        say(b64(String(pass).replace(/\s+/g, '')));
        await expect([235]);

        say(`MAIL FROM:<${from}>`);
        await expect([250]);

        const recipients = Array.isArray(to) ? to : [to];
        const accepted = [];
        const refused = [];
        for (const rcpt of recipients) {
          say(`RCPT TO:<${rcpt}>`);
          try { await expect([250, 251]); accepted.push(rcpt); }
          catch (e) { refused.push(`${rcpt} (${e.message})`); }
        }
        if (!accepted.length) {
          return done({ ok: false, reason: `every address was refused: ${refused.join('; ')}` });
        }

        say('DATA');
        await expect([354]);
        // Bare dots at the start of a line end the message early.
        const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        say([
          `From: ${from}`,
          `To: ${accepted.join(', ')}`,
          `Subject: ${subject ?? ''}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          body,
          '.',
        ].join('\r\n'));
        const receipt = await expect([250]);

        say('QUIT');
        return done({ ok: true, accepted, refused, via: receipt });
      } catch (e) {
        const msg = e.message ?? String(e);
        // The one failure worth naming precisely, because the fix is specific.
        if (/^535/.test(msg)) {
          return done({
            ok: false,
            reason: 'Gmail rejected the login. Use a 16-character app password from '
              + 'myaccount.google.com → Security → App passwords, not your normal password.',
          });
        }
        return done({ ok: false, reason: msg });
      }
    })();
  });
}

/**
 * Text a phone through its carrier's gateway.
 *
 * With no carrier set it sends to every gateway at once: the wrong ones drop
 * the message, the right one delivers, and the user can then say which arrived
 * so it can be pinned.
 */
export async function sendSms(cfg, text) {
  if (!cfg?.user || !cfg?.pass) return { ok: false, reason: 'no Gmail address and app password set' };
  if (!cfg?.to) return { ok: false, reason: 'no phone number set' };

  const addresses = cfg.carrier ? [addressFor(cfg.to, cfg.carrier)] : allAddressesFor(cfg.to);
  if (!addresses.length || addresses.some((a) => !a)) {
    return { ok: false, reason: `${cfg.to} is not a 10-digit US number, or ${cfg.carrier} is not a carrier I know` };
  }

  const res = await smtpSend({
    host: 'smtp.gmail.com',
    port: 465,
    user: cfg.user,
    pass: cfg.pass,
    from: cfg.user,
    // Gateways prepend the subject to the message body, so it stays empty.
    subject: '',
    text,
    to: addresses,
  });

  return res.ok
    ? { ok: true, via: `sms via ${addresses.length === 1 ? addresses[0] : `${addresses.length} carrier gateways`}` }
    : res;
}
