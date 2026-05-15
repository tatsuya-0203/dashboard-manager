const express = require('express');
const pm2 = require('pm2');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const PORT = 3030;

app.use(cors());
app.use(express.json());

const withPM2 = (callback) => {
  pm2.connect((err) => {
    if (err) {
      console.error(err);
      return callback(err);
    }
    callback(null);
  });
};

const getExtendedSystemInfo = () => {
  const interfaces = os.networkInterfaces();
  const localIps = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIps.push(iface.address);
      }
    }
  }

  let globalIp = 'Unknown';
  try {
    globalIp = execSync('curl -s https://ifconfig.me', { encoding: 'utf8' }).trim();
  } catch (e) {}

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

    let desktopStatus = "Unknown";
    let targetPcIp = "Unknown";
  let agents = { claude: { mem: 0, count: 0, locations: [] }, gemini: { mem: 0, count: 0, locations: [] } };
  try {
    const psOutput = execSync('ps axo pid,rss,command', { encoding: 'utf8' });
    const lines = psOutput.split('\n').slice(1);
    lines.forEach(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return;
      const pid = parts[0];
      const rss = parseInt(parts[1]);
      const cmd = parts.slice(2).join(' ');
      
      let type = null;
      if (cmd.includes('claude')) type = 'claude';
      else if (cmd.includes('gemini')) type = 'gemini';

      if (type) {
        agents[type].mem += rss * 1024;
        agents[type].count++;
        try {
          const cwd = execSync(`readlink -f /proc/${pid}/cwd`, { encoding: 'utf8' }).trim();
          if (!agents[type].locations.includes(cwd)) {
            agents[type].locations.push(cwd);
          }
        } catch (e) {}
      }
    });
  } catch (e) {
    console.error('Failed to fetch agent info:', e);
  }

  return {
    network: { localIps, globalIp, desktopStatus, targetPcIp },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percent: ((usedMem / totalMem) * 100).toFixed(1)
    },
    agents: agents,
    os: {
      platform: os.platform(),
      uptime: os.uptime(),
      loadavg: os.loadavg()
    }
  };
};

const getAppPort = (appPath, appName) => {
  const pkgPath = path.join(appPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts) {
        for (const script of Object.values(pkg.scripts)) {
          const match = script.match(/--port[= ](\d+)/) || script.match(/PORT=(\d+)/);
          if (match) return match[1];
        }
      }
    } catch (e) {}
  }

  const entryPoints = ['server.js', 'app.js', 'index.js', 'src/server.js', 'server/app.js'];
  for (const f of entryPoints) {
    const filePath = path.join(appPath, f);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const match = content.match(/const PORT = (\d+)/) || 
                      content.match(/const port = (\d+)/) ||
                      content.match(/\.listen\((\d+)/);
        if (match) return match[1];
      } catch (e) {}
    }
  }

  const defaults = {
    'mc-web-panel': '3000',
    'threads-note-gen': '3010',
    'Agile-2026-1': '3051',
    'fishing': '3000'
  };
  
  return defaults[appName] || null;
};

app.get('/api/info', (req, res) => {
  res.json(getExtendedSystemInfo());
});

app.get('/api/apps', (req, res) => {
  withPM2((err) => {
    if (err) return res.status(500).json({ error: 'PM2 connect error' });
    pm2.list((err, list) => {
      if (err) return res.status(500).json({ error: err });
      const apps = list.map(proc => {
        const appPath = proc.pm2_env.pm_cwd;
        const port = getAppPort(appPath, proc.name);
        return {
          id: proc.pm_id,
          name: proc.name,
          status: proc.pm2_env.status,
          cpu: proc.monit.cpu,
          memory: proc.monit.memory,
          uptime: proc.pm2_env.pm_uptime,
          restarts: proc.pm2_env.restart_time,
          path: appPath,
          port: port,
          pm2_env: {
            node_version: proc.pm2_env.node_version,
            out_log: proc.pm2_env.pm_out_log_path,
            err_log: proc.pm2_env.pm_err_log_path
          }
        };
      });
      res.json(apps);
    });
  });
});

app.get('/api/apps/:name/logs', (req, res) => {
  const { name } = req.params;
  withPM2((err) => {
    if (err) return res.status(500).json({ error: 'PM2 error' });
    pm2.describe(name, (err, desc) => {
      if (err || !desc || desc.length === 0) return res.status(404).json({ error: 'App not found' });
      const logPath = desc[0].pm2_env.pm_out_log_path;
      const errPath = desc[0].pm2_env.pm_err_log_path;
      
      try {
        const outLogs = execSync(`tail -n 100 ${logPath}`, { encoding: 'utf8' });
        const errLogs = execSync(`tail -n 100 ${errPath}`, { encoding: 'utf8' });
        res.json({ out: outLogs, error: errLogs });
      } catch (e) {
        res.status(500).json({ error: 'Failed to read logs' });
      }
    });
  });
});

app.post('/api/apps/:name/:action', (req, res) => {
  const { name, action } = req.params;
  withPM2((err) => {
    if (err) return res.status(500).json({ error: 'PM2 connect error' });
    
    const callback = (err, proc) => {
      if (err) return res.status(500).json({ error: err });
      res.json({ success: true, action });
    };

    if (action === 'stop') return pm2.stop(name, callback);
    if (action === 'restart') return pm2.restart(name, callback);
    if (action === 'delete') return pm2.delete(name, callback);
    
    if (action === 'start') {
      pm2.describe(name, (err, desc) => {
        if (!err && desc && desc.length > 0) {
          pm2.start(name, callback);
        } else {
          const rootDir = '/home/tatsuya';
          const appPath = path.join(rootDir, name);
          const entryPoints = ['server.js', 'app.js', 'index.js', 'src/server.js', 'server/app.js'];
          const entryFile = entryPoints.find(f => fs.existsSync(path.join(appPath, f)));

          if (entryFile) {
            pm2.start({
              script: path.join(appPath, entryFile),
              name: name,
              cwd: appPath
            }, callback);
          } else {
            res.status(404).json({ error: 'Entry point not found' });
          }
        }
      });
    } else {
      res.status(400).json({ error: 'Invalid action' });
    }
  });
});

app.post('/api/agents/:type/stop', (req, res) => {
  const { type } = req.params;
  if (!['claude', 'gemini'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  
  try {
    execSync(`pkill -f ${type}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to stop agents' });
  }
});

app.get('/api/scan', (req, res) => {
  const rootDir = '/home/tatsuya';
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  const potentialApps = [];
  dirs.forEach(dir => {
    const pkgPath = path.join(rootDir, dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        potentialApps.push({
          name: dir,
          path: path.join(rootDir, dir),
          version: pkg.version
        });
      } catch (e) {}
    }
  });
  res.json(potentialApps);
});

app.use(express.static(path.join(__dirname, '../client/build')));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard Server running on http://0.0.0.0:${PORT}`);
});
