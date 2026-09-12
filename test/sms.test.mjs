// Texting through a carrier's email-to-SMS gateway. The addressing is the part
// that silently fails — a wrong gateway host just never arrives — so it is
// pinned down here.
import { GATEWAYS, digitsOf, addressFor, allAddressesFor, sendSms } from '../src/core/sms.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---- however the number is typed, the same ten digits come out
for (const [given, want] of [
  ['+15557654321', '5557654321'],
  ['15557654321', '5557654321'],
  ['555-765-4321', '5557654321'],
  ['(555) 765 4321', '5557654321'],
  ['5557654321', '5557654321'],
]) check(`"${given}" normalises`, digitsOf(given) === want, digitsOf(given));

check('a short number does not become an address', addressFor('12345', 'verizon') === null);
check('an unknown carrier does not become an address', addressFor('5557654321', 'orange') === null);
check('verizon addresses correctly', addressFor('+15557654321', 'verizon') === '5557654321@vtext.com');
check('carrier case does not matter', addressFor('5557654321', 'TMobile') === '5557654321@tmomail.net');

// With no carrier known, every gateway is tried once — duplicates collapsed,
// since several carriers share a host.
const all = allAddressesFor('5557654321');
check('every gateway is addressed', all.length > 5, String(all.length));
check('with no duplicates', new Set(all).size === all.length);
check('mint and t-mobile share one host, counted once',
  all.filter((a) => a.endsWith('@tmomail.net')).length === 1);
check('a bad number yields nothing rather than garbage', allAddressesFor('123').length === 0);
check('every gateway host looks like a domain',
  Object.values(GATEWAYS).every((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)));

// ---- refusals are explained, never silent
const cases = [
  [{ to: '5557654321' }, /app password/i, 'no credential'],
  [{ user: 'a@gmail.com', pass: 'x' }, /phone number/i, 'no number'],
  [{ user: 'a@gmail.com', pass: 'x', to: '123' }, /not a 10-digit/i, 'bad number'],
  [{ user: 'a@gmail.com', pass: 'x', to: '5557654321', carrier: 'orange' }, /not a carrier/i, 'bad carrier'],
];
for (const [cfg, pattern, label] of cases) {
  const r = await sendSms(cfg, 'hi');
  check(`${label} is refused with a reason`, r.ok === false && pattern.test(r.reason), r.reason);
}

console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
