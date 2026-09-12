// Apps are the durable things: a session comes and goes, an app survives a
// reboot with its directory, repo, port and both of its addresses.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as apps from '../src/core/apps.js';
import { HARNESS_ROOT } from '../src/core/harness-guard.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-'));
const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'));

check('only the built-in Harness app to begin with', (await apps.load(data)).filter((x) => x.id !== '__harness').length === 0);

const a = await apps.create(data, { name: 'Job Applier', dir: proj, start: 'echo hi' });
check('an app gets an id', Boolean(a.id), a.id);
check('and its own app port', a.port >= 4300 && a.port <= 4399, String(a.port));
check('and its own publish port', a.servePort >= 8443, String(a.servePort));
check('never the harness port', a.port !== 8787 && a.servePort !== 8787);

const b = await apps.create(data, { name: 'Second', dir: `${proj}-two`, start: '' });
check('a second app gets different ports', b.port !== a.port && b.servePort !== a.servePort,
  `${a.port}/${a.servePort} vs ${b.port}/${b.servePort}`);

// ---- it must survive the process, which is the whole point
const reloaded = (await apps.load(data)).filter((x) => x.id !== '__harness');
check('apps persist to disk', reloaded.length === 2);
check('with their ports intact', reloaded.find((x) => x.id === a.id).port === a.port);

// ---- both addresses, always
const urls = apps.urlsFor(a, 'example-host.ts.net');
check('a phone address is published', urls.phone === `https://example-host.ts.net:${a.servePort}`, urls.phone);
check('a laptop address is too', urls.desktop === `http://127.0.0.1:${a.port}`, urls.desktop);
const noTs = apps.urlsFor(a, null);
check('with tailscale down, the laptop address still works', noTs.desktop && noTs.phone === null);

// ---- the harness protects itself here as well
let refused = false;
try { await apps.create(data, { name: 'evil', dir: HARNESS_ROOT }); } catch { refused = true; }
check('an app cannot be rooted on the harness', refused);
let dupe = false;
try { await apps.create(data, { name: 'again', dir: proj }); } catch { dupe = true; }
check('two apps cannot claim one directory', dupe);

// ---- ports can be corrected, but never onto the harness or another app
const patched = await apps.update(data, a.id, { name: 'Renamed', port: 4390 });
check('a rename sticks', patched.name === 'Renamed');
check('and a port can be corrected to a real one', patched.port === 4390, String(patched.port));

const refusals = [];
for (const patch of [{ port: 8787 }, { servePort: 443 }, { port: b.port }, { port: 99 }]) {
  try { await apps.update(data, a.id, patch); refusals.push(null); }
  catch (e) { refusals.push(e.message); }
}
check('the harness port is refused', /belongs to the harness/.test(refusals[0] ?? ''), refusals[0]);
check('so is 443', /belongs to the harness/.test(refusals[1] ?? ''), refusals[1]);
check("another app's port is refused", /already uses/.test(refusals[2] ?? ''), refusals[2]);
check('nonsense is refused', /not a usable port/.test(refusals[3] ?? ''), refusals[3]);
check('and none of that changed the app', (await apps.load(data)).find((x) => x.id === a.id).port === 4390);
await apps.update(data, a.id, { port: a.port });   // put it back for the run test

// ---- starting and stopping something real
const started = await apps.start(data, b.id).catch((e) => ({ error: e.message }));
check('an app with no start command refuses honestly', /no start command/.test(started.error ?? ''), started.error);

await apps.update(data, a.id, {
  start: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`,
});
const run = await apps.start(data, a.id);
await new Promise((r) => { setTimeout(r, 1200); });
check('it is running', await apps.isRunning(run.app));
const res = await fetch(`http://127.0.0.1:${a.port}`).then((r) => r.text()).catch((e) => e.message);
check('and actually answering on its port', res === 'ok', res);

const listed = (await apps.listWithStatus(data)).find((x) => x.id === a.id);
check('the dashboard sees it as running', listed.running === true);

const stopped = await apps.stop(data, a.id);
check('stopping it is confirmed, not assumed', stopped.stopped === true && !stopped.unconfirmed);
check('and it is really gone', !(await apps.isRunning(run.app)));

// ---- detection by folder, not just by the allocated port
// A session that started a server picked its own port, so checking only the
// allocated one reported plainly-running apps as stopped.
const fake = { id: 'x', name: 'Flight', dir: '/Users/someone/Projects/flightfinder', port: 4303 };
const procs = [
  { pid: 1, port: 8787, cwd: '/Users/someone/Projects/harness' },
  { pid: 2, port: 4340, cwd: '/Users/someone/Projects/flightfinder' },
];
const info = apps.runningInfo(fake, procs);
check('an app is found by its folder, on any port', info.running === true);
check('and reports the port it is really on', info.port === 4340, String(info.port));
check('marked as started outside the dashboard', info.adopted === true);
check('with the pid to stop', info.pids.includes(2));

const onAllocated = apps.runningInfo(fake, [{ pid: 3, port: 4303, cwd: '/elsewhere' }]);
check('the allocated port still counts', onAllocated.running && onAllocated.port === 4303);
check('and is not treated as adopted', onAllocated.adopted === false);

check('an unrelated process is not claimed',
  apps.runningInfo(fake, [{ pid: 4, port: 5000, cwd: '/Users/someone/Projects/other' }]).running === false);
check('a sibling folder with a shared prefix is not claimed',
  apps.runningInfo(fake, [{ pid: 5, port: 5001, cwd: '/Users/someone/Projects/flightfinder-old' }]).running === false);
check('a subfolder of the app does count',
  apps.runningInfo(fake, [{ pid: 6, port: 5002, cwd: '/Users/someone/Projects/flightfinder/server' }]).running === true);
check('a process with no cwd is ignored rather than guessed at',
  apps.runningInfo(fake, [{ pid: 7, port: 5003, cwd: null }]).running === false);

// The dangerous case, and a real incident: an app whose directory is broad
// must not claim every process beneath it. Matching is what `stop` kills by,
// so a claim this wide takes down unrelated servers — it took down the harness
// itself and three of the user's apps.
const broad = [
  { pid: 10, port: 8787, cwd: '/Users/someone/Projects/harness' },
  { pid: 11, port: 4340, cwd: '/Users/someone/Projects/flightfinder' },
  { pid: 12, port: 3000, cwd: '/Users/someone/Desktop/unrelated' },
];
for (const dir of ['/Users', '/Users/someone', '/', os.homedir()]) {
  const r = apps.runningInfo({ id: 'b', name: 'Broad', dir, port: null }, broad);
  check(`a ${dir} directory claims nothing`, r.running === false && r.pids.length === 0,
    `${dir} -> ${JSON.stringify(r.pids)}`);
}
check('a broad directory still matches its own allocated port',
  apps.runningInfo({ id: 'b', name: 'Broad', dir: '/Users', port: 4340 }, broad).pids.includes(11));
check('the harness process itself is never claimed',
  apps.runningInfo({ id: 'h', name: 'Self', dir: '/Users/x/y/z', port: null },
    [{ pid: process.pid, port: 9999, cwd: '/Users/x/y/z' }]).running === false);

// the real machine, as a sanity check that parsing works at all
const real = await apps.listeningProcesses();
check('listening processes are enumerated with ports', real.length > 0 && real.every((r) => Number.isInteger(r.port)),
  `${real.length} listeners`);
check('and at least one has a working directory', real.some((r) => r.cwd));

// ---- deleting for good
// The folder is the one action with no undo, so the refusals matter more than
// the happy path.
const home = os.homedir();
check('the root of the disk is refused', Boolean(apps.refuseToDeleteDir('/')));
check('a shallow path is refused', Boolean(apps.refuseToDeleteDir('/Users')));
check('the home folder is refused', Boolean(apps.refuseToDeleteDir(home, home)));
check('a folder containing home is refused', Boolean(apps.refuseToDeleteDir(path.dirname(home), home)));
check('the harness itself is refused', Boolean(apps.refuseToDeleteDir(HARNESS_ROOT)));
check('nothing recorded is refused', Boolean(apps.refuseToDeleteDir('')));
check('a real project folder is allowed', apps.refuseToDeleteDir(`${home}/Projects/some-app`, home) === null);

// record only: the folder must survive
await fs.writeFile(path.join(proj, 'keep.txt'), 'still here');
const kept = await apps.destroy(data, a.id, { files: false });
check('the app record is gone', (await apps.load(data)).every((x) => x.id !== a.id));
check('but its folder is untouched', (await fs.readFile(path.join(proj, 'keep.txt'), 'utf8')) === 'still here');
check('and the deletion reports the name', kept.name === 'Renamed', kept.name);

// files too: the folder really goes
const proj2 = await fs.mkdtemp(path.join(os.tmpdir(), 'doomed-'));
await fs.writeFile(path.join(proj2, 'bye.txt'), 'x');
const c = await apps.create(data, { name: 'Doomed', dir: proj2, start: '' });
const gone = await apps.destroy(data, c.id, { files: true });
check('the folder is deleted when asked', gone.dir === path.resolve(proj2), JSON.stringify(gone.dir));
check('and is really off the disk', !(await fs.stat(proj2).then(() => true).catch(() => false)));
check('with no error reported', gone.dirError === null, String(gone.dirError));

// An unsafe directory can only get in by someone hand-editing apps.json —
// create and update both refuse it — so the delete-time check is the last line
// of defence and is tested the way it would actually be reached.
const d2 = await apps.create(data, { name: 'Weird', dir: `${proj}-weird`, start: '' });
const onDisk = JSON.parse(await fs.readFile(apps.appsPath(data), 'utf8'));
onDisk.apps.find((x) => x.id === d2.id).dir = '/Users';
await fs.writeFile(apps.appsPath(data), JSON.stringify(onDisk));
const refusedDel = await apps.destroy(data, d2.id, { files: true });
check('an unsafe folder is kept, with a reason', Boolean(refusedDel.dirError), refusedDel.dirError);
check('and /Users is still there', await fs.stat('/Users').then(() => true).catch(() => false));

let missing = false;
try { await apps.destroy(data, 'nope'); } catch { missing = true; }
check('deleting an app that does not exist is an error', missing);

// ---- a launchd-supervised app must actually stop, not respawn
// A session can register its server with `launchctl submit`, so killing the
// process just makes launchd start a new one. Stop has to unregister the job.
// This runs a real launchd job, so it is macOS-only and cleans up after itself.
if (process.platform === 'darwin') {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const supervised = await fs.mkdtemp(path.join(os.tmpdir(), 'supervised-'));
  const safeLabel = 'harness.test-safe-' + Date.now().toString(36);
  const mineLabel = 'harness.test-mine-' + Date.now().toString(36);
  try {
    // one job that names the app's dir, one unrelated job that must survive
    await run('launchctl', ['submit', '-l', mineLabel, '--', '/bin/sh', '-c', `cd ${supervised} && exec sleep 4000`]);
    await run('launchctl', ['submit', '-l', safeLabel, '--', '/bin/sh', '-c', 'exec sleep 4001']);
    await new Promise((r) => { setTimeout(r, 800); });

    const c = await apps.create(data, { name: 'Supervised', dir: supervised, start: '' });
    const res = await apps.stop(data, c.id);
    check('the launchd job for the app is removed', res.launchdRemoved.includes(mineLabel),
      JSON.stringify(res.launchdRemoved));
    check('an unrelated launchd job is left alone', !res.launchdRemoved.includes(safeLabel));

    const stillThere = await run('launchctl', ['list', mineLabel]).then(() => true).catch(() => false);
    check('and it is really gone from launchd', !stillThere);
    const safeAlive = await run('launchctl', ['list', safeLabel]).then(() => true).catch(() => false);
    check('while the unrelated job still runs', safeAlive);
  } finally {
    await run('launchctl', ['remove', mineLabel]).catch(() => {});
    await run('launchctl', ['remove', safeLabel]).catch(() => {});
    await fs.rm(supervised, { recursive: true, force: true });
  }
} else {
  console.log('SKIP  launchd stop test (not macOS)');
}

// ---- a shown link must be a live one
// The card calls an app "running" when its port is held, but the phone link is
// a Tailscale route and the laptop link needs the app to actually answer. A
// link is only presented once verified — the entertainment app once showed a
// link that went nowhere because a session started it with no route.
// Listeners run as child processes so runningInfo (which excludes this process)
// actually sees them.
{
  const { spawn } = await import('node:child_process');
  const child = (code, port) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: 'ignore', detached: true });
    return c;
  };
  // An app that answers HTTP.
  const up = child(`require('http').createServer((q,s)=>s.end('ok')).listen(4398,'127.0.0.1')`);
  // A port that is held but never answers HTTP.
  const hung = child(`require('net').createServer(()=>{}).listen(4397,'127.0.0.1')`);
  await new Promise((r) => { setTimeout(r, 800); });

  const dUp = await fs.mkdtemp(path.join(os.tmpdir(), 'linkup-'));
  await fs.writeFile(path.join(dUp, 'apps.json'),
    JSON.stringify({ apps: [{ id: 'up', name: 'Up', dir: '/tmp/nowhere-up', port: 4398, servePort: 8498, pid: null }] }));
  const au = (await apps.listWithStatus(dUp)).find((x) => x.id === 'up');
  check('an answering app is reachable', au.reachable === true, JSON.stringify({ r: au.reachable, run: au.running }));
  check('and gets a laptop link on its live port', au.urls.desktop === 'http://127.0.0.1:4398', String(au.urls.desktop));

  const dHung = await fs.mkdtemp(path.join(os.tmpdir(), 'linkhung-'));
  await fs.writeFile(path.join(dHung, 'apps.json'),
    JSON.stringify({ apps: [{ id: 'h', name: 'Hung', dir: '/tmp/nowhere-hung', port: 4397, servePort: 8497, pid: null }] }));
  const ah = (await apps.listWithStatus(dHung)).find((x) => x.id === 'h');
  check('a held-but-silent port is not reachable', ah.reachable === false, JSON.stringify({ r: ah.reachable, run: ah.running }));
  check('and offers no link', ah.urls.desktop === null && ah.urls.phone === null);

  try { process.kill(-up.pid); } catch { try { process.kill(up.pid); } catch {} }
  try { process.kill(-hung.pid); } catch { try { process.kill(hung.pid); } catch {} }
  await fs.rm(dUp, { recursive: true, force: true });
  await fs.rm(dHung, { recursive: true, force: true });
}

// ---- the built-in Harness app
const withBuiltin = await apps.load(data);
check('the Harness app is always present', withBuiltin.some((a) => a.id === '__harness'));
check('and is first in the list', withBuiltin[0].id === '__harness');
check('it is marked builtin and edits the harness', withBuiltin[0].builtin === true && withBuiltin[0].editsHarness === true);
let delErr = null, updErr = null;
try { await apps.destroy(data, '__harness'); } catch (e) { delErr = e.message; }
try { await apps.update(data, '__harness', { name: 'x' }); } catch (e) { updErr = e.message; }
check('it cannot be deleted', /built in/.test(delErr ?? ''), delErr);
check('it cannot be edited as a record', /built in/.test(updErr ?? ''), updErr);
// it is synthesised, never written to apps.json
const raw = JSON.parse(await fs.readFile(apps.appsPath(data), 'utf8'));
check('it is never persisted to apps.json', !raw.apps.some((a) => a.id === '__harness'), JSON.stringify(raw.apps.map((a)=>a.id)));

await fs.rm(data, { recursive: true, force: true });
await fs.rm(proj, { recursive: true, force: true });
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
