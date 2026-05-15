import React, { useEffect, useState } from 'react';
import './App.css';

interface AppProcess {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  path: string;
  port: string | null;
  pm2_env: {
    node_version: string;
    out_log: string;
    err_log: string;
  };
}

interface PotentialApp {
  name: string;
  path: string;
  version: string;
}

interface ServerInfo {
  network: {
    localIps: string[];
    globalIp: string;
    desktopStatus: string;
    targetPcIp: string;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    percent: string;
  };
  agents: {
    claude: { mem: number, count: number, locations: string[] };
    gemini: { mem: number, count: number, locations: string[] };
  };
  os: {
    platform: string;
    uptime: number;
    loadavg: number[];
  };
}

function App() {
  const [apps, setApps] = useState<AppProcess[]>([]);
  const [potentialApps, setPotentialApps] = useState<PotentialApp[]>([]);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [selectedApp, setSelectedApp] = useState<AppProcess | null>(null);
  const [logs, setLogs] = useState<{ out: string; error: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [resApps, resScan, resInfo] = await Promise.all([
        fetch('/api/apps'),
        fetch('/api/scan'),
        fetch('/api/info')
      ]);
      const dataApps = await resApps.json();
      const dataScan = await resScan.json();
      const dataInfo = await resInfo.json();
      setApps(dataApps);
      setPotentialApps(dataScan);
      setServerInfo(dataInfo);
      
      if (selectedApp) {
        const updated = dataApps.find((a: AppProcess) => a.id === selectedApp.id);
        if (updated) setSelectedApp(updated);
      }
    } catch (e) {
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async (appName: string) => {
    try {
      const res = await fetch(`/api/apps/${appName}/logs`);
      const data = await res.json();
      setLogs(data);
    } catch (e) {
      console.error('Log fetch error:', e);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [selectedApp?.id]);

  const handleAction = async (name: string, action: string) => {
    if (action === 'delete' && !window.confirm(`${name} を管理から削除しますか？`)) return;
    try {
      await fetch(`/api/apps/${name}/${action}`, { method: 'POST' });
      fetchData();
      if (action === 'delete') setSelectedApp(null);
    } catch (e) {
      alert('操作に失敗しました');
    }
  };

  const stopAgents = async (type: string) => {
    if (!window.confirm(`${type} エージェントをすべて停止しますか？`)) return;
    try {
      await fetch(`/api/agents/${type}/stop`, { method: 'POST' });
      fetchData();
    } catch (e) {
      alert('停止に失敗しました');
    }
  };

  const formatMem = (bytes: number) => {
    if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  };
  
  const getAppUrl = (app: AppProcess) => {
    if (!app.port) return null;
    const host = window.location.hostname;
    return `http://${host}:${app.port}`;
  };

  return (
    <div className="container">
      <header>
        <div className="header-left">
          <h1>アプリ管理ダッシュボード</h1>
          {serverInfo && (
            <div className="network-info">
              <span><strong>ローカルIP:</strong> {serverInfo.network.localIps.join(', ')}</span>
              <span><strong>グローバルIP:</strong> {serverInfo.network.globalIp}</span>
              <span className={`desktop-status ${serverInfo.network.desktopStatus.toLowerCase()}`}>
                <strong>DESKTOP:</strong> {serverInfo.network.desktopStatus} ({serverInfo.network.targetPcIp})
              </span>
            </div>
          )}
        </div>
        <button onClick={fetchData} className="btn-refresh">更新</button>
      </header>

      {serverInfo && (
        <section className="sys-info-section">
          <div className="info-grid">
            <div className="info-card">
              <h4>システムメモリ</h4>
              <div className="mem-bar-container">
                <div className="mem-bar" style={{ width: `${serverInfo.memory.percent}%` }}></div>
              </div>
              <p>{serverInfo.memory.percent}% 使用中 ({formatMem(serverInfo.memory.used)} / {formatMem(serverInfo.memory.total)})</p>
              <p>空き容量: {formatMem(serverInfo.memory.free)}</p>
            </div>
            <div className="info-card">
              <h4>AIエージェント負荷 & 場所</h4>
              <div className="agent-stats">
                {['claude', 'gemini'].map(type => {
                  const data = serverInfo.agents[type as keyof typeof serverInfo.agents];
                  return (
                    <div key={type} className="agent-item-large">
                      <div className="agent-main">
                        <span className="agent-name">{type.toUpperCase()}</span>
                        <span className="agent-val">{formatMem(data.mem)} ({data.count} プロセス)</span>
                        <button onClick={() => stopAgents(type)} className="btn-mini-stop">すべて停止</button>
                      </div>
                      <div className="agent-locations">
                        {data.locations.map(loc => (
                          <div key={loc} className="loc-tag">📍 {loc.replace('/home/tatsuya', '~')}</div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}

      <section>
        <h2>稼働中・管理下のアプリ</h2>
        <div className="grid">
          {apps.map(app => (
            <div key={app.id} className={`card ${app.status}`} onClick={() => { setSelectedApp(app); fetchLogs(app.name); }}>
              <div className="card-header">
                <h3>{app.name}</h3>
                <span className={`status-badge ${app.status}`}>{app.status === 'online' ? '稼働中' : app.status}</span>
              </div>
              <div className="card-body">
                <p><strong>CPU:</strong> {app.cpu}%</p>
                <p><strong>メモリ:</strong> {formatMem(app.memory)}</p>
                <p><strong>再起動回数:</strong> {app.restarts}</p>
                {app.port && (
                  <p><strong>URL:</strong> <a href={getAppUrl(app)!} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{getAppUrl(app)}</a></p>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {selectedApp && (
        <div className="modal-overlay" onClick={() => setSelectedApp(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{selectedApp.name} の詳細詳細</h2>
              <button className="btn-close" onClick={() => setSelectedApp(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="detail-grid">
                <div className="detail-item"><strong>ステータス:</strong> {selectedApp.status}</div>
                <div className="detail-item"><strong>PID:</strong> {selectedApp.id} (PM2 ID)</div>
                <div className="detail-item"><strong>Node.js:</strong> {selectedApp.pm2_env.node_version}</div>
                <div className="detail-item"><strong>パス:</strong> <code>{selectedApp.path}</code></div>
              </div>

              <div className="modal-actions">
                {selectedApp.status === 'online' ? (
                  <button onClick={() => handleAction(selectedApp.name, 'stop')} className="btn-stop">停止</button>
                ) : (
                  <button onClick={() => handleAction(selectedApp.name, 'start')} className="btn-start">開始</button>
                )}
                <button onClick={() => handleAction(selectedApp.name, 'restart')} className="btn-restart">再起動</button>
                <button onClick={() => handleAction(selectedApp.name, 'delete')} className="btn-delete">管理から削除</button>
              </div>

              <div className="log-container">
                <div className="log-header">
                  <h4>標準出力 (Latest 100 lines)</h4>
                  <button onClick={() => fetchLogs(selectedApp.name)} className="btn-mini-refresh">更新</button>
                </div>
                <pre className="log-view">{logs?.out || 'ログを取得中...'}</pre>
                
                <h4>エラー出力</h4>
                <pre className="log-view error">{logs?.error || 'エラーログなし'}</pre>
              </div>
            </div>
          </div>
        </div>
      )}

      <section className="scan-section">
        <h2>検出されたプロジェクト (ホームディレクトリ)</h2>
        <table className="scan-table">
          <thead>
            <tr>
              <th>プロジェクト名</th>
              <th>バージョン</th>
              <th>パス</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {potentialApps.map(pa => {
              const isManaged = apps.some(a => a.name === pa.name);
              return (
                <tr key={pa.name}>
                  <td>{pa.name}</td>
                  <td>{pa.version}</td>
                  <td><code>{pa.path}</code></td>
                  <td>
                    {isManaged ? (
                      <span className="managed-label">管理済み</span>
                    ) : (
                      <button onClick={() => handleAction(pa.name, 'start')} className="btn-register">登録して開始</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default App;
