import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { argv, buildOf, parseGpu, parseIni, parseUnit, sections, sshHosts, unitWarnings } from '../src/setup/ssh.ts';
import { magicPacket, wake } from '../src/setup/wol.ts';
import { Cancelled, fillStep, happened, runSteps } from '../src/setup/steps.ts';
import { createServer } from '../src/setup/panels.ts';
import { createStopped } from '../src/setup/ui.ts';
import { styles } from '../src/core/view.ts';
import { stripAnsi } from '../src/core/term.ts';
import { createLoader, bar } from '../src/setup/loader.ts';
import { PALETTE, SCENE, SPRITE } from '../src/core/header.ts';
import { startMock } from './fixtures/mock-llama.ts';
import * as llama from '../src/providers/llamacpp.ts';

test('ssh hosts come from the config and its Includes, without wildcards or git hosts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rime-ssh-'));
  fs.writeFileSync(path.join(dir, 'extra'), 'Host colima\n  HostName 127.0.0.1\n');
  fs.writeFileSync(path.join(dir, 'config'), `Host github.com\n  User git\nInclude ${dir}/extra\nHost gpubox\n  HostName 192.168.1.20\nHost gpubox-llm *.lan\n`);
  assert.deepEqual(sshHosts(path.join(dir, 'config')), ['colima', 'gpubox', 'gpubox-llm']);
});

test('reading the server: unit flags, version, GPU, presets.ini', () => {
  const u = parseUnit('[Service]\nExecStart=/home/me/llama.cpp/build/bin/llama-server \\\n  --models-preset /home/me/models/presets.ini --models-max 1 \\\n  --host 127.0.0.1 --port 8080\n')!;
  assert.equal(u.bin, '/home/me/llama.cpp/build/bin/llama-server');
  assert.equal(u.router, true);
  assert.equal(u.port, 8080);
  assert.equal(u.preset, '/home/me/models/presets.ini');
  assert.equal(parseUnit('nothing here'), null);
  assert.equal(buildOf('version: 11514 (1a2b3c4)'), 'b11514');
  assert.deepEqual(parseGpu('Example GPU 32GB, 32768, 30900, 71, 246.3, 250.00'), { name: 'Example GPU 32GB', memTotal: 32768, memUsed: 30900, temp: 71, power: 246.3, powerLimit: 250 });
  assert.deepEqual(parseIni('; models\n[qwen3.8-27b]\nmodel = /m/Qwen.gguf\nctx-size = 262144\n'), { 'qwen3.8-27b': { model: '/m/Qwen.gguf', 'ctx-size': '262144' } });
  assert.deepEqual(sections('###A\none\n###B\ntwo\nthree\n###END'), { A: 'one', B: 'two\nthree' });
  assert.deepEqual(argv(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
});

test('Wake-on-LAN sends a magic packet', async () => {
  const pkt = magicPacket('00:11:22:33:44:55');
  assert.equal(pkt.length, 102);
  assert.ok(pkt.subarray(0, 6).every((b) => b === 0xff));
  assert.equal(pkt.subarray(6, 12).toString('hex'), '001122334455');
  assert.throws(() => magicPacket('nope'));
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  const got = new Promise<Buffer>((r) => sock.once('message', r));
  await wake('00:11:22:33:44:55', '127.0.0.1', sock.address().port);
  assert.deepEqual(await got, pkt);
  sock.close();
});

// The steps against a fake ssh on PATH, a fake "machine" (a TCP listener) and a
// mock llama-server that starts stopped with nothing loaded.
async function rig(on: boolean) {
  const mock = await startMock({ started: false, loaded: false });
  const sshd = net.createServer((c) => c.end());
  const listen = () => new Promise<void>((r) => sshd.listen(sshdPort, '127.0.0.1', r));
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const sshdPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  if (on) await listen();
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rime-log-')), 'ssh.log');
  const env = { PATH: process.env.PATH, FAKE_SSHD_PORT: process.env.FAKE_SSHD_PORT, MOCK_LLAMA_PORT: process.env.MOCK_LLAMA_PORT, FAKE_SSH_LOG: process.env.FAKE_SSH_LOG };
  Object.assign(process.env, { PATH: `${path.resolve('test/fixtures/bin')}:${process.env.PATH}`, FAKE_SSHD_PORT: String(sshdPort), MOCK_LLAMA_PORT: String(mock.port), FAKE_SSH_LOG: log });
  // A port nothing listens on: the tunnel step must never find (and reuse) a real
  // llama-server forward on this machine, such as ssh -fN gpubox-llm on 8080.
  const free = net.createServer();
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
  const remote = `127.0.0.1:${(free.address() as net.AddressInfo).port}`;
  await new Promise<void>((r) => free.close(() => r()));
  return {
    mock,
    remote,
    listen,
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    async close() {
      Object.assign(process.env, env);
      sshd.close();
      await mock.close();
    },
  };
}

test('setup steps: connect, open the tunnel, start the service, load, warm, test', { timeout: 30000 }, async () => {
  const r = await rig(true);
  const tunnel = { child: null as any, port: 0 };
  try {
    const run = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, mac: '00:11:22:33:44:55', model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: true, effort: 'medium' }, tunnel, onUpdate: () => {} },
    );
    const overall: number[] = [];
    const res = await run.promise.finally(() => overall.push(run.state.overall));
    assert.deepEqual(run.state.steps.map((v) => [v.id, v.status]), [['wake', 'done'], ['connect', 'done'], ['tunnel', 'done'], ['start', 'done'], ['load', 'done'], ['warm', 'done'], ['test', 'done']]);
    assert.equal(run.state.steps[0].result, 'on', 'already awake');
    assert.equal(res.base, `http://127.0.0.1:${tunnel.port}/v1`);
    assert.equal(res.tps, 25);
    assert.equal(res.warm, 3120);
    assert.equal(r.mock.state.started && r.mock.state.loaded, true);
    assert.ok(r.log().some((a) => a.at(-1) === 'sudo systemctl start llama-server'));
    assert.equal(run.state.overall, 1);
    // Steps that are already satisfied finish instantly the second time.
    const again = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: true }, skip: ['test'], tunnel, onUpdate: () => {} },
    );
    await again.promise;
    assert.deepEqual(again.state.steps.map((v) => v.result), ['on', again.state.steps[1].result, 'open', 'running', 'loaded', '3,120 tokens', 'skip']);
  } finally {
    tunnel.child?.kill();
    await r.close();
  }
});

test('setup steps: a machine that is off is woken and waited for', { timeout: 30000 }, async () => {
  const r = await rig(false);
  const tunnel = { child: null as any, port: 0 };
  try {
    setTimeout(() => r.listen(), 1500); // it "boots" 1.5 s after the wake command
    const run = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: false }, edited: { wake: 'true' }, skip: ['test'], tunnel, onUpdate: () => {}, usualWakeSeconds: 3 },
    );
    const seen: number[] = [];
    const t = setInterval(() => seen.push(run.state.steps[0].progress ?? 0), 100);
    await run.promise.finally(() => clearInterval(t));
    assert.equal(run.state.steps[0].status, 'done');
    assert.match(run.state.steps[0].result, /^\d\.\ds$/);
    assert.ok(seen.some((p) => p > 0 && p < 1), 'progress shows while waiting');
  } finally {
    tunnel.child?.kill();
    await r.close();
  }
});

test('setup steps: a failing step stops the run with its error', { timeout: 15000 }, async () => {
  const r = await rig(true);
  const tunnel = { child: null as any, port: 0 };
  try {
    const run = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: true }, edited: { connect: 'exit 255' }, tunnel, onUpdate: () => {} },
    );
    await assert.rejects(run.promise, /ssh failed/);
    assert.equal(run.state.steps[1].status, 'fail');
    assert.equal(run.state.steps[2].status, 'todo');
  } finally {
    await r.close();
  }
});

test('setup steps: cancelling a load unloads it again and closes Rime\'s tunnel', { timeout: 30000 }, async () => {
  const r = await rig(true);
  const tunnel = { child: null as any, port: 0 };
  try {
    const run = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: true }, tunnel, onUpdate: (s) => s.steps[4].status === 'run' && run.cancel() },
    );
    await assert.rejects(run.promise, Cancelled);
    assert.deepEqual(run.state.steps.map((v) => v.status), ['done', 'done', 'done', 'done', 'stopped', 'todo', 'todo']);
    assert.ok(r.mock.state.requests.some((q) => q.path === '/models/unload'), 'POST /models/unload');
    assert.equal(tunnel.port, 0, 'Rime closed the tunnel it opened');
    assert.deepEqual(happened({ host: 'gpubox', model: 'qwen3.8-27b' }, run.state), ['opened Rime\'s tunnel (closed now)', 'started llama-server', 'loading qwen3.8-27b, unloaded again']);
  } finally {
    tunnel.child?.kill();
    await r.close();
  }
});

test('setup steps: cancelling the wake wait stops at once', { timeout: 15000 }, async () => {
  const r = await rig(false);
  const tunnel = { child: null as any, port: 0 };
  try {
    const run = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: false }, edited: { wake: 'true' }, tunnel, onUpdate: () => {} },
    );
    setTimeout(() => run.cancel(), 600);
    const t0 = Date.now();
    await assert.rejects(run.promise, Cancelled);
    assert.ok(Date.now() - t0 < 2000, 'no waiting for the machine');
    assert.equal(run.state.steps[0].status, 'stopped');
    assert.deepEqual(happened({ host: 'gpubox' }, run.state), ['stopped waiting for gpubox (it may still boot)']);
  } finally {
    await r.close();
  }
});

// /server against the mock: a server with nothing loaded offers to load it.
async function serverPanel(r: Awaited<ReturnType<typeof rig>>) {
  const said: string[] = [], calls: string[] = [];
  const cfg = { providers: { gpubox: { preset: 'llamacpp', ssh: 'gpubox', model: 'qwen3.8-27b', tunnel: { remote: r.remote } } }, models: {} };
  const panel = createServer({
    st: styles('none'), cfg, system: 'SYS', redraw() {}, close: () => calls.push('close'), setBuffer() {}, save() {}, activate() {}, open() {},
    say: (it: any) => said.push(it.text ?? ''), tunnel: () => ({ child: null, port: r.mock.port }), background() {},
    openSteps() {}, ensure: (n: string) => calls.push(`ensure ${n}`), down: (n: string) => calls.push(`down ${n}`), promptRate: () => undefined,
  } as any, 'gpubox');
  const text = () => panel.view(80).rows.map((x) => stripAnsi(x.line.map((c) => c.t).join(''))).join('\n');
  const until = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(text()); i++) await new Promise((res) => setTimeout(res, 50));
    assert.match(text(), re);
  };
  return { panel, text, until, said, calls };
}

test('/server: load the model back after an unload, and confirm before unloading', { timeout: 20000 }, async () => {
  const r = await rig(true);
  r.mock.state.started = true;
  try {
    const s = await serverPanel(r);
    await s.until(/no model loaded/);
    await s.until(/› Load qwen3\.8-27b/);
    s.panel.key({ name: 'enter' }, '');
    await s.until(/qwen3\.8-27b is loaded\./);
    assert.equal(r.mock.state.loaded, true);
    assert.ok(s.calls.includes('ensure gpubox'), 'the chat reconnects');
    await s.until(/› Unload model/);
    s.panel.key({ name: 'enter' }, '');
    assert.match(s.text(), /Unload qwen3\.8-27b\?[\s\S]*runs: POST \/models\/unload[\s\S]*› Unload\s+[\s\S]*Keep it loaded/);
    s.panel.key({ name: 'escape' }, '');
    assert.equal(r.mock.state.loaded, true, 'esc keeps it loaded');
    s.panel.key({ name: 'enter' }, '');
    s.panel.key({ name: 'enter' }, '');
    await s.until(/was unloaded/);
    assert.equal(r.mock.state.loaded, false);
    assert.ok(s.calls.includes('down gpubox'));
  } finally {
    await r.close();
  }
});

test('/server: ctrl+c stops a load part-way and unloads it again', { timeout: 20000 }, async () => {
  const r = await rig(true);
  r.mock.state.started = true;
  try {
    const s = await serverPanel(r);
    await s.until(/› Load qwen3\.8-27b/);
    s.panel.key({ name: 'enter' }, '');
    assert.match(s.text(), /loading qwen3\.8-27b/);
    s.panel.cancel!();
    await s.until(/Cancelled\. Loading was stopped and the model unloaded again/);
    assert.ok(r.mock.state.requests.some((q) => q.path === '/models/unload'));
  } finally {
    await r.close();
  }
});

test('the loader freezes him from the bottom row up', () => {
  const l = createLoader(() => 0.99);
  const now = 1000;
  const water = (g: ReturnType<typeof l.pixels>) => g.flat().filter((p) => p && !Object.values(PALETTE).includes(p) && p.join() !== '230,243,250').length;
  const total = SPRITE.join('').replace(/\./g, '').length;
  assert.equal(water(l.pixels(0, now)), total, 'all water at 0%');
  assert.equal(water(l.pixels(1, now)), 0, 'all ice at 100%');
  const half = l.pixels(0.25, now);
  const bottom = SCENE.SY + SPRITE.length - 1;
  assert.deepEqual(half[bottom][SCENE.SX], PALETTE.C, 'the bottom row freezes first');
  assert.notDeepEqual(half[SCENE.SY][SCENE.SX + 1], PALETTE.A, 'the top is still water');
  assert.equal(l.cells(0.5, now, 'truecolor').length, 3);
  assert.deepEqual(bar(0.5), { fill: '▰'.repeat(12), empty: '▱'.repeat(12), pct: ' 50%' });
});

test('V-1: /server works for a llama.cpp server added with /connect (no ssh actions)', { timeout: 20000 }, async () => {
  const mock = await startMock({ started: true, loaded: false });
  try {
    const cfg = { providers: { box: { preset: 'llamacpp', url: `${mock.url}/v1` } }, models: {} };
    const calls: string[] = [];
    const panel = createServer({
      st: styles('none'), cfg, system: 'SYS', redraw() {}, close() {}, setBuffer() {}, save() {}, activate() {}, open() {},
      say() {}, tunnel: () => { throw new Error('no tunnel for a direct server'); }, background() {},
      openSteps() {}, ensure: (n: string) => calls.push(`ensure ${n}`), down: (n: string) => calls.push(`down ${n}`), promptRate: () => undefined,
    } as any, 'box');
    const text = () => panel.view(80).rows.map((x) => stripAnsi(x.line.map((c) => c.t).join(''))).join('\n');
    for (let i = 0; i < 100 && !/Load qwen/.test(text()); i++) await new Promise((res) => setTimeout(res, 50));
    assert.match(text(), /online/);
    assert.match(text(), /no model loaded/);
    assert.match(text(), /Load qwen3\.8-27b/);
    assert.doesNotMatch(text(), /Restart server|Stop server|Power off|Show log|Edit steps/);
    panel.key({ name: 'enter' }, '');
    for (let i = 0; i < 100 && !/qwen3\.8-27b is loaded\./.test(text()); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(mock.state.loaded, true, text());
  } finally {
    await mock.close();
  }
});

test('V-2: a single-model server is loaded, not a router to POST /models/load to', async () => {
  const mock = await startMock({ started: true, single: true });
  try {
    assert.equal(await llama.routerModels(mock.url), null, 'a /models list without status is a single-model server');
  } finally {
    await mock.close();
  }
});

test('V-5: setup warns about a server Rime can only half use', () => {
  const unit = (exec: string) => parseUnit(`[Service]\nExecStart=${exec}\n`)!;
  assert.deepEqual(unitWarnings(unit('/opt/llama-server --models-preset /etc/p.ini --host 127.0.0.1 --slot-save-path /var/slots')), []);
  const w = unitWarnings(unit('/opt/llama-server -m /m/qwen.gguf --host 0.0.0.0 --cache-ram 0 --no-slots'));
  assert.equal(w.length, 5, w.join('\n'));
  assert.match(w.join('\n'), /--alias/);
  assert.match(w.join('\n'), /--no-slots/);
  assert.match(w.join('\n'), /--cache-ram 0/);
  assert.match(w.join('\n'), /--slot-save-path/);
  assert.match(w.join('\n'), /0\.0\.0\.0.*--api-key/);
  assert.equal(unitWarnings(unit('/opt/llama-server -m /m/q.gguf -a qwen --host 0.0.0.0 --api-key-file /k --slot-save-path /s')).length, 0);
});

test('V-10: cancelling while llama-server starts offers to stop it', { timeout: 30000 }, async () => {
  const r = await rig(true);
  const tunnel = { child: null as any, port: 0 };
  try {
    // The start command goes out, but the server takes a while to answer: cancel then.
    const run = runSteps(
      { name: 'gpubox', host: 'gpubox', remote: r.remote, model: 'qwen3.8-27b', router: true },
      { system: 'SYS', controls: { reasoning: true }, tunnel, edited: { start: 'true # slow start' }, onUpdate: (s) => s.steps[3].status === 'run' && (s.steps[3].progress ?? 0) > 0 && run.cancel() },
    );
    await assert.rejects(run.promise, Cancelled);
    assert.equal(run.state.steps[3].status, 'stopped');
    const panel = createStopped({ st: styles('none'), redraw() {}, say() {}, close() {} } as any, { name: 'gpubox', host: 'gpubox', state: run.state, after: '' }, () => {});
    const text = panel.view(80).rows.map((x) => stripAnsi(x.line.map((c) => c.t).join(''))).join('\n');
    assert.match(text, /Stop llama-server/);
  } finally {
    tunnel.child?.kill();
    await r.close();
  }
});

test('V-13: edited steps get {host} {port} {model} {mac} filled', () => {
  const s = { name: 'g', host: 'gpubox', remote: '127.0.0.1:8080', mac: 'aa:bb:cc:dd:ee:ff', model: 'qwen', router: true };
  assert.equal(fillStep('wol {mac} && ssh {host} load {model} -p {port}', s, 9000), 'wol aa:bb:cc:dd:ee:ff && ssh gpubox load qwen -p 9000');
  assert.equal(fillStep('ssh -L {port}:x {host}', s, 0), 'ssh -L {port}:x gpubox', 'an unknown port waits for the tunnel step');
});

test('V-14: Wake-on-LAN only waits for a machine on this network', async () => {
  const { onLan } = await import('../src/setup/wol.ts');
  const nets = [{ family: 'IPv4', internal: false, address: '192.168.1.5', netmask: '255.255.255.0' }] as any;
  assert.equal(onLan('192.168.1.20', nets), true);
  assert.equal(onLan('10.0.0.7', nets), false);
  assert.equal(onLan('gpubox.example', nets), true, "a name can't be told");
});
