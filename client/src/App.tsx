import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import SecurityPanel from './SecurityPanel';

interface AppProcess {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  unstableRestarts?: number;
  path: string;
  port: string | null;
  url: string | null;
  pm2_env: { node_version: string; out_log: string; err_log: string };
}

interface PotentialApp { name: string; path: string; version: string; }

interface DockerContainer { ID: string; Names: string; Image: string; Status: string; Ports: string; }

interface SSHLogin {
  id: string;
  time: string;
  displayTime: string;
  user: string;
  ip: string;
  method: string;
  device: string | null;
  location: string | null;
  org: string;
  isLocal: boolean;
  historical: boolean;
}

interface ServerInfo {
  network: { localIps: string[]; globalIp: string };
  memory: { total: number; free: number; used: number; percent: string };
  disk: { total: number; used: number; avail: number; percent: string } | null;
  agents: Record<'claude' | 'gemini' | 'codex', { mem: number; count: number; locations: string[] }> | null;
  os: { platform: string; uptime: number; loadavg: number[] };
}

const sectionNames = {
  summary: 'アプリの状態集計',
  security: 'セキュリティ',
  'sys-info': 'サーバー情報',
  apps: '管理アプリ',
  docker: 'Dockerコンテナ',
  ssh: 'SSH / VS Code Remote',
  projects: '検出されたプロジェクト',
};
type SectionId = keyof typeof sectionNames;
const sectionIds = Object.keys(sectionNames) as SectionId[];

function App() {
  const [user, setUser] = useState<{ email: string; name: string } | null | undefined>(undefined);
  const [apps, setApps] = useState<AppProcess[]>([]);
  const [potentialApps, setPotentialApps] = useState<PotentialApp[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[]>([]);
  const [sshLogins, setSSHLogins] = useState<SSHLogin[]>([]);
  const [vscodeStatus, setVscodeStatus] = useState<{ running: boolean; processCount: number } | null>(null);
  const [vscodeKilling, setVscodeKilling] = useState(false);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [selectedApp, setSelectedApp] = useState<AppProcess | null>(null);
  const [logs, setLogs] = useState<{ out: string; err: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [dataError, setDataError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState('name');
  const [collapsed, setCollapsed] = useState<SectionId[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dashboard-collapsed-sections') || '[]');
      return Array.isArray(saved) ? sectionIds.filter(id => saved.includes(id)) : [];
    } catch { return []; }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<SectionId | 'search' | null>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState(() => {
    try { const saved = localStorage.getItem('dashboard-theme'); return saved && ['system', 'light', 'dark'].includes(saved) ? saved : 'system'; } catch { return 'system'; }
  });
  const [pending, setPending] = useState('');
  const pendingRef = useRef(false);
  const [pushStatus, setPushStatus] = useState<'unknown' | 'granted' | 'denied' | 'unsupported'>('unknown');
  const [logStatus, setLogStatus] = useState('接続中…');
  const [autoScroll, setAutoScroll] = useState(true);
  const [extraStatus, setExtraStatus] = useState<Record<string, string>>({ ssh: '読み込み中…', vscode: '読み込み中…', docker: '読み込み中…' });
  const outLogRef = useRef<HTMLPreElement>(null);
  const errLogRef = useRef<HTMLPreElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const logEsRef = useRef<EventSource | null>(null);
  const selectedAppRef = useRef<AppProcess | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [eventStatus, setEventStatus] = useState('接続中…');
  const [streamVersion, setStreamVersion] = useState(0);
  const [logFilter, setLogFilter] = useState('');
  const [pins, setPins] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem('dashboard-pins') || '[]'); return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string').slice(0, 100) : []; } catch { return []; }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const epochRef = useRef(0);
  const requestsRef = useRef(new Set<AbortController>());
  const refreshRef = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const extrasRef = useRef<Promise<void> | null>(null);
  const vscodeRevision = useRef(0);
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    mountedRef.current = true;
    const epoch = epochRef, requests = requestsRef.current;
    return () => {
      mountedRef.current = false; epoch.current++;
      requests.forEach(controller => controller.abort());
      logEsRef.current?.close();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('dashboard-theme', theme); } catch { /* Storage may be disabled. */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem('dashboard-pins', JSON.stringify(pins)); } catch { /* Keep in-memory pins usable. */ }
  }, [pins]);
  useEffect(() => {
    try { localStorage.setItem('dashboard-collapsed-sections', JSON.stringify(collapsed)); } catch { /* Keep toggles usable without storage. */ }
  }, [collapsed]);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButtonRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    navigationRef.current?.querySelector<HTMLButtonElement>('nav button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
    };
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !navigationRef.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('click', outside);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('click', outside); };
  }, [menuOpen, closeMenu]);
  useEffect(() => {
    if (!navigationTarget) return;
    const target = navigationTarget === 'search' ? searchRef.current : document.getElementById(`${navigationTarget}-title`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    setNavigationTarget(null);
  }, [navigationTarget]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || selectedAppRef.current || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) return;
      if (searchRef.current) {
        event.preventDefault();
        setMenuOpen(false);
        setCollapsed(previous => previous.filter(id => id !== 'apps'));
        setNavigationTarget('search');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const handleCloseModal = useCallback(() => {
    logEsRef.current?.close(); logEsRef.current = null;
    selectedAppRef.current = null;
    setSelectedApp(null); setLogs(null);
  }, []);
  const endSession = useCallback((message = '') => {
    epochRef.current++;
    userRef.current = null;
    requestsRef.current.forEach(controller => controller.abort());
    setUser(null); setMenuOpen(false); setNavigationTarget(null); handleCloseModal();
    setApps([]); setPotentialApps([]); setServerInfo(null); setSSHLogins([]); setDockerContainers([]); setVscodeStatus(null);
    setError(message); setNotice('');
  }, [handleCloseModal]);

  const request = useCallback(async (url: string, options?: RequestInit) => {
    const epoch = epochRef.current;
    const controller = new AbortController();
    const abort = () => controller.abort();
    requestsRef.current.add(controller);
    options?.signal?.addEventListener('abort', abort);
    if (options?.signal?.aborted || !mountedRef.current || (url !== '/auth/me' && !userRef.current)) controller.abort();
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; abort(); }, 15000);
    try {
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const response = await fetch(url, {
        ...options, cache: 'no-store', signal: controller.signal,
        headers: { ...(options?.method && options.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...options?.headers },
      });
      if (controller.signal.aborted || epoch !== epochRef.current) throw new DOMException('Cancelled', 'AbortError');
      if (response.status === 401) {
        if (url === '/auth/me') return { user: null };
        endSession('セッションが切れました。再ログインしてください。');
        throw new DOMException('Session expired', 'AbortError');
      }
      if (!response.ok) throw new Error(response.status === 429 ? 'リクエストが多すぎます。少し待って再試行してください。' : `通信に失敗しました (HTTP ${response.status})`);
      const data = await response.json();
      if (controller.signal.aborted || epoch !== epochRef.current) throw new DOMException('Cancelled', 'AbortError');
      return data;
    } catch (error) {
      if (timedOut) throw new Error(options?.method && options.method !== 'GET' ? '応答がありません。操作済みの可能性があるため、状態を確認してください。' : '通信がタイムアウトしました。');
      throw error;
    } finally {
      clearTimeout(timeout); requestsRef.current.delete(controller);
      options?.signal?.removeEventListener('abort', abort);
    }
  }, [endSession]);

  useEffect(() => {
    const controller = new AbortController();
    request('/auth/me', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setUser(data.user ?? null);
    }).catch(error => {
      if (!controller.signal.aborted && error.name !== 'AbortError') { setError('ログイン状態を確認できませんでした。再読み込みしてください。'); setUser(null); }
    });
    return () => controller.abort();
  }, [request]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { setPushStatus('unsupported'); return; }
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(async reg => {
      const existing = await reg.pushManager.getSubscription();
      if (controller.signal.aborted) return;
      if (existing) await request('/api/push/subscribe', { method: 'POST', body: JSON.stringify(existing), signal: controller.signal });
      if (!controller.signal.aborted) setPushStatus(Notification.permission === 'denied' ? 'denied' : existing ? 'granted' : 'unknown');
    }).catch(error => { if (!controller.signal.aborted && error.name !== 'AbortError') setError('通知の登録を確認できませんでした。'); });
    return () => controller.abort();
  }, [user, request]);

  const fetchData = useCallback((signal?: AbortSignal, force = false): Promise<void> => {
    if (!userRef.current) return Promise.resolve();
    if (refreshRef.current && !refreshRef.current.controller.signal.aborted) {
      if (!force) return refreshRef.current.promise;
      refreshRef.current.controller.abort();
    }
    const controller = new AbortController();
    const epoch = epochRef.current;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    if (signal?.aborted) controller.abort();
    setRefreshing(true);
    const promise = (async () => {
      try {
        const results = await Promise.allSettled(['/api/apps', '/api/scan', '/api/info'].map(url => request(url, { signal: controller.signal })));
        if (controller.signal.aborted || epoch !== epochRef.current || !userRef.current) return;
        const [appResult, scanResult, infoResult] = results;
        if (appResult.status === 'fulfilled') {
          const dataApps: AppProcess[] = appResult.value;
          if (!Array.isArray(dataApps)) throw new Error('アプリ一覧の形式が不正です。');
          setApps(dataApps); setLastUpdated(new Date());
          const selected = selectedAppRef.current;
          if (selected) {
            const updated = dataApps.find(app => app.id === selected.id && app.name === selected.name && app.path === selected.path);
            if (updated) { selectedAppRef.current = updated; setSelectedApp(updated); } else handleCloseModal();
          }
        }
        if (scanResult.status === 'fulfilled' && Array.isArray(scanResult.value)) setPotentialApps(scanResult.value);
        if (infoResult.status === 'fulfilled') setServerInfo(infoResult.value);
        setDataError(results.map((result, i) => result.status === 'rejected' ? `${['アプリ', 'プロジェクト', 'システム'][i]}: ${result.reason.message}` : '').filter(Boolean).join(' / '));
      } catch (error) {
        if (!controller.signal.aborted && epoch === epochRef.current) setDataError((error as Error).message);
      } finally {
        signal?.removeEventListener('abort', abort);
        if (refreshRef.current?.controller === controller) {
          refreshRef.current = null;
          if (mountedRef.current && epoch === epochRef.current) { setLoading(false); setRefreshing(false); }
        }
      }
    })();
    refreshRef.current = { controller, promise };
    return promise;
  }, [request, handleCloseModal]);

  const mergeSSH = useCallback((incoming: SSHLogin[]) => {
    setSSHLogins(previous => {
      const entries = new Map(previous.map(entry => [entry.id, entry]));
      incoming.forEach(entry => {
        const old = entries.get(entry.id);
        entries.set(entry.id, old?.location && !entry.location ? { ...entry, location: old.location, org: old.org } : entry);
      });
      return Array.from(entries.values()).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 50);
    });
  }, []);
  const fetchExtras = useCallback((signal?: AbortSignal): Promise<void> => {
    if (!userRef.current) return Promise.resolve();
    if (extrasRef.current) return extrasRef.current;
    const epoch = epochRef.current;
    const revision = vscodeRevision.current;
    const update = async (key: string, url: string, apply: (data: any) => void) => {
      try {
        const data = await request(url, { signal });
        if (signal?.aborted || epoch !== epochRef.current || !userRef.current || (key === 'vscode' && revision !== vscodeRevision.current)) return;
        apply(data); setExtraStatus(prev => ({ ...prev, [key]: '' }));
      } catch (error) {
        if (!signal?.aborted && epoch === epochRef.current && (error as Error).name !== 'AbortError') setExtraStatus(prev => ({ ...prev, [key]: '取得に失敗しました。表示は前回取得時の情報です。' }));
      }
    };
    const promise = Promise.all([
      update('ssh', '/api/ssh/logins', mergeSSH), update('vscode', '/api/vscode/status', setVscodeStatus), update('docker', '/api/docker', setDockerContainers),
    ]).then(() => {}).finally(() => { if (extrasRef.current === promise) extrasRef.current = null; });
    extrasRef.current = promise;
    return promise;
  }, [request, mergeSSH]);

  useEffect(() => {
    if (!user || !autoRefresh) return;
    const controller = new AbortController();
    fetchData(controller.signal); fetchExtras(controller.signal);
    const interval = setInterval(() => { if (!document.hidden) fetchData(controller.signal); }, 5000);
    const extraInterval = setInterval(() => { if (!document.hidden) fetchExtras(controller.signal); }, 10000);
    const visible = () => { if (!document.hidden) { fetchData(controller.signal); fetchExtras(controller.signal); } };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); clearInterval(interval); clearInterval(extraInterval); document.removeEventListener('visibilitychange', visible); };
  }, [user, autoRefresh, fetchData, fetchExtras]);

  useEffect(() => {
    if (!user) { handleCloseModal(); return; }
    const es = new EventSource('/api/events');
    let active = true;
    setEventStatus('接続中…');
    es.addEventListener('ready', () => { if (active) { setEventStatus('接続済み'); fetchData(); fetchExtras(); } });
    es.addEventListener('statechange', () => { if (active) fetchData(undefined, true); });
    es.addEventListener('sshlogin', (event: MessageEvent) => {
      if (!active) return;
      try { const entry = JSON.parse(event.data); if (typeof entry.id !== 'string' || !Number.isFinite(Date.parse(entry.time))) throw new Error(); mergeSSH([entry]); } catch { setEventStatus('不正なイベントを受信しました'); }
    });
    es.addEventListener('vscode-status', (event: MessageEvent) => {
      if (!active) return;
      try { const status = JSON.parse(event.data); if (typeof status.running !== 'boolean') throw new Error(); vscodeRevision.current++; setVscodeStatus(status); } catch { setEventStatus('状態の更新に失敗しました'); }
    });
    es.addEventListener('session-expired', () => { if (active) endSession('セッションが切れました。再ログインしてください。'); });
    es.onerror = () => {
      if (!active) return;
      setEventStatus(es.readyState === 2 ? '切断されました' : '再接続中…');
      request('/auth/me').then(data => { if (active && !data.user) endSession('セッションが切れました。再ログインしてください。'); }).catch(() => {});
    };
    return () => { active = false; es.close(); };
  }, [user, streamVersion, request, fetchData, fetchExtras, mergeSSH, handleCloseModal, endSession]);

  const startLogStream = (app: AppProcess) => {
    logEsRef.current?.close();
    setSelectedApp(app); selectedAppRef.current = app;
    setLogs(null); setLogStatus('接続中…');
    const es = new EventSource(`/api/apps/${app.id}/logs/stream`);
    logEsRef.current = es;
    es.addEventListener('init', (event: MessageEvent) => {
      if (logEsRef.current !== es) return;
      try { const data = JSON.parse(event.data); if (typeof data.out !== 'string' || typeof data.err !== 'string') throw new Error(); setLogs({ out: data.out.slice(-100000), err: data.err.slice(-100000) }); setLogStatus('LIVE'); }
      catch { setLogStatus('ログの形式が不正です'); }
    });
    es.addEventListener('log', (event: MessageEvent) => {
      if (logEsRef.current !== es) return;
      try {
        const data = JSON.parse(event.data);
        if (!['out', 'err'].includes(data.type) || typeof data.line !== 'string') throw new Error();
        // ponytail: retain 100k characters per stream; use paged history for older logs.
        setLogs(prev => ({ out: ((prev?.out || '') + (data.type === 'out' ? data.line : '')).slice(-100000), err: ((prev?.err || '') + (data.type === 'err' ? data.line : '')).slice(-100000) }));
        setLogStatus('LIVE');
      } catch { setLogStatus('ログの形式が不正です'); }
    });
    es.addEventListener('log-warning', () => { if (logEsRef.current === es) setLogStatus('ログファイルを追尾できません。作成・権限を確認してください。'); });
    es.addEventListener('session-expired', () => { if (logEsRef.current === es) endSession('セッションが切れました。再ログインしてください。'); });
    es.onerror = () => { if (logEsRef.current === es) { setLogStatus(es.readyState === 2 ? '接続できません。再接続を押してください。' : '切断されました。再接続中…'); fetchData(undefined, true); } };
  };

  const selectedId = selectedApp?.id;
  useEffect(() => {
    if (selectedId === undefined) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog?.close(); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [selectedId]);
  useEffect(() => {
    if (!autoScroll) return;
    if (outLogRef.current) outLogRef.current.scrollTop = outLogRef.current.scrollHeight;
    if (errLogRef.current) errLogRef.current.scrollTop = errLogRef.current.scrollHeight;
  }, [logs, autoScroll, logFilter]);

  const runAction = async (label: string, action: () => Promise<string | void>) => {
    if (pendingRef.current) return;
    const epoch = epochRef.current;
    pendingRef.current = true;
    setPending(label); setError(''); setNotice('');
    try { const message = await action(); if (mountedRef.current && epoch === epochRef.current) setNotice(message || `${label}が完了しました。`); }
    catch (error) { if (mountedRef.current && epoch === epochRef.current && (error as Error).name !== 'AbortError') setError(`${label}: ${(error as Error).message}`); }
    finally { pendingRef.current = false; if (mountedRef.current) setPending(''); }
  };
  const handleEnablePush = () => runAction('通知の有効化', async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { setPushStatus(permission === 'denied' ? 'denied' : 'unknown'); throw new Error('通知が許可されていません。'); }
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    const reg = await navigator.serviceWorker.ready;
    const { key } = await request('/api/push/vapid-public-key');
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await request('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
    setPushStatus('granted');
  });
  const handleDisablePush = () => runAction('通知の無効化', async () => {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await request('/api/push/unsubscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    setPushStatus('unknown');
  });
  const handleTestPush = () => runAction('テスト通知', async () => { await request('/api/push/test', { method: 'POST' }); });
  const handleLogout = () => runAction('ログアウト', async () => { await request('/auth/logout', { method: 'POST' }); endSession(); });
  const handleAction = (name: string, action: string, id?: number) => {
    const label = ({ start: '開始', register: '登録して開始', stop: '停止', restart: '再起動', delete: '管理から削除' } as Record<string, string>)[action];
    if (!['start', 'register'].includes(action) && !window.confirm(`${name} を${label}しますか？${action === 'delete' ? '\nプロセスを停止し、PM2の管理から削除します。' : '\n接続中の処理が中断されることがあります。'}`)) return;
    return runAction(`${name} の${label}`, async () => {
      const selected = selectedAppRef.current;
      refreshRef.current?.controller.abort();
      await request(`/api/apps/${encodeURIComponent(id === undefined ? name : String(id))}/${action}`, { method: 'POST', body: JSON.stringify({ expected: selected && id !== undefined ? { name: selected.name, path: selected.path } : undefined }) });
      if (action === 'delete') handleCloseModal();
      await fetchData(undefined, true);
    });
  };
  const handleKillVscode = () => {
    if (!window.confirm('VS Codeサーバーをすべて停止しますか？\n接続中のVS Codeが切断されます。接続元が自動再接続すると再起動します。')) return;
    return runAction('VS Codeの停止', async () => {
      setVscodeKilling(true); vscodeRevision.current++;
      try {
        const result = await request('/api/vscode/kill', { method: 'POST' });
        vscodeRevision.current++; setVscodeStatus(result); setExtraStatus(prev => ({ ...prev, vscode: '' }));
        return ({ stopped: 'VS Codeの停止を確認しました（2秒間の観測）。以後の自動再接続は防ぎません。', 'already-stopped': 'VS Codeはすでに停止しています。', restarted: 'VS Codeの再起動を検知しました。接続元の自動再接続を止めてください。', 'still-running': '停止要求後もVS Codeが稼働しています。状態を確認してください。' } as Record<string, string>)[result.outcome] || '停止要求を送信しました。状態を再確認してください。';
      } finally { vscodeRevision.current++; if (mountedRef.current) setVscodeKilling(false); }
    });
  };
  const stopAgents = (type: string) => {
    if (!window.confirm(`${type} エージェントをすべて停止しますか？`)) return;
    return runAction(`${type} の停止`, async () => { await request(`/api/agents/${type}/stop`, { method: 'POST' }); await fetchData(undefined, true); });
  };
  const pinKey = (app: AppProcess) => JSON.stringify([app.path, app.name]);
  const filterLog = (value: string) => logFilter ? value.split('\n').filter(line => line.toLowerCase().includes(logFilter.toLowerCase())).join('\n') : value;
  const downloadLogs = () => {
    if (!logs || !selectedApp) return;
    const contents = `# ${selectedApp.name} — ${new Date().toISOString()}\n# 保持中の表示ログ（各出力最大100,000文字）\n\n[stdout]\n${filterLog(logs.out)}\n\n[stderr]\n${filterLog(logs.err)}\n`;
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${selectedApp.name.replace(/[^a-zA-Z0-9_-]/g, '_')}-logs.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const formatMem = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  };

  const formatUptime = (startMs: number) => {
    if (!startMs) return '-';
    const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    const m = Math.floor(s / 60); const h = Math.floor(m / 60); const d = Math.floor(h / 24);
    if (d > 0) return `${d}日 ${h % 24}時間`;
    if (h > 0) return `${h}時間 ${m % 60}分`;
    return `${m}分`;
  };

  const barColor = (pct: number, reverse = false) => {
    if (reverse) return pct > 85 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--success)';
    return pct > 85 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--accent)';
  };

  const filteredApps = apps.filter(a => `${a.name} ${a.path} ${a.port || ''}`.toLowerCase().includes(filter.trim().toLowerCase()) &&
    (statusFilter === 'all' || (statusFilter === 'other' ? !['online', 'stopped', 'errored'].includes(a.status) : a.status === statusFilter)))
    .sort((a, b) => Number(pins.includes(pinKey(b))) - Number(pins.includes(pinKey(a))) || (sort === 'cpu' ? b.cpu - a.cpu : sort === 'memory' ? b.memory - a.memory : sort === 'restarts' ? b.restarts - a.restarts : 0) || a.name.localeCompare(b.name, 'ja', { numeric: true }) || a.id - b.id);
  const themeControl = <label className="theme-control">表示<select aria-label="表示テーマ" value={theme} onChange={e => setTheme(e.target.value)}><option value="system">端末に合わせる</option><option value="light">ライト</option><option value="dark">ダーク</option></select></label>;
  const sectionHeading = (id: SectionId, count?: React.ReactNode) => (
    <h2 id={`${id}-title`} className="section-title" tabIndex={-1}>
      <button className="section-toggle" aria-expanded={!collapsed.includes(id)} aria-controls={`${id}-body`}
        onClick={() => setCollapsed(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])}>
        <span className="section-chevron" aria-hidden="true">{collapsed.includes(id) ? '›' : '⌄'}</span>{sectionNames[id]}
      </button>{count != null && <span className="count">{count}</span>}
    </h2>
  );

  if (user === undefined) return <div className="loading" role="status">読み込み中…</div>;

  if (!user) return (
    <div className="login-screen">
      <div className="login-card">
        <h1>アプリ管理ダッシュボード</h1>
        <p>Googleアカウントでログインしてください</p>
        {themeControl}
        {error && <p className="login-error" role="alert">{error}</p>}
        <a href="/auth/google" className="btn-google">
          <img src="https://www.google.com/favicon.ico" alt="" width={18} height={18} />
          Googleでログイン
        </a>
        {window.location.search.includes('error=unauthorized') && (
          <p className="login-error">アクセス権限がありません</p>
        )}
      </div>
    </div>
  );


  return (
    <main className="container">
      <header>
        <div className="section-navigation" ref={navigationRef}>
          <button ref={menuButtonRef} className="menu-toggle" aria-label="セクションメニュー" aria-expanded={menuOpen} aria-controls="section-menu"
            onClick={() => menuOpen ? closeMenu() : setMenuOpen(true)}><span aria-hidden="true">☰</span></button>
          <nav id="section-menu" className="section-menu" aria-label="セクション一覧" hidden={!menuOpen}>
            {sectionIds.filter(id => id !== 'sys-info' || serverInfo).map(id => (
              <button key={id} onClick={() => {
                setCollapsed(previous => previous.filter(value => value !== id));
                setMenuOpen(false);
                setNavigationTarget(id);
              }}>{sectionNames[id]}</button>
            ))}
          </nav>
        </div>
        <div className="header-left">
          <p className="eyebrow">SERVER OVERVIEW</p>
          <h1>アプリ管理ダッシュボード</h1>
          {serverInfo && (
            <div className="network-info">
              <span><strong>ローカルIP:</strong> {serverInfo.network.localIps.join(', ')}</span>
              <span><strong>グローバルIP:</strong> {serverInfo.network.globalIp}</span>
            </div>
          )}
        </div>
        <div className="header-right">
          <span className="user-name">{user.name}</span>
          {themeControl}
          {pushStatus === 'unknown' && <button disabled={!!pending} onClick={handleEnablePush} className="btn-push">🔔 通知を有効化</button>}
          {pushStatus === 'granted' && <><button disabled={!!pending} onClick={handleTestPush} className="btn-push-test">🔔 テスト通知</button><button disabled={!!pending} onClick={handleDisablePush}>通知を無効化</button></>}
          {pushStatus === 'unsupported' && <span className="push-note">※ホーム画面に追加すると通知が使えます</span>}
          {pushStatus === 'denied' && <span className="push-note">通知はブラウザ設定で許可してください</span>}
          <button onClick={() => { fetchData(undefined, true); fetchExtras(); }} disabled={refreshing} className="btn-refresh">{refreshing ? '更新中…' : '更新'}</button>
          <label className="refresh-toggle"><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />定期更新</label>
          <button disabled={!!pending} onClick={handleLogout} className="btn-logout">ログアウト</button>
        </div>
      </header>
      <div className="update-status" role="status">{loading ? '情報を読み込み中…' : lastUpdated ? `アプリ最終更新 ${lastUpdated.toLocaleTimeString('ja-JP')} · ${autoRefresh ? '5秒ごとに更新（非表示時は休止）' : '定期更新を停止中'}` : '未取得'}</div>
      <div className="update-status">イベント: {eventStatus} · ログは詳細画面でライブ更新 {eventStatus !== '接続済み' && <button onClick={() => setStreamVersion(value => value + 1)}>イベント再接続</button>}</div>
      {dataError && <div className="feedback error" role="alert">{dataError}。取得できた項目のみ更新しています。 <button disabled={refreshing} onClick={() => fetchData()}>再試行</button></div>}
      {!selectedApp && error && <div className="feedback error" role="alert">{error}</div>}
      {!selectedApp && (pending || notice) && <div className="feedback" role="status">{pending ? `${pending}中…` : notice}</div>}
      <section id="summary" aria-labelledby="summary-title">
        {sectionHeading('summary')}
        <div id="summary-body" className="summary-grid" hidden={collapsed.includes('summary')}>
        {[['all', 'すべて', apps.length], ['online', '稼働中', apps.filter(a => a.status === 'online').length], ['stopped', '停止', apps.filter(a => a.status === 'stopped').length], ['errored', 'エラー', apps.filter(a => a.status === 'errored').length]].map(([value, label, count]) => (
          <button key={value} className={`summary-item ${value}`} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(String(value))}><span>{label}</span><strong>{lastUpdated ? count : '—'}</strong></button>
        ))}
        </div>
      </section>

      <SecurityPanel request={request} autoRefresh={autoRefresh} heading={sectionHeading('security')} collapsed={collapsed.includes('security')} />

      {serverInfo && (
        <section id="sys-info" className="sys-info-section" aria-labelledby="sys-info-title">
          {sectionHeading('sys-info')}
          <div id="sys-info-body" className="info-grid" hidden={collapsed.includes('sys-info')}>
            <div className="info-card">
              <h4>システムメモリ</h4>
              <div className="bar-container">
                <div className="bar" style={{ width: `${serverInfo.memory.percent}%`, background: barColor(parseFloat(serverInfo.memory.percent)) }} />
              </div>
              <p>{serverInfo.memory.percent}% 使用中 ({formatMem(serverInfo.memory.used)} / {formatMem(serverInfo.memory.total)})</p>
              <p>空き: {formatMem(serverInfo.memory.free)}</p>
            </div>
            <div className="info-card">
              <h4>ディスク使用量</h4>
              {serverInfo.disk ? <>
              <div className="bar-container">
                <div className="bar" style={{ width: `${serverInfo.disk.percent}%`, background: barColor(parseFloat(serverInfo.disk.percent), true) }} />
              </div>
              <p>{serverInfo.disk.percent}% 使用中 ({formatMem(serverInfo.disk.used)} / {formatMem(serverInfo.disk.total)})</p>
              <p>空き: {formatMem(serverInfo.disk.avail)}</p>
              </> : <p role="status">ディスク使用量を取得できませんでした。</p>}
              <div className="loadavg">
                <span className="loadavg-label">Load avg:</span>
                {serverInfo.os.loadavg.map((v, i) => <span key={i} className="load-chip">{v.toFixed(2)}</span>)}
                <span className="loadavg-label" style={{ marginLeft: 8 }}>(1m / 5m / 15m)</span>
              </div>
            </div>
            <div className="info-card">
              <h4>AIエージェント負荷 & 場所</h4>
              {serverInfo.agents ? <div className="agent-stats">
                {(['claude', 'gemini', 'codex'] as const).map(type => {
                  const data = serverInfo.agents![type];
                  if (!data) return null;
                  return (
                    <div key={type} className="agent-item-large">
                      <div className="agent-main">
                        <span className="agent-name">{type.toUpperCase()}</span>
                        <span className="agent-val">{formatMem(data.mem)} ({data.count} プロセス)</span>
                        <button disabled={!!pending || data.count === 0} onClick={() => stopAgents(type)} className="btn-mini-stop">すべて停止</button>
                      </div>
                      <div className="agent-locations">
                        {data.locations.map(loc => <div key={loc} className="loc-tag">📍 {loc.replace('/home/tatsuya', '~')}</div>)}
                      </div>
                    </div>
                  );
                })}
              </div> : <p role="status">エージェント情報を取得できませんでした。</p>}
            </div>
          </div>
        </section>
      )}

      <section id="apps" aria-labelledby="apps-title">
        {sectionHeading('apps', `${filteredApps.length} / ${apps.length}`)}
        <div id="apps-body" hidden={collapsed.includes('apps')}>
        <div className="section-header">
          <div className="filters">
            <label>検索<input ref={searchRef} className="search-input" type="search" placeholder="名前・パス・ポート（/ キー）" value={filter} onChange={e => setFilter(e.target.value)} /></label>
            <label>状態<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">すべて</option><option value="online">稼働中</option><option value="stopped">停止</option><option value="errored">エラー</option><option value="other">その他</option></select></label>
            <label>並べ替え<select value={sort} onChange={e => setSort(e.target.value)}><option value="name">名前順</option><option value="cpu">CPU使用率順</option><option value="memory">メモリ使用量順</option><option value="restarts">再起動回数順</option></select></label>
          </div>
        </div>
        {!loading && !dataError && filteredApps.length === 0 && <div className="empty-state">{apps.length ? '条件に一致するアプリはありません。' : '管理中のアプリはありません。下のプロジェクト一覧から登録できます。'}{apps.length > 0 && <button onClick={() => { setFilter(''); setStatusFilter('all'); }}>絞り込みを解除</button>}</div>}
        <div className="grid" aria-busy={refreshing}>
          {filteredApps.map(app => (
            <article key={app.id} className={`card ${app.status}`}>
              <div className="card-header">
                <button className="pin-button" aria-label={`${app.name} をお気に入り${pins.includes(pinKey(app)) ? 'から解除' : 'に追加'}`} aria-pressed={pins.includes(pinKey(app))} onClick={() => setPins(prev => prev.includes(pinKey(app)) ? prev.filter(key => key !== pinKey(app)) : [...prev.slice(-99), pinKey(app)])}>{pins.includes(pinKey(app)) ? '★' : '☆'}</button>
                <h3>{app.url && <span className="ssl-lock" title="HTTPS有効">🔒</span>}{app.name}</h3>
                <span className={`status-badge ${app.status}`}>
                  {app.status === 'online' ? '稼働中' : app.status === 'stopped' ? '停止' : app.status === 'errored' ? 'エラー' : app.status}
                </span>
              </div>
              <div className="card-body">
                {app.status === 'online' && (
                  <div className="cpu-row">
                    <span>CPU {app.cpu}%</span>
                    <div className="bar-container small">
                      <div className="bar" style={{ width: `${Math.min(app.cpu, 100)}%`, background: barColor(app.cpu, true) }} />
                    </div>
                  </div>
                )}
                <p><strong>メモリ:</strong> {formatMem(app.memory)}</p>
                <p><strong>稼働時間:</strong> {app.status === 'online' ? formatUptime(app.uptime) : '-'}</p>
                {(app.unstableRestarts || 0) >= 3 && <p className="crash-warning">短時間の再起動 {app.unstableRestarts}回 · ログを確認</p>}
                <p><strong>再起動:</strong> {app.restarts}回 <span className="muted">· ID {app.id}{app.port ? ` · :${app.port}` : ''}</span></p>
                <button className="btn-details" onClick={() => startLogStream(app)} aria-label={`${app.name} の詳細とログ`}>詳細・ログを開く →</button>
                {app.url && <a href={app.url} target="_blank" rel="noreferrer" className="app-link" onClick={e => e.stopPropagation()}>{app.url}</a>}
              </div>
            </article>
          ))}
        </div>
        </div>
      </section>

      {(
        <section id="docker" className="scan-section" aria-labelledby="docker-title">
          {sectionHeading('docker', dockerContainers.length)}
          <div id="docker-body" hidden={collapsed.includes('docker')}>
          {extraStatus.docker && <p role="status">{extraStatus.docker}</p>}
          {!extraStatus.docker && dockerContainers.length === 0 && <p className="empty-state">稼働中のコンテナはありません。</p>}
          <div className="table-scroll" role="region" aria-label="一覧表（横スクロール可能）" tabIndex={0}><table className="scan-table">
            <thead>
              <tr><th>名前</th><th>イメージ</th><th>ステータス</th><th>ポート</th></tr>
            </thead>
            <tbody>
              {dockerContainers.map(c => (
                <tr key={c.ID}>
                  <td>{c.Names}</td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>{c.Image}</td>
                  <td style={{ color: c.Status.startsWith('Up') ? 'var(--success)' : 'var(--danger)', fontWeight: 600, fontSize: '0.85rem' }}>{c.Status}</td>
                  <td><code style={{ fontSize: '0.72rem' }}>{c.Ports || '-'}</code></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          </div>
        </section>
      )}

      {selectedApp && (
        <dialog ref={dialogRef} className="modal-content" aria-labelledby="app-detail-title" onCancel={handleCloseModal} onClick={e => { if (e.target === e.currentTarget) handleCloseModal(); }}>
            <div className="modal-header">
              <h2 id="app-detail-title">{selectedApp.name} の詳細</h2>
              <button aria-label="詳細を閉じる" className="btn-close" onClick={handleCloseModal}>×</button>
            </div>
            <div className="modal-body">
              {error && <div className="feedback error" role="alert">{error}</div>}
              {(pending || notice) && <div className="feedback" role="status">{pending ? `${pending}中…` : notice}</div>}
              <div className="detail-grid">
                <div className="detail-item"><strong>ステータス:</strong> {selectedApp.status}</div>
                <div className="detail-item"><strong>PM2 ID:</strong> {selectedApp.id}</div>
                <div className="detail-item"><strong>Node.js:</strong> {selectedApp.pm2_env.node_version}</div>
                <div className="detail-item"><strong>稼働時間:</strong> {selectedApp.status === 'online' ? formatUptime(selectedApp.uptime) : '-'}</div>
                <div className="detail-item" style={{ gridColumn: '1 / -1' }}><strong>パス:</strong> <code>{selectedApp.path}</code></div>
                {selectedApp.url && (
                  <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                    <strong>URL:</strong> <a href={selectedApp.url} target="_blank" rel="noreferrer">{selectedApp.url}</a>
                  </div>
                )}
              </div>
              <div className="modal-actions">
                {selectedApp.status === 'online'
                  ? <button disabled={!!pending} onClick={() => handleAction(selectedApp.name, 'stop', selectedApp.id)} className="btn-stop">停止</button>
                  : <button disabled={!!pending} onClick={() => handleAction(selectedApp.name, 'start', selectedApp.id)} className="btn-start">開始</button>}
                <button disabled={!!pending} onClick={() => handleAction(selectedApp.name, 'restart', selectedApp.id)} className="btn-restart">再起動</button>
                <button disabled={!!pending} onClick={() => handleAction(selectedApp.name, 'delete', selectedApp.id)} className="btn-delete">管理から削除</button>
              </div>
              <div className="log-container">
                <div className="log-tools">
                  <label>ログ内検索<input type="search" value={logFilter} onChange={event => setLogFilter(event.target.value)} placeholder="文字列を含む行" /></label>
                  <button disabled={!logs} onClick={downloadLogs}>表示ログを保存</button>
                  <button onClick={() => startLogStream(selectedApp)}>ログ再接続</button>
                </div>
                <p className="log-note">各出力の最新100,000文字まで保持。再接続時は直近50行から再取得します。</p>
                <div className="log-header">
                  <h4>標準出力 <span className="log-status" role="status">{logStatus}</span></h4>
                  <label className="auto-scroll"><input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />自動スクロール</label>
                </div>
                <pre className="log-view" ref={outLogRef}>{logs === null ? 'ログ取得中…' : filterLog(logs.out) || (logFilter ? '一致する行はありません' : '標準出力ログはありません')}</pre>
                <h4 style={{ color: 'var(--log-muted)', marginTop: '15px' }}>エラー出力</h4>
                <pre className="log-view error" ref={errLogRef}>{logs === null ? 'ログ取得中…' : filterLog(logs.err) || (logFilter ? '一致する行はありません' : 'エラーログなし')}</pre>
              </div>
            </div>
        </dialog>
      )}

      <section id="ssh" className="scan-section" aria-labelledby="ssh-title">
        {sectionHeading('ssh')}
        <div id="ssh-body" hidden={collapsed.includes('ssh')}>
        <div className="section-header" style={{ marginBottom: 12 }}>
          {vscodeStatus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {vscodeStatus.running ? (
                <>
                  <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '0.9rem' }}>
                    💻 VS Codeサーバー稼働中 ({vscodeStatus.processCount} プロセス)
                  </span>
                  <button
                    onClick={handleKillVscode}
                    disabled={vscodeKilling || !!pending}
                    className="btn-stop"
                    style={{ padding: '4px 12px', fontSize: '0.82rem' }}
                  >
                    {vscodeKilling ? '停止中...' : 'VS Codeを停止'}
                  </button>
                </>
              ) : (
                <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>VS Codeサーバー: 停止中</span>
              )}
            </div>
          )}
        </div>
        {extraStatus.vscode && <p role="status">VS Code: {extraStatus.vscode}</p>}
        {extraStatus.ssh && <p role="status">SSH: {extraStatus.ssh}</p>}
        {!extraStatus.ssh && sshLogins.length === 0 && <p className="empty-state">最近のSSHログインはありません。</p>}
        {sshLogins.length > 0 && (
          <div className="table-scroll" role="region" aria-label="一覧表（横スクロール可能）" tabIndex={0}><table className="scan-table">
            <thead>
              <tr><th>日時</th><th>ユーザー</th><th>端末</th><th>IPアドレス</th><th>場所</th></tr>
            </thead>
            <tbody>
              {sshLogins.map(login => (
                <tr key={login.id} >
                  <td style={{ fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                    {new Date(login.time).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>{login.user}</td>
                  <td>
                    {login.device
                      ? <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{login.device}</span>
                      : <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>不明</span>}
                  </td>
                  <td><code style={{ fontSize: '0.8rem' }}>{login.ip}</code></td>
                  <td style={{ fontSize: '0.82rem' }}>
                    {login.isLocal
                      ? <span style={{ color: 'var(--success)' }}>🏠 ローカル</span>
                      : login.location
                        ? <span style={{ color: login.historical ? 'var(--muted)' : 'var(--text)' }}>🌏 {login.location}{login.org ? ` (${login.org})` : ''}</span>
                        : <span style={{ color: 'var(--muted)' }}>-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        </div>
      </section>

      <section id="projects" className="scan-section" aria-labelledby="projects-title">
        {sectionHeading('projects', potentialApps.length)}
        <div id="projects-body" hidden={collapsed.includes('projects')}>
        {!loading && !dataError && potentialApps.length === 0 && <p className="empty-state">ホームディレクトリにプロジェクトが見つかりませんでした。</p>}
        <div className="table-scroll" role="region" aria-label="一覧表（横スクロール可能）" tabIndex={0}><table className="scan-table">
          <thead><tr><th>プロジェクト名</th><th>バージョン</th><th>パス</th><th>操作</th></tr></thead>
          <tbody>
            {potentialApps.map(pa => {
              const isManaged = apps.some(a => a.path === pa.path || a.name === pa.name);
              return (
                <tr key={pa.path}>
                  <td>{pa.name}</td>
                  <td>{pa.version}</td>
                  <td><code>{pa.path}</code></td>
                  <td>{isManaged ? <span className="managed-label">管理済み</span> : <button disabled={!!pending} onClick={() => handleAction(pa.name, 'register')} className="btn-register">登録して開始</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        </div>
      </section>
    </main>
  );
}

export default App;
