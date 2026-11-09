require('dotenv').config();
const express = require('express');
const pm2 = require('pm2');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const runFile = promisify(execFile);
const { randomBytes, randomUUID } = require('crypto');
const { isIP } = require('net');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const webpush = require('web-push');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = 3030;

// --- Web Push setup ---
webpush.setVapidDetails(
  `mailto:${process.env.ALLOWED_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'push-subscriptions.json');

const validSubscription = (sub) => {
  try {
    const endpoint = new URL(sub?.endpoint);
    // ponytail: add verified browser push providers here when support expands.
    const trustedHost = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)*push\.apple\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com)$/i;
    return endpoint.protocol === 'https:' && !endpoint.port && !endpoint.username && !endpoint.password &&
      !endpoint.hash && sub.endpoint.length <= 4096 && trustedHost.test(endpoint.hostname) &&
      typeof sub.keys?.auth === 'string' && /^[A-Za-z0-9_-]{22}={0,2}$/.test(sub.keys.auth) &&
      typeof sub.keys?.p256dh === 'string' && /^[A-Za-z0-9_-]{87}=?$/.test(sub.keys.p256dh);
  } catch { return false; }
};
const loadSubscriptions = () => {
  try {
    const subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    if (!Array.isArray(subs) || !subs.every(validSubscription)) throw new Error('Invalid subscription store');
    return subs;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error; // Never replace a damaged store with an empty one.
  }
};
const saveSubscriptions = (subs) => {
  // ponytail: synchronous read/modify/write is serialized in this one Node process.
  // Use a transactional shared store before running multiple dashboard workers.
  const temporary = `${SUBSCRIPTIONS_FILE}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(subs));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, SUBSCRIPTIONS_FILE);
    fd = fs.openSync(__dirname, 'r');
    fs.fsyncSync(fd); // Persist the rename as well as the contents.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
};

const sseClients = new Set();
const writeSSE = (res, event, data) => {
  if (res.destroyed || res.writableEnded) return;
  try {
    if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) res.destroy();
  } catch { res.destroy(); }
};
const broadcastSSE = (event, data) => {
  for (const res of sseClients) writeSSE(res, event, data);
};

const sendPushToAll = async (title, body, options = {}) => {
  const subs = loadSubscriptions();
  const payload = JSON.stringify({ title, body, icon: '/logo192.png', ...options });
  const results = await Promise.allSettled(subs.map(sub => webpush.sendNotification(sub, payload, { timeout: 10000 })));
  const failed = subs.filter((sub, i) => results[i].status === 'rejected' && [404, 410].includes(results[i].reason.statusCode));
  if (failed.length) {
    // A renewed subscription may reuse the endpoint with new keys while sends are in flight.
    saveSubscriptions(loadSubscriptions().filter(sub => !failed.some(old => old.endpoint === sub.endpoint && old.keys.auth === sub.keys.auth && old.keys.p256dh === sub.keys.p256dh)));
  }
  if (!results.some(result => result.status === 'fulfilled')) throw new Error('No notification was delivered');
};

// --- PM2 状態変化監視 ---
const prevPM2States = new Map();

let checkingPM2 = false;
const checkPM2StateChanges = async () => {
  if (checkingPM2) return;
  checkingPM2 = true;
  try {
    const list = await withPM2('list');
    const current = new Set();
    for (const proc of list) {
      const key = `${proc.pm_id}:${proc.name}`;
      current.add(key);
      const status = proc.pm2_env?.status || 'unknown';
      const prev = prevPM2States.get(key);
      if (prev !== undefined && prev !== status) {
        sendPushToAll('アプリの状態変化', `${proc.name}: ${prev} → ${status}`).catch(() => {});
        broadcastSSE('statechange', { name: proc.name, status });
      }
      prevPM2States.set(key, status);
    }
    for (const key of prevPM2States.keys()) { if (!current.has(key)) prevPM2States.delete(key); }
  } catch { /* Retry on the next monitor tick. */ }
  finally { checkingPM2 = false; }
};

cron.schedule('*/30 * * * * *', checkPM2StateChanges);

// --- メモリ・ディスク閾値アラート ---
let lastMemAlert = 0;
let lastDiskAlert = 0;
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1時間

const getDisk = () => {
  const disk = fs.statfsSync('/');
  const total = disk.blocks * disk.bsize;
  const used = (disk.blocks - disk.bfree) * disk.bsize;
  const avail = Math.max(0, disk.bavail * disk.bsize);
  if (!Number.isFinite(used + avail) || used + avail <= 0) throw new Error('Invalid disk statistics');
  return { total, used, avail, percent: ((used / (used + avail)) * 100).toFixed(1) };
};
const checkResourceAlerts = () => {
  const now = Date.now();
  const memPercent = (1 - os.freemem() / os.totalmem()) * 100;
  if (memPercent >= 90 && now - lastMemAlert > ALERT_COOLDOWN) {
    lastMemAlert = now;
    sendPushToAll('メモリ警告', `使用率 ${memPercent.toFixed(0)}% に達しました`).catch(() => {});
  }
  try {
    const diskPercent = Number(getDisk().percent);
    if (diskPercent >= 85 && now - lastDiskAlert > ALERT_COOLDOWN) {
      lastDiskAlert = now;
      sendPushToAll('ディスク警告', `使用率 ${diskPercent.toFixed(0)}% に達しました`).catch(() => {});
    }
  } catch { /* A failed disk read is not a zero-use reading. */ }
};

cron.schedule('*/5 * * * *', checkResourceAlerts);

// --- リアルタイムSSHログイン検知 ---
const recentSSHLogins = [];
const MAX_SSH_LOGINS = 100;
const lastSSHNotifyByIP = new Map();
const SSH_NOTIFY_COOLDOWN = 5 * 60 * 1000;

// --- VS Code接続多発検知・停止トークン ---
const sshConnectTimes = new Map(); // ip -> [timestamp, ...]
const vscodeKillTokens = new Map(); // token -> expiry
const VSCODE_ALERT_COUNT = 3;
const VSCODE_ALERT_WINDOW = 2 * 60 * 1000;
const TOKEN_TTL = 10 * 60 * 1000;

const pruneKillTokens = () => {
  for (const [token, expiry] of vscodeKillTokens) { if (expiry <= Date.now()) vscodeKillTokens.delete(token); }
};
setInterval(pruneKillTokens, 60000).unref();
const generateKillToken = () => {
  pruneKillTokens();
  if (vscodeKillTokens.size >= 100) vscodeKillTokens.delete(vscodeKillTokens.keys().next().value);
  const token = randomBytes(24).toString('hex');
  vscodeKillTokens.set(token, Date.now() + TOKEN_TTL);
  return token;
};
const sendVSCodeAlert = async (ip, device) => {
  const token = generateKillToken();
  try {
    await sendPushToAll('SSH接続が多発しています', `${device || ip} から複数回接続されました。VS Code使用中なら接続状態を確認してください。`, {
      tag: 'ssh-connection-burst', requireInteraction: true,
      actions: [{ action: 'kill_vscode', title: 'VS Codeを停止' }, { action: 'dismiss', title: '無視' }],
      data: { killToken: token },
    });
    console.log('[VS Code] 多発アラート送信');
  } catch (error) { vscodeKillTokens.delete(token); throw error; }
};
const isLocalIP = ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|::1$|f[cd][a-f0-9]{2}:|fe[89ab][a-f0-9]:)/i.test(ip.replace(/^::ffff:/i, ''));
const geolocateIP = async ip => {
  if (isLocalIP(ip)) return { location: 'ローカルネットワーク', org: '', isLocal: true };
  try {
    // This existing provider's free endpoint uses HTTP; treat its text as untrusted display data.
    const { stdout } = await runFile('curl', ['-fsS', '--max-time', '3', `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,org,isp`], { encoding: 'utf8', timeout: 4000, maxBuffer: 16384 });
    const data = JSON.parse(stdout);
    if (data.status === 'success') return { location: [data.city, data.regionName, data.country].filter(Boolean).join(', '), org: data.org || data.isp || '', isLocal: false };
  } catch { /* Geolocation failure must not discard the login. */ }
  return { location: '不明', org: '', isLocal: false };
};

const buildFingerprintMap = () => {
  const map = new Map();
  try {
    const content = fs.readFileSync('/home/tatsuya/.ssh/authorized_keys', 'utf8');
    for (const keyLine of content.split('\n').filter(l => l.trim() && !l.startsWith('#'))) {
      try {
        const result = execFileSync('ssh-keygen', ['-lf', '-'], { input: keyLine + '\n', encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        const fpM = result.match(/SHA256:\S+/);
        const comment = result.match(/SHA256:\S+\s+(.*?)\s+\([^)]+\)$/)?.[1];
        if (fpM && comment) map.set(fpM[0], comment);
      } catch {}
    }
  } catch {}
  return map;
};
const fingerprintMap = buildFingerprintMap();

const getDeviceName = (keyComment) => {
  if (!keyComment) return null;
  if (keyComment.includes('MacBook')) return 'Mac';
  if (keyComment.includes('tatsu@tatsuya')) return 'Windows PC';
  if (/termius/i.test(keyComment)) return 'スマホ (Termius)';
  return keyComment;
};

const parseSSHLine = (line) => {
  const m = line.match(/^Accepted (\S+) for (\S+) from (\S+) port \d+/);
  if (!m) return null;
  const [, method, user, ip] = m;
  if (!isIP(ip)) return null;
  const fpM = line.match(/(SHA256:\S+)/);
  const fingerprint = fpM ? fpM[1] : null;
  const keyComment = fingerprint ? fingerprintMap.get(fingerprint) : null;
  return { method, user, ip, device: getDeviceName(keyComment) };
};

let lastVSCodeAlert = 0;
let sshCursor = null;
let lastSSHTime = null;
const sshStartedAt = Date.now();
const recordSSHLine = (line) => {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  if (typeof record.MESSAGE !== 'string' || typeof record.__CURSOR !== 'string') return;
  const parsed = parseSSHLine(record.MESSAGE);
  const timestamp = Number(record.__REALTIME_TIMESTAMP) / 1000;
  if (!parsed || !Number.isFinite(new Date(timestamp).getTime()) || timestamp <= 0) return;
  sshCursor = record.__CURSOR;
  lastSSHTime = new Date(timestamp).toISOString();
  if (recentSSHLogins.some(entry => entry.id === sshCursor)) return;
  const historical = timestamp <= sshStartedAt;
  const entry = { id: sshCursor, time: lastSSHTime, displayTime: '', ...parsed, location: isLocalIP(parsed.ip) ? 'ローカルネットワーク' : null, org: '', isLocal: isLocalIP(parsed.ip), historical };
  recentSSHLogins.push(entry);
  if (recentSSHLogins.length > MAX_SSH_LOGINS) recentSSHLogins.shift();
  if (historical || Date.now() - timestamp > VSCODE_ALERT_WINDOW) return;
  broadcastSSE('sshlogin', entry);
  const now = Date.now();
  for (const [ip, time] of lastSSHNotifyByIP) { if (now - time > SSH_NOTIFY_COOLDOWN) lastSSHNotifyByIP.delete(ip); }
  for (const [ip, times] of sshConnectTimes) { if (now - times[times.length - 1] > VSCODE_ALERT_WINDOW) sshConnectTimes.delete(ip); }
  for (const map of [lastSSHNotifyByIP, sshConnectTimes]) { if (map.size >= 1000) map.delete(map.keys().next().value); }
  const times = (sshConnectTimes.get(parsed.ip) || []).filter(t => now - t < VSCODE_ALERT_WINDOW);
  times.push(Math.min(timestamp, now));
  sshConnectTimes.set(parsed.ip, times.slice(-VSCODE_ALERT_COUNT));
  if (times.length >= VSCODE_ALERT_COUNT && now - lastVSCodeAlert >= TOKEN_TTL) {
    lastVSCodeAlert = now; // Global cooldown, including failed sends and alternating IPs.
    getVSCodePids().then(pids => { if (pids.length) return sendVSCodeAlert(parsed.ip, parsed.device); }).catch(() => {});
  }
  if (now - (lastSSHNotifyByIP.get(parsed.ip) || 0) > SSH_NOTIFY_COOLDOWN) {
    lastSSHNotifyByIP.set(parsed.ip, now);
    geolocateIP(parsed.ip).then(geo => {
      Object.assign(entry, geo);
      broadcastSSE('sshlogin', entry); // Same cursor updates the entry rather than duplicating it.
      return sendPushToAll('SSHログイン', `${parsed.user} / ${parsed.device || parsed.ip} / ${geo.location}`);
    }).catch(() => {});
  }
};
const startSSHMonitor = () => {
  const resume = sshCursor ? [`--after-cursor=${sshCursor}`] : [`--since=${lastSSHTime || '7 days ago'}`];
  const proc = spawn('sudo', ['-n', 'journalctl', '-f', '--no-tail', '-u', 'ssh', '--grep=^Accepted ', '--no-pager', '-o', 'json', ...resume], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  let discarding = false;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!discarding && line.length <= 65536) recordSSHLine(line);
      discarding = false;
    }
    if (buffer.length > 65536) { buffer = ''; discarding = true; }
  });
  proc.on('error', () => console.error('[SSH] journalctl could not start'));
  proc.on('close', code => {
    if (!discarding && buffer) recordSSHLine(buffer);
    if (code) sshCursor = null; // A vacuumed cursor resumes from the last timestamp, with deduplication.
    setTimeout(startSSHMonitor, 5000).unref();
  });
};

// --- Auth setup ---
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
  state: true,
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value;
  if (email && profile.emails[0].verified === true && email === process.env.ALLOWED_EMAIL) return done(null, { email, name: profile.displayName });
  return done(null, false, { message: 'Unauthorized email' });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user?.email && user.email === process.env.ALLOWED_EMAIL ? user : false));

app.set('trust proxy', 'loopback');
app.use(session({
  secret: process.env.SESSION_SECRET,
  // ponytail: the default MemoryStore is for this single-process dashboard; use a shared store before scaling.
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());
app.disable('x-powered-by');
app.use(['/api', '/auth'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      ((req.get('origin') && req.get('origin') !== new URL(process.env.BASE_URL).origin) ||
       req.get('sec-fetch-site') === 'cross-site')) {
    return res.status(403).json({ error: 'Cross-origin request denied' });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use('/auth/google', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }));
app.use('/api', rateLimit({ windowMs: 60000, limit: 30, skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method), standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 2000, standardHeaders: true, legacyHeaders: false }));

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated() && req.user?.email && req.user.email === process.env.ALLOWED_EMAIL) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// --- Auth routes ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=unauthorized' }),
  (req, res) => res.redirect('/')
);

app.post('/auth/logout', requireAuth, (req, res, next) => {
  const sessionID = req.sessionID;
  req.logout((error) => {
    if (error) return next(error);
    req.session.destroy((error) => {
      if (error) return next(error);
      for (const client of sseClients) {
        if (client.sessionID === sessionID) client.end();
      }
      res.clearCookie('connect.sid', { secure: true, httpOnly: true, sameSite: 'lax' });
      res.json({ success: true });
    });
  });
});

app.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// --- System info (with caching) ---
let cachedGlobalIp = null;
let cachedGlobalIpAt = 0;

const getGlobalIp = () => {
  if (Date.now() - cachedGlobalIpAt >= 5 * 60 * 1000) {
    cachedGlobalIpAt = Date.now(); // Cache failures too; never block a dashboard poll on external DNS/network.
    runFile('curl', ['-fsS', '-4', '--max-time', '3', 'https://ifconfig.me'], { encoding: 'utf8', timeout: 3500, maxBuffer: 1024 }).then(({ stdout }) => {
      if (isIP(stdout.trim())) cachedGlobalIp = stdout.trim();
    }).catch(() => {});
  }
  return cachedGlobalIp;
};

let cachedNginxMap = null;
let cachedNginxMapAt = 0;

const getNginxDomainMap = () => {
  if (Date.now() - cachedNginxMapAt < 60 * 1000) return cachedNginxMap;
  const sitesDir = '/etc/nginx/sites-enabled';
  const map = {};
  try {
    const files = fs.readdirSync(sitesDir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(sitesDir, file), 'utf-8');
        for (const block of content.split(/(?=server\s*\{)/g)) {
          if (!block.includes('ssl_certificate')) continue;
          const domainMatch = block.match(/server_name\s+([^\s;]+)/);
          const portMatch = block.match(/proxy_pass\s+http:\/\/localhost:(\d+)/);
          if (domainMatch && portMatch && !map[portMatch[1]]) {
            map[portMatch[1]] = `https://${domainMatch[1]}`;
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  cachedNginxMap = map;
  cachedNginxMapAt = Date.now();
  return map;
};

const AGENT_TYPES = ['claude', 'gemini', 'codex'];
const getAgentProcesses = () => {
  const output = execFileSync('ps', ['-u', 'tatsuya', '-o', 'pid=,rss=,comm=,args='], { encoding: 'utf8', timeout: 3000 });
  return output.split('\n').flatMap(line => {
    const [pid, rss, command, executable, ...args] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(pid || '') || !/^\d+$/.test(rss || '')) return [];
    // Match executables / known Node CLI entrypoints, never arbitrary prompt arguments.
    const script = args.find(arg => !arg.startsWith('-')) || '';
    // codex: count only the native binary; its node launcher would double-count.
    const nodeEntry = { claude: /\/@anthropic-ai\/claude-code\/cli\.js$/, gemini: /\/@google\/gemini-cli\/(dist\/index|bundle\/gemini)\.js$/ };
    const type = AGENT_TYPES.find(type => command === type || path.basename(executable || '') === type ||
      (command === 'node' && nodeEntry[type]?.test(script)));
    return type ? [{ pid: Number(pid), mem: Number(rss) * 1024, type }] : [];
  });
};
const getExtendedSystemInfo = () => {
  const interfaces = os.networkInterfaces();
  const localIps = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) localIps.push(iface.address);
    }
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let agents = Object.fromEntries(AGENT_TYPES.map(type => [type, { mem: 0, count: 0, locations: [] }]));
  try {
    for (const proc of getAgentProcesses()) {
      agents[proc.type].mem += proc.mem;
      agents[proc.type].count++;
      try {
        const cwd = fs.readlinkSync(`/proc/${proc.pid}/cwd`);
        if (!agents[proc.type].locations.includes(cwd)) agents[proc.type].locations.push(cwd);
      } catch {}
    }
  } catch { agents = null; }

  let disk = null;
  try { disk = getDisk(); } catch {}

  return {
    network: { localIps, globalIp: getGlobalIp() },
    memory: { total: totalMem, free: freeMem, used: usedMem, percent: ((usedMem / totalMem) * 100).toFixed(1) },
    disk,
    agents,
    os: { platform: os.platform(), uptime: os.uptime(), loadavg: os.loadavg() },
  };
};

const getAppPort = (appPath, appName) => {
  if (!appPath) return null;
  const pkgPath = path.join(appPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts) {
        for (const script of Object.values(pkg.scripts)) {
          if (typeof script !== 'string') continue;
          const match = script.match(/--port[= ](\d+)/) || script.match(/PORT=(\d+)/);
          if (match) return match[1];
        }
      }
    } catch (e) {}
  }
  const entryPoints = ['server.js', 'app.js', 'index.js', 'src/server.js', 'server/app.js', 'server/index.js'];
  for (const f of entryPoints) {
    const filePath = path.join(appPath, f);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const match = content.match(/const PORT = (\d+)/) || content.match(/const port = (\d+)/) ||
                      content.match(/\.listen\((\d+)/) || content.match(/process\.env\.PORT\s*\|\|\s*(\d+)/);
        if (match) return match[1];
      } catch (e) {}
    }
  }
  const defaults = { 'mc-web-panel': '3000', 'threads-note-gen': '3010', 'Agile-2026-1': '3051', 'fishing': '3000', 'matsukare': '8765', 'kawailab': '5005', 'graduation-trip': '3090', 'graduation-trip-dev': '3091', 'kakeibo': '5065', 'oshikatsu-app': '7000' };
  return defaults[appName] || null;
};

// PM2's describe() can call exitCli() on RPC errors. Use list() and exact matching instead.
const withPM2 = (method, ...args) => new Promise((resolve, reject) => {
  const connection = new pm2.custom();
  let finished = false;
  const finish = (error, result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try { connection.disconnect(); } catch (disconnectError) { error ||= disconnectError; }
    if (error) reject(Object.assign(new Error('PM2 unavailable'), { status: 503 }));
    else resolve(result);
  };
  const timeout = setTimeout(() => finish(new Error('PM2 timeout')), 10000);
  try {
    connection.connect(error => {
      if (finished) { try { connection.disconnect(); } catch {} return; }
      if (error) return finish(error);
      try { connection[method](...args, finish); } catch (error) { finish(error); }
    });
  } catch (error) { finish(error); }
});
const findApp = (list, name) => {
  const matches = list.filter(proc => /^\d+$/.test(name) ? String(proc.pm_id) === name : proc.name === name);
  if (matches.length > 1) throw Object.assign(new Error('Ambiguous app name; use PM2 ID'), { status: 409 });
  return matches[0];
};
const openSSE = (req, res) => {
  if (res.destroyed) return false;
  // Bound tail processes per session; several tabs remain usable.
  if ([...sseClients].filter(client => client.sessionID === req.sessionID).length >= 12) { res.status(429).end(); return false; }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.sessionID = req.sessionID;
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    req.sessionStore.get(req.sessionID, (error, saved) => {
      if (res.destroyed || res.writableEnded) return;
      if (error || !saved?.passport?.user?.email || saved.passport.user.email !== process.env.ALLOWED_EMAIL || !(new Date(saved.cookie?.expires).getTime() > Date.now())) {
        writeSSE(res, 'session-expired', {}); return res.end();
      }
      if (!res.write(': heartbeat\n\n')) res.destroy();
    });
  }, 15000);
  res.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
  return true;
};
app.get('/api/events', requireAuth, (req, res) => { if (openSSE(req, res)) writeSSE(res, 'ready', {}); });

const readLog = async (file, lines) => {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('Invalid log path');
  try {
    const { stdout } = await runFile('tail', ['-n', String(lines), '--', file], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    try { fs.statSync(file); } catch (statError) { if (statError.code === 'ENOENT') return ''; }
    throw error;
  }
};

// --- API routes (all require auth) ---
const CLOUDFLARE_URL_MAP = { '8765': 'https://karen.corn-kare.com', '5005': 'https://kawailab.corn-kare.com', '3090': 'https://ideal-trip.corn-kare.com', '3091': 'https://dev-ideal-trip.corn-kare.com', '5065': 'https://money.corn-kare.com', '3015': 'https://kensyou.corn-kare.com', '7000': 'https://oshikatsu-app.corn-kare.com' };

app.get('/api/info', requireAuth, (req, res) => res.json(getExtendedSystemInfo()));

app.get('/api/apps', requireAuth, async (req, res) => {
  const list = await withPM2('list');
  const domainMap = { ...CLOUDFLARE_URL_MAP, ...getNginxDomainMap() };
  res.json(list.map(proc => {
    const env = proc.pm2_env || {};
    const appPath = env.pm_cwd || '';
    const configuredPort = String(env.PORT || env.env?.PORT || '');
    const port = /^\d+$/.test(configuredPort) && Number(configuredPort) > 0 && Number(configuredPort) < 65536 ? configuredPort : getAppPort(appPath, proc.name);
    return {
      id: proc.pm_id, name: proc.name, status: env.status || 'unknown', cpu: proc.monit?.cpu || 0,
      memory: proc.monit?.memory || 0, uptime: env.pm_uptime || 0, restarts: env.restart_time || 0,
      unstableRestarts: env.unstable_restarts || 0, path: appPath, port, url: port ? domainMap[port] || null : null,
      pm2_env: { node_version: env.node_version || '—' },
    };
  }));
});
app.get('/api/apps/:name/logs', requireAuth, async (req, res) => {
  const proc = findApp(await withPM2('list'), req.params.name);
  if (!proc) return res.status(404).json({ error: 'App not found' });
  const [out, err] = await Promise.all([readLog(proc.pm2_env.pm_out_log_path, 100), readLog(proc.pm2_env.pm_err_log_path, 100)]);
  res.json({ out, err, error: err }); // Keep the old JSON field for existing clients.
});
app.get('/api/apps/:name/logs/stream', requireAuth, async (req, res) => {
  const proc = findApp(await withPM2('list'), req.params.name);
  if (!proc) return res.status(404).end();
  const files = [proc.pm2_env.pm_out_log_path, proc.pm2_env.pm_err_log_path];
  if (files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) return res.status(500).end();
  if (!openSSE(req, res)) return;
  const children = [];
  res.on('close', () => children.forEach(child => child.kill()));
  writeSSE(res, 'init', { out: '', err: '' });
  // One tail per file owns both initial history and following: no snapshot/follow gap.
  for (const [index, file] of files.entries()) {
    try {
      const child = spawn('tail', ['-F', '-n', '50', '--', file]);
      children.push(child);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', line => writeSSE(res, 'log', { type: index ? 'err' : 'out', line }));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', () => writeSSE(res, 'log-warning', { message: 'ログファイルを追尾できません。作成・権限を確認してください。' }));
      child.on('error', () => res.end());
      child.on('close', () => res.end());
    } catch { res.end(); break; }
  }
});
// ponytail: serialize this personal dashboard's mutations; use per-app locks if concurrent operators are needed.
let appActionBusy = false;
app.post('/api/apps/:name/:action', requireAuth, async (req, res) => {
  if (appActionBusy) return res.status(409).json({ error: 'Another app operation is in progress' });
  appActionBusy = true;
  try {
  const { name, action } = req.params;
  if (!['start', 'stop', 'restart', 'delete', 'register'].includes(action) || name.length > 255 || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') return res.status(400).json({ error: 'Invalid app or action' });
  const list = await withPM2('list');
  const proc = action === 'register' ? null : findApp(list, name);
  if (proc) {
    const expected = req.body?.expected;
    if (expected && (expected.name !== proc.name || expected.path !== proc.pm2_env.pm_cwd)) return res.status(409).json({ error: 'App changed; refresh before retrying' });
    if (action !== 'start' || proc.pm2_env.status !== 'online') await withPM2(action, String(proc.pm_id)); // Namespaces, regexes and "all" never reach PM2.
  } else {
    if (!['start', 'register'].includes(action)) return res.status(404).json({ error: 'App not found' });
    if (action === 'start' && /^\d+$/.test(name)) return res.status(404).json({ error: 'App not found' });
    const appPath = path.resolve('/home/tatsuya', name);
    if (list.some(proc => proc.name === name || proc.pm2_env?.pm_cwd === appPath)) return res.status(409).json({ error: 'Project already managed' });
    if (path.dirname(appPath) !== '/home/tatsuya' || !fs.existsSync(path.join(appPath, 'package.json')) || fs.lstatSync(appPath).isSymbolicLink()) return res.status(400).json({ error: 'Invalid project path' });
    const entry = ['server.js', 'app.js', 'index.js', 'src/server.js', 'server/app.js', 'server/index.js'].find(file => fs.existsSync(path.join(appPath, file)));
    if (!entry) return res.status(404).json({ error: 'Entry point not found' });
    const script = fs.realpathSync(path.join(appPath, entry));
    if (!script.startsWith(fs.realpathSync(appPath) + path.sep) || !fs.statSync(script).isFile()) return res.status(400).json({ error: 'Invalid entry point' });
    await withPM2('start', { script, name, cwd: appPath });
  }
  broadcastSSE('statechange', { name });
  res.json({ success: true, action });
  } finally { appActionBusy = false; }
});

app.post('/api/agents/:type/stop', requireAuth, (req, res) => {
  const { type } = req.params;
  if (!AGENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  try {
    for (const proc of getAgentProcesses().filter(proc => proc.type === type)) {
      try { process.kill(proc.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    res.json({ success: true });
  } catch (e) {
    if (e.status === 1) return res.json({ success: true });
    res.status(500).json({ error: 'Failed to stop agents' });
  }
});

app.get('/api/scan', requireAuth, (req, res) => {
  const rootDir = '/home/tatsuya';
  const potentialApps = [];
  fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .forEach(d => {
      const pkgPath = path.join(rootDir, d.name, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          potentialApps.push({ name: d.name, path: path.join(rootDir, d.name), version: pkg.version });
        } catch (e) {}
      }
    });
  res.json(potentialApps);
});

app.get('/api/ssh/logins', requireAuth, (req, res) => {
  res.json([...recentSSHLogins].reverse().slice(0, 50));
});

app.get('/api/docker', requireAuth, (req, res) => {
  try {
    const out = execFileSync('sudo', ['-n', 'docker', 'ps', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 5000 }).trim();
    const containers = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
    res.json(containers);
  } catch { res.status(503).json({ error: 'Docker status unavailable' }); }
});

// The bracketed pattern cannot match itself; execFile never introduces a matching shell parent.
const VSCODE_PATTERN = '[.]vscode-server(-insiders)?/';
const getVSCodePids = async () => {
  try {
    const { stdout } = await runFile('pgrep', ['-u', 'tatsuya', '-f', VSCODE_PATTERN], { encoding: 'utf8', timeout: 3000 });
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    if (pids.some(pid => !/^\d+$/.test(pid))) throw new Error('Invalid process list');
    return pids;
  } catch (error) { if (error.code === 1) return []; throw error; }
};
app.get('/api/vscode/status', requireAuth, async (req, res) => {
  const pids = await getVSCodePids();
  res.json({ running: pids.length > 0, processCount: pids.length });
});
let vscodeKilling = false;
app.post('/api/vscode/kill', async (req, res) => {
  if (req.query.token !== undefined) return res.status(400).json({ error: 'Send tokens in the JSON body' });
  const token = req.body?.token;
  const authenticated = req.isAuthenticated() && req.user?.email === process.env.ALLOWED_EMAIL && !!req.user?.email;
  const validToken = typeof token === 'string' && /^[a-f0-9]{48}$/.test(token) && (vscodeKillTokens.get(token) || 0) > Date.now();
  // The owner's session still works from an old notification; without one, the token must be live and unused.
  if (!authenticated && !validToken) return res.status(401).json({ error: 'Unauthorized or expired token' });
  if (vscodeKilling) return res.status(409).json({ error: 'VS Code stop already in progress' });
  if (validToken) vscodeKillTokens.delete(token);
  vscodeKilling = true;
  try {
    const before = await getVSCodePids();
    let after = before;
    if (before.length) {
      try { await runFile('pkill', ['-u', 'tatsuya', '-f', VSCODE_PATTERN], { timeout: 3000 }); }
      catch (error) { if (error.code !== 1) throw error; }
      console.log('[VS Code] サーバープロセスに停止要求を送信しました');
      // ponytail: observe for 2 seconds; a later client reconnect can still start a new server.
      for (let i = 0; i < 4; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        after = await getVSCodePids();
      }
    }
    const outcome = !before.length ? 'already-stopped' : !after.length ? 'stopped' : after.some(pid => before.includes(pid)) ? 'still-running' : 'restarted';
    const result = { ok: true, outcome, running: after.length > 0, processCount: after.length, observedAt: new Date().toISOString() };
    broadcastSSE('vscode-status', result);
    res.json(result);
  } catch {
    res.status(503).json({ error: '停止または状態確認に失敗しました。状態を再確認してください。' });
  } finally { vscodeKilling = false; }
});

// --- Push notification endpoints ---
app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body;
  if (!validSubscription(sub)) return res.status(400).json({ error: 'Invalid subscription' });
  const subs = loadSubscriptions();
  const updated = subs.filter(s => s.endpoint !== sub.endpoint);
  if (updated.length >= 32) return res.status(409).json({ error: 'Too many subscriptions' });
  updated.push({ endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } });
  saveSubscriptions(updated);
  res.json({ success: true });
});

app.delete('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Invalid endpoint' });
  saveSubscriptions(loadSubscriptions().filter(s => s.endpoint !== endpoint));
  res.json({ success: true });
});

app.post('/api/push/test', requireAuth, async (req, res) => {
  await sendPushToAll('テスト通知', 'サーバー監視が正常に動作しています');
  res.json({ success: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API not found' }));
// --- Static files ---
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js') res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '../client/build')));
app.use('/auth', (req, res) => res.status(404).json({ error: 'Auth route not found' }));
app.get(/.*/, (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, '../client/build/index.html')); });
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status([400, 401, 403, 404, 409, 413, 415, 429, 503].includes(error.status) ? error.status : 500).json({ error: 'Request failed' });
});

startSSHMonitor();

app.listen(PORT, '0.0.0.0', () => console.log(`Dashboard running on http://0.0.0.0:${PORT}`));
