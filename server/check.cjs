// node server/check.cjs — no real filesystem writes, secrets, sockets, PM2, journalctl or pkill.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const routes = new Map(), middleware = [], timers = [], children = [], commands = [], connections = [], writes = [];
const files = new Map(), descriptors = new Map();
let fd = 0, now = Date.now(), oauth, deserialize, cookieOptions, pm2Error, connectPending, commandError, pids = [], psOutput = '', syncFailure = false, holdKill;
let processes = [];
const app = { set() {}, disable() {}, listen() {}, use(...args) { middleware.push(args); } };
for (const method of ['get', 'post', 'delete']) app[method] = (url, ...handlers) => routes.set(`${method} ${url}`, handlers);
const express = Object.assign(() => app, { json: () => () => {}, static: () => () => {} });
const passport = { use() {}, serializeUser() {}, deserializeUser(fn) { deserialize = fn; }, initialize: () => () => {}, session: () => () => {}, authenticate: () => () => {} };
const subscriptions = path.join(__dirname, 'push-subscriptions.json');
let pushes = [];
const webpush = { setVapidDetails() {}, async sendNotification(sub, payload) { pushes.push({ sub, payload: JSON.parse(payload) }); } };
const missing = () => Object.assign(new Error('Missing test file'), { code: 'ENOENT' });
const mockFs = {
  readFileSync(file) { if (!files.has(file)) throw missing(); return files.get(file); },
  existsSync: file => files.has(file),
  openSync(file, flags) { writes.push(['open', file, flags]); if (flags === 'wx' && files.has(file)) throw new Error('Exists'); descriptors.set(++fd, file); return fd; },
  writeFileSync(file, contents) { files.set(typeof file === 'number' ? descriptors.get(file) : file, contents); writes.push(['write']); },
  fsyncSync() { if (syncFailure) throw new Error('Disk failure'); writes.push(['sync']); },
  closeSync: id => descriptors.delete(id),
  renameSync(from, to) { writes.push(['rename']); files.set(to, files.get(from)); files.delete(from); },
  rmSync: file => files.delete(file),
  realpathSync: file => file,
  lstatSync: () => ({ isSymbolicLink: () => false }),
  statSync(file) { if (!files.has(file)) throw missing(); return { isFile: () => true }; },
  statfsSync: () => ({ blocks: 100, bfree: 40, bavail: 30, bsize: 1024 }),
  readdirSync: () => [], readlinkSync: () => '/home/test/demo',
};
class PM2 {
  constructor() { connections.push(this); }
  connect(cb) { if (connectPending) connectPending.push(cb); else queueMicrotask(() => cb(null)); }
  disconnect() { this.disconnected = true; }
  list(cb) { queueMicrotask(() => cb(pm2Error, processes)); }
  describe() { assert.fail('Unsafe PM2 describe() called'); }
}
for (const method of ['start', 'stop', 'restart', 'delete']) PM2.prototype[method] = function (...args) { const cb = args.pop(); commands.push([method, ...args]); queueMicrotask(() => cb(pm2Error, [])); };
const mocks = {
  dotenv: { config() {} }, express, pm2: { custom: PM2 }, fs: mockFs,
  'express-session': options => { cookieOptions = options.cookie; return () => {}; }, passport,
  'passport-google-oauth20': { Strategy: class { constructor(options, verify) { oauth = { options, verify }; } } },
  'web-push': webpush, 'node-cron': { schedule() {} }, 'express-rate-limit': () => () => {},
  child_process: {
    execFileSync(file, args) { commands.push([file, args]); if (commandError) throw commandError; return file === 'ps' ? psOutput : ''; },
    execFile(file, args, options, callback) {
      commands.push([file, args]);
      if (file === 'pkill' && holdKill) { holdKill(callback); return; }
      const output = file === 'pgrep' ? (pids.length ? pids.shift() : '') : file === 'tail' ? 'log text' : '{}';
      queueMicrotask(() => callback(commandError || (output instanceof Error ? output : null), typeof output === 'string' ? output : '', ''));
    },
    spawn(file, args) {
      const child = new EventEmitter(); child.file = file; child.args = args;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.kill = () => { child.killed = true; };
      children.push(child); return child;
    },
  },
};
mocks.child_process.execFile[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => mocks.child_process.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
const makeTimer = (fn, ms) => { const timer = { fn, ms, cleared: false, unref() { return this; } }; timers.push(timer); if (ms === 500) queueMicrotask(fn); return timer; };
const context = vm.createContext({
  require(name) { if (name in mocks) return mocks[name]; if (['path', 'os', 'net', 'crypto', 'util'].includes(name)) return require(name); throw new Error(`Unexpected module: ${name}`); },
  __dirname, URL, console: { log() {}, error() {} },
  Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
  process: { env: { BASE_URL: 'https://dashboard.example', ALLOWED_EMAIL: 'owner@example.com' }, kill(pid, signal) { commands.push(['signal', pid, signal]); } },
  setInterval: makeTimer, clearInterval(timer) { timer.cleared = true; }, setTimeout: makeTimer, clearTimeout(timer) { timer.cleared = true; },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'), context);
const evaluate = code => vm.runInContext(code, context);
const response = () => Object.assign(new EventEmitter(), {
  statusCode: 200, chunks: [], headers: {},
  status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; },
  setHeader(key, value) { this.headers[key] = value; }, clearCookie() { this.cookieCleared = true; }, flushHeaders() {},
  write(data) { this.chunks.push(data); return !this.backpressure; },
  end() { this.writableEnded = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
});
const invoke = async (method, url, fields = {}) => {
  const req = { params: {}, body: {}, query: {}, sessionID: 'test', user: { email: 'owner@example.com' }, isAuthenticated: () => true,
    sessionStore: { get(id, cb) { cb(null, { passport: { user: { email: 'owner@example.com' } }, cookie: { expires: new Date(now + 60000).toISOString() } }); } }, ...fields };
  const res = response(), handlers = routes.get(`${method} ${url}`);
  let i = 0;
  const next = () => handlers[i++]?.(req, res, next);
  try { await next(); } catch (error) { res.status(error.status || 500).json({ error: 'Request failed' }); }
  return res;
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const runKill = fields => invoke('post', '/api/vscode/kill', fields);
const key = () => evaluate('generateKillToken()');
(async () => {
  assert.equal(oauth.options.state, true);
  assert.equal(cookieOptions.secure, true); assert.equal(cookieOptions.httpOnly, true); assert.equal(cookieOptions.sameSite, 'lax');
  for (const [email, verified, allowed] of [['owner@example.com', true, true], ['owner@example.com', false, false], ['other@example.com', true, false], [undefined, true, false]]) {
    oauth.verify('', '', { emails: [{ value: email, verified }] }, (err, user) => assert.equal(!!user, allowed));
  }
  deserialize({ email: 'other@example.com' }, (err, user) => assert.equal(user, false));
  for (const route of routes.keys()) {
    if (!route.includes(' /api/') || route.endsWith('/api/vscode/kill')) continue;
    const [method, url] = route.split(' ');
    assert.equal((await invoke(method, url, { isAuthenticated: () => false })).statusCode, 401, route);
    assert.equal((await invoke(method, url, { user: { email: 'other@example.com' } })).statusCode, 401, route);
  }
  const csrf = middleware.find(args => Array.isArray(args[0]))[1];
  for (const [origin, site, json, status] of [['https://evil.test', '', true, 403], ['', 'cross-site', true, 403], ['', '', false, 415], ['https://dashboard.example', 'same-origin', true, 200], ['', '', true, 200]]) {
    const res = response(); let passed = false;
    csrf({ method: 'POST', get: name => name === 'origin' ? origin : site, is: () => json }, res, () => { passed = true; });
    assert.equal(res.statusCode, status); assert.equal(passed, status === 200);
  }
  const stream = await invoke('get', '/api/events');
  const logout = await invoke('post', '/auth/logout', { logout: cb => cb(), session: { destroy: cb => cb() } });
  assert(logout.cookieCleared && stream.writableEnded); assert.equal(evaluate('sseClients.size'), 0);
  const expiring = await invoke('get', '/api/events', { sessionStore: { get(id, cb) { cb(null, null); } } });
  timers.filter(t => t.ms === 15000 && !t.cleared).at(-1).fn();
  assert(expiring.writableEnded); assert(expiring.chunks.some(chunk => chunk.includes('session-expired')));

  processes = [{ pm_id: 1, name: 'demo', pm2_env: { pm_cwd: '/home/tatsuya/demo', status: 'online', pm_out_log_path: '/tmp/test-out', pm_err_log_path: '/tmp/test-err', PORT: 8080 } }];
  const listed = await invoke('get', '/api/apps'); assert.equal(listed.body[0].port, '8080'); assert.equal(listed.body[0].cpu, 0);
  assert(!('PORT' in listed.body[0].pm2_env));
  const operations = ['/.*?/', '../outside', 'project/../other', '..'];
  for (const name of operations) assert.equal((await invoke('post', '/api/apps/:name/:action', { params: { name, action: 'restart' } })).statusCode, 400);
  assert.equal((await invoke('post', '/api/apps/:name/:action', { params: { name: 'all', action: 'stop' } })).statusCode, 404);
  await invoke('post', '/api/apps/:name/:action', { params: { name: 'demo', action: 'stop' } });
  assert.deepEqual(commands.at(-1), ['stop', '1']);
  assert.equal((await invoke('post', '/api/apps/:name/:action', { params: { name: '1', action: 'delete' }, body: { expected: { name: 'reused-id', path: '/different' } } })).statusCode, 409);
  processes.push({ ...processes[0], pm_id: 2 });
  assert.equal((await invoke('get', '/api/apps/:name/logs', { params: { name: 'demo' } })).statusCode, 409); processes.pop();
  pm2Error = new Error('RPC failed');
  assert.equal((await invoke('get', '/api/apps')).statusCode, 503); pm2Error = null;
  connectPending = [];
  const timeoutCheck = evaluate("withPM2('list')");
  const timeoutAssertion = assert.rejects(timeoutCheck);
  timers.filter(t => t.ms === 10000 && !t.cleared).at(-1).fn();
  await timeoutAssertion; connectPending[0](null); connectPending = null;
  assert(connections.at(-1).disconnected);
  await Promise.all([evaluate("withPM2('list')"), evaluate("withPM2('list')")]);
  assert(connections.slice(-2).every(connection => connection.disconnected));
  files.set('/home/tatsuya/new/package.json', '{}'); files.set('/home/tatsuya/new/index.js', '');
  assert.equal((await invoke('post', '/api/apps/:name/:action', { params: { name: 'new', action: 'register' } })).statusCode, 200);
  mockFs.realpathSync = file => file.endsWith('index.js') ? '/outside/index.js' : file;
  assert.equal((await invoke('post', '/api/apps/:name/:action', { params: { name: 'new', action: 'register' } })).statusCode, 400);
  mockFs.realpathSync = file => file;

  context.logPath = '/tmp/a";$(touch hacked).log';
  await evaluate('readLog(logPath, 50)');
  assert.deepEqual(Array.from(commands.at(-1)[1]), ['-n', '50', '--', context.logPath]);
  const logs = await invoke('get', '/api/apps/:name/logs/stream', { params: { name: '1' } });
  const tails = children.slice(-2); assert(tails.every(child => child.args.includes('50')));
  tails[0].stdout.emit('data', '日本語ログ'); assert(logs.chunks.some(chunk => chunk.includes('日本語ログ')));
  logs.backpressure = true; tails[0].stdout.emit('data', 'more');
  assert(logs.destroyed && tails.every(child => child.killed)); assert.equal(evaluate('sseClients.size'), 0);

  psOutput = '20 100 claude claude --prompt test\n21 200 node /usr/bin/node /x/@google/gemini-cli/dist/index.js\n22 100 bash bash -c echo claude\n23 300 codex /x/@openai/codex-linux-x64/bin/codex exec\n24 50 node node /x/.npm-global/bin/codex exec\n';
  assert.equal(evaluate('getAgentProcesses().length'), 3); // codex node launcher is not double-counted
  await invoke('post', '/api/agents/:type/stop', { params: { type: 'claude' } });
  assert.deepEqual(commands.at(-1), ['signal', 20, 'SIGTERM']);
  assert.equal((await invoke('post', '/api/agents/:type/stop', { params: { type: 'codex' } })).statusCode, 200);
  assert.equal((await invoke('post', '/api/agents/:type/stop', { params: { type: 'bash' } })).statusCode, 400);
  assert.deepEqual(commands.at(-1), ['signal', 23, 'SIGTERM']);
  assert.equal(evaluate('getDisk().percent'), '66.7');

  const keys = { auth: 'A'.repeat(22), p256dh: 'B'.repeat(87) }, sub = { endpoint: 'https://fcm.googleapis.com/test', keys };
  for (const endpoint of ['http://127.0.0.1/', 'https://localhost/', 'https://fcm.googleapis.com.evil.test/', 'https://user@fcm.googleapis.com/']) assert.equal((await invoke('post', '/api/push/subscribe', { body: { endpoint, keys } })).statusCode, 400);
  await invoke('post', '/api/push/subscribe', { body: sub });
  assert.equal(descriptors.size, 0); assert(writes.findIndex(write => write[0] === 'sync') < writes.findIndex(write => write[0] === 'rename'));
  const saved = files.get(subscriptions); syncFailure = true;
  assert.equal((await invoke('delete', '/api/push/unsubscribe', { body: { endpoint: sub.endpoint } })).statusCode, 500);
  assert.equal(files.get(subscriptions), saved); assert.equal(descriptors.size, 0); syncFailure = false;
  assert(![...files.keys()].some(file => file.endsWith('.tmp')));
  for (const statusCode of [404, 410]) {
    files.set(subscriptions, JSON.stringify([sub]));
    webpush.sendNotification = async () => { throw { statusCode }; };
    await assert.rejects(evaluate("sendPushToAll('Test', 'Test')"));
    assert.equal(files.get(subscriptions), '[]');
  }
  files.set(subscriptions, JSON.stringify([sub]));
  webpush.sendNotification = async () => {
    files.set(subscriptions, JSON.stringify([{ ...sub, keys: { ...keys, auth: 'C'.repeat(22) } }]));
    throw { statusCode: 410 };
  };
  await assert.rejects(evaluate("sendPushToAll('Test', 'Test')")); assert.equal(JSON.parse(files.get(subscriptions)).length, 1);
  files.set(subscriptions, '{broken'); assert.throws(() => evaluate('loadSubscriptions()')); assert.equal(files.get(subscriptions), '{broken');
  files.set(subscriptions, JSON.stringify([sub]));
  webpush.sendNotification = async (sub, payload) => { pushes.push({ sub, payload: JSON.parse(payload) }); };

  assert.equal((await runKill({ isAuthenticated: () => false })).statusCode, 401);
  assert.equal((await runKill({ query: { token: key() } })).statusCode, 400);
  const expired = key(); now += 600001;
  assert.equal((await runKill({ body: { token: expired }, isAuthenticated: () => false })).statusCode, 401);
  assert.equal((await runKill({ body: { token: {} }, isAuthenticated: () => false })).statusCode, 401);
  pids = ['']; assert.equal((await runKill({ body: { token: expired } })).statusCode, 200, 'An old notification still works with the owner session');
  for (const [samples, outcome] of [[[''], 'already-stopped'], [['10', '', '', '', ''], 'stopped'], [['10', '', '20', '20', '20'], 'restarted'], [['10', '10', '10', '10', '10'], 'still-running']]) {
    pids = [...samples]; const token = key(); const commandCount = commands.length;
    const result = await runKill({ body: { token }, isAuthenticated: () => false });
    assert.equal(result.statusCode, 200); assert.equal(result.body.outcome, outcome);
    const kills = commands.slice(commandCount).filter(command => command[0] === 'pkill');
    assert.equal(kills.length, outcome === 'already-stopped' ? 0 : 1);
    if (kills.length) assert.deepEqual(Array.from(kills[0][1]), ['-u', 'tatsuya', '-f', '[.]vscode-server(-insiders)?/']);
    assert.equal((await runKill({ body: { token }, isAuthenticated: () => false })).statusCode, 401, 'A consumed token is single-use without a session');
  }
  pids = [Object.assign(new Error('No matches'), { code: 1 })]; assert.equal((await runKill()).body.outcome, 'already-stopped');
  commandError = Object.assign(new Error('Permission denied'), { code: 2 }); assert.equal((await runKill()).statusCode, 503); commandError = null;
  pids = ['10']; let releaseKill;
  holdKill = callback => { releaseKill = callback; };
  const inFlight = runKill(); await flush(); assert.equal((await runKill()).statusCode, 409);
  holdKill = null; releaseKill(null, '', ''); await inFlight;

  // Real payload -> SW push -> notification.data -> no-cookie endpoint -> SW result.
  await evaluate("sendVSCodeAlert('192.168.1.1', 'Mac')");
  const payload = pushes.at(-1).payload; assert.equal(payload.actions[0].action, 'kill_vscode');
  assert.equal(typeof payload.data.killToken, 'string');
  const events = {}, notifications = []; let opened = 0, activated = 0, work, sent;
  const sw = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, self: {
    location: { origin: 'https://dashboard.example' }, skipWaiting: async () => { activated++; },
    clients: { claim: async () => { activated++; }, matchAll: async () => [], openWindow: async () => { opened++; } },
    addEventListener: (name, fn) => { events[name] = fn; }, registration: { showNotification: async (title, options) => { notifications.push({ title, ...options }); } },
  }, fetch: async (url, options) => { sent = { url, options }; const result = await runKill({ isAuthenticated: () => false, body: JSON.parse(options.body) }); return { ok: result.statusCode === 200, status: result.statusCode, json: async () => result.body }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/public/sw.js'), 'utf8'), sw);
  const waitUntil = promise => { work = promise; };
  events.install({ waitUntil }); await work; events.activate({ waitUntil }); await work; assert.equal(activated, 2); assert(!events.fetch, 'No stale asset cache');
  events.push({ data: { json: () => payload }, waitUntil }); await work;
  const notification = { ...notifications.at(-1), close() {} };
  pids = ['10', '', '', '', '']; events.notificationclick({ action: 'kill_vscode', notification, waitUntil }); await work;
  assert.equal(notifications.at(-1).title, 'VS Code停止を確認');
  assert.equal(sent.url, '/api/vscode/kill'); assert(!sent.url.includes(payload.data.killToken)); assert.equal(JSON.parse(sent.options.body).token, payload.data.killToken);
  events.notificationclick({ action: 'kill_vscode', notification, waitUntil }); await work;
  assert.equal(notifications.at(-1).title, 'VS Code停止を確認できません'); assert(notifications.at(-1).body.includes('使用済み'));
  await evaluate("sendVSCodeAlert('192.168.1.1', 'Mac')");
  notification.data = pushes.at(-1).payload.data; pids = ['10', '', '20', '20', '20'];
  events.notificationclick({ action: 'kill_vscode', notification, waitUntil }); await work; assert.equal(notifications.at(-1).title, 'VS Codeの再起動を検知');
  for (const value of [null, [], 'plain text', { actions: 'bad', data: null }]) { events.push({ data: { json: () => value }, waitUntil }); await work; }
  events.notificationclick({ action: 'kill_vscode_evil', notification, waitUntil }); await work; assert.equal(opened, 1);

  // Split UTF-8/JSON chunks, duplicate replay, cursor resume, oversized lines and bounded alerts.
  const journal = children[0]; now += 1000;
  const record = n => JSON.stringify({ MESSAGE: 'Accepted publickey for user from 192.168.1.2 port 2200 ssh2', __CURSOR: `cursor-${n}`, __REALTIME_TIMESTAMP: String(now * 1000 + n) });
  journal.stdout.emit('data', record(1).slice(0, 20)); journal.stdout.emit('data', record(1).slice(20) + '\n');
  journal.stdout.emit('data', record(1) + '\n'); assert.equal(evaluate('recentSSHLogins.length'), 1);
  pids = ['10']; const beforePush = pushes.filter(push => push.payload.tag === 'ssh-connection-burst').length;
  for (let n = 2; n < 20; n++) journal.stdout.emit('data', record(n) + '\n'); await flush();
  assert.equal(pushes.filter(push => push.payload.tag === 'ssh-connection-burst').length - beforePush, 1);
  assert(evaluate('[...sshConnectTimes.values()].every(times => times.length <= 3)'));
  journal.stdout.emit('data', 'x'.repeat(70000)); journal.stdout.emit('data', '\n' + record(21) + '\n');
  assert(evaluate("recentSSHLogins.at(-1).id === 'cursor-21'"));
  journal.emit('close', 0); timers.filter(t => t.ms === 5000).at(-1).fn();
  assert(children.at(-1).args.includes('--after-cursor=cursor-21'));
  assert(evaluate("isLocalIP('::ffff:192.168.1.1') && isLocalIP('fd00::1') && !isLocalIP('8.8.8.8')"));
  // Attack summary parsing.
  const sshText = ['99000 h sshd[1]: Invalid user admin from 1.2.3.4 port 5', '99001 h sshd[1]: Invalid user  from 1.2.3.4 port 5',
    '99002 h sshd[2]: Connection closed by authenticating user root 5.6.7.8 port 9 [preauth]', '99003 h sshd[3]: Accepted publickey for me from 2405::1 port 1 ssh2',
    '1 h sshd[4]: Invalid user old from 9.9.9.9 port 1', 'junk'].join('\n');
  const ssh = JSON.parse(evaluate(`JSON.stringify(summarizeSSH(${JSON.stringify(sshText)}, 100000))`));
  assert.deepEqual(ssh.windows['1h'], { failed: 3, uniqueIps: 2, accepted: 1 });
  assert.equal(ssh.windows['7d'].failed, 4);
  assert.deepEqual(ssh.topIps24h[0], { ip: '1.2.3.4', count: 2 });
  assert.deepEqual(ssh.topUsers24h.map(u => u.user).sort(), ['(空)', 'admin', 'root']);
  assert.equal(ssh.accepted24h[0].user, 'me');
  const ufw = JSON.parse(evaluate(`JSON.stringify(summarizeUFW("[UFW BLOCK] SRC=8.8.8.8 DST=x PROTO=TCP SPT=1 DPT=443\\n[UFW BLOCK] SRC=192.168.1.2 PROTO=UDP DPT=21027\\n[UFW BLOCK] SRC=fe80::1 PROTO=UDP DPT=21027"))`));
  assert.deepEqual(ufw, { blocked24h: 1, topPorts: [{ port: '443/TCP', count: 1 }], topSources: [{ ip: '8.8.8.8', count: 1 }] });
  console.log('All server / SW checks passed: auth, CSRF, routes, PM2, SSE, atomic storage, token kill flow, SSH replay and attack summary. External effects are stubbed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
