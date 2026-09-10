// A turn can be running and stuck. The beacon is the difference between those
// two, and the alarm must fire once per stall rather than once per check.
import { createBeacons, wedgeMessage } from '../src/core/beacon.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

let clock = 1_000_000;
const b = createBeacons({ now: () => clock });
const STALL = 60_000;
const RENOTIFY = 300_000;
const due = () => b.due({ stallMs: STALL, renotifyMs: RENOTIFY });

b.start('s1', { model: 'opus' });
check('a fresh turn is not stalled', due().length === 0);

clock += 30_000;
check('still fine below the threshold', due().length === 0);

clock += 40_000;                       // 70s of silence
const first = due();
check('a silent turn is reported', first.length === 1, JSON.stringify(first[0]?.sessionId));
check('and it says how long it has been quiet', first[0].silentMs === 70_000);

check('but not reported again immediately', due().length === 0);
clock += RENOTIFY - 1;
check('nor inside the renotify window', due().length === 0);
clock += 2;
check('and again once that window passes', due().length === 1);

// ---- progress clears the alarm, so a recovery-then-stall is reported afresh
b.touch('s1', 'bash npm test');
check('a beat clears the stall', b.all({ stallMs: STALL })[0].stalled === false);
clock += STALL + 1;
const second = due();
check('a fresh stall after recovery is reported immediately', second.length === 1);
check('and it names what it was last doing', second[0].lastActivity === 'bash npm test', second[0].lastActivity);

// ---- a finished turn is not a stalled one
b.stop('s1');
clock += 10 * STALL;
check('a finished turn never alarms', due().length === 0);
check('and is no longer tracked', b.all().length === 0);

// ---- several turns are tracked independently
b.start('a'); b.start('b');
clock += STALL + 1;
b.touch('b');
const mixed = due().map((x) => x.sessionId);
check('only the quiet one is reported', mixed.length === 1 && mixed[0] === 'a', JSON.stringify(mixed));

const msg = wedgeMessage({ sessionName: 'GetJobs', model: 'opus', silentMs: 420_000, lastActivity: 'bash sleep 900' });
check('the message names the session', msg.includes('GetJobs'), msg);
check('and the minutes', msg.includes('7 minutes'));
check('and what it was doing', msg.includes('sleep 900'));

console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
