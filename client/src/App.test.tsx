import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';

const processes = [
  { id: 1, name: 'alpha', status: 'online', cpu: 10, memory: 100, uptime: Date.now(), restarts: 1, path: '/apps/alpha', port: '3030', url: null, pm2_env: {} },
  { id: 2, name: 'beta', status: 'errored', cpu: 0, memory: 900, uptime: 0, restarts: 4, path: '/apps/beta', port: null, url: null, pm2_env: {} },
];
const system = { network: { localIps: [], globalIp: '' }, memory: { total: 100, used: 50, free: 50, percent: '50' }, disk: { total: 100, used: 20, avail: 80, percent: '20' }, agents: { claude: { mem: 0, count: 0, locations: [] }, gemini: { mem: 0, count: 0, locations: [] } }, os: { platform: 'linux', uptime: 10, loadavg: [0, 0, 0] } };
const streams: Array<{ url: string; close: jest.Mock; listeners: Record<string, (event: MessageEvent) => void> }> = [];
let apiStatus = 200;
let actionStatus = 500;

beforeEach(() => {
  apiStatus = 200; actionStatus = 500;
  streams.length = 0;
  localStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: jest.fn().mockReturnValue({ matches: false }) });
  Object.defineProperty(window, 'EventSource', { writable: true, value: jest.fn().mockImplementation((url: string) => {
    const listeners: Record<string, (event: MessageEvent) => void> = {};
    const stream = { url, listeners, addEventListener: jest.fn((name: string, listener: (event: MessageEvent) => void) => { listeners[name] = listener; }), close: jest.fn() };
    streams.push(stream); return stream;
  }) });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  global.fetch = jest.fn(async (input, options) => {
    const url = String(input);
    const status = options?.method === 'POST' ? actionStatus : url === '/auth/me' ? 200 : apiStatus;
    const data: Record<string, unknown> = {
      '/auth/me': { user: { email: 'owner@example.test', name: 'Owner' } },
      '/api/apps': processes, '/api/scan': [], '/api/info': system,
      '/api/docker': [], '/api/ssh/logins': [], '/api/vscode/status': { running: false, processCount: 0 },
      '/api/security': { generatedAt: new Date().toISOString(), ssh: null, ufw: null, fail2ban: null, defenses: [] },
    };
    return { ok: status === 200, status, json: async () => data[url] ?? {} } as Response;
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('filters and sorts apps, shows empty states, and persists the chosen theme', async () => {
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  expect(screen.getAllByRole('article').map(card => within(card).getByRole('heading').textContent)).toEqual(['alpha', 'beta']);
  fireEvent.change(screen.getByLabelText('並べ替え'), { target: { value: 'memory' } });
  expect(within(screen.getAllByRole('article')[0]).getByRole('heading')).toHaveTextContent('beta');
  fireEvent.change(screen.getByLabelText('状態'), { target: { value: 'online' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' 3030 ' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '絞り込みを解除' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('表示テーマ'), { target: { value: 'dark' } });
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('dashboard-theme')).toBe('dark');
  expect(screen.getByText('稼働中のコンテナはありません。')).toBeInTheDocument();
});

test('requires confirmation, surfaces HTTP errors and closes the log stream with the dialog', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'alpha の詳細とログ' }));
  const dialog = screen.getByRole('dialog');
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(within(dialog).getByRole('button', { name: '停止' }));
  expect(global.fetch).not.toHaveBeenCalledWith('/api/apps/1/stop', expect.anything());
  confirm.mockReturnValue(true);
  fireEvent.click(within(dialog).getByRole('button', { name: '停止' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('HTTP 500');
  expect(global.fetch).toHaveBeenCalledWith('/api/apps/1/stop', expect.objectContaining({ method: 'POST' }));
  expect(within(dialog).queryByText(/完了しました/)).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: '詳細を閉じる' }));
  expect(streams[1].close).toHaveBeenCalled();
});

test('shows data errors without rendering error objects as apps, and handles session expiry', async () => {
  apiStatus = 500;
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  apiStatus = 200;
  fireEvent.click(screen.getByRole('button', { name: '再試行' }));
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  apiStatus = 401;
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  await screen.findByRole('link', { name: 'Googleでログイン' });
  await waitFor(() => expect(streams[0].close).toHaveBeenCalled());
});

const jsonResponse = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body } as Response);
const emit = (stream: typeof streams[number], type: string, data: unknown) => act(() => stream.listeners[type]({ data: JSON.stringify(data) } as MessageEvent));

test('pins persist, search shortcut works, and pausing polling keeps an open log stream', async () => {
  jest.useFakeTimers();
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  fireEvent.click(screen.getByRole('button', { name: 'beta をお気に入りに追加' }));
  expect(within(screen.getAllByRole('article')[0]).getByRole('heading')).toHaveTextContent('beta');
  expect(localStorage.getItem('dashboard-pins')).toContain('beta');
  fireEvent.click(screen.getByRole('button', { name: '管理アプリ' }));
  fireEvent.keyDown(window, { key: '/' });
  expect(screen.getByRole('searchbox')).toHaveFocus();
  expect(screen.getByRole('button', { name: '管理アプリ' })).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'alpha の詳細とログ' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '定期更新' }));
  const calls = (global.fetch as jest.Mock).mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(20000); });
  expect((global.fetch as jest.Mock).mock.calls.length).toBe(calls);
  expect(streams[1].close).not.toHaveBeenCalled();
  emit(streams[1], 'init', { out: '', err: '' });
  emit(streams[1], 'log', { type: 'out', line: 'first line\nneedle here\nlast line' });
  fireEvent.change(screen.getByLabelText('ログ内検索'), { target: { value: 'needle' } });
  expect(screen.getByText('needle here')).toBeInTheDocument();
  expect(screen.queryByText('first line')).not.toBeInTheDocument();
  emit(streams[1], 'log', { type: 'unexpected', line: 1 });
  expect(screen.getByText('ログの形式が不正です')).toBeInTheDocument();
  const create = jest.fn((_blob: Blob) => 'blob:test');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const download = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '表示ログを保存' }));
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(download).toHaveBeenCalledTimes(1);
});

test('an old poll cannot overwrite the fresh state after a confirmed PM2 action', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'alpha の詳細とログ' }));
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  const original = global.fetch;
  let resolveOld!: (response: Response) => void;
  let held = false;
  global.fetch = jest.fn((input, options) => {
    if (String(input) === '/api/apps') {
      if (!held) { held = true; return new Promise(resolve => { resolveOld = resolve; }); }
      return Promise.resolve(jsonResponse(processes.map(app => ({ ...app, status: 'stopped' }))));
    }
    if (options?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }));
    return original(input, options);
  });
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '再起動' }));
  await waitFor(() => expect(within(screen.getAllByRole('article')[0]).getByText('停止')).toBeInTheDocument());
  await act(async () => { resolveOld(jsonResponse(processes)); });
  expect(within(screen.getAllByRole('article')[0]).getByText('停止')).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith('/api/apps/1/restart', expect.objectContaining({ body: JSON.stringify({ expected: { name: 'alpha', path: '/apps/alpha' } }) }));
});

test('partial failures preserve apps; SSH snapshots cannot erase or duplicate newer events', async () => {
  const original = global.fetch;
  let resolveSSH!: (response: Response) => void;
  global.fetch = jest.fn((input, options) => {
    if (String(input) === '/api/info') return Promise.resolve(jsonResponse({}, 500));
    if (String(input) === '/api/ssh/logins') return new Promise(resolve => { resolveSSH = resolve; });
    return original(input, options);
  });
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  expect(screen.getByRole('alert')).toHaveTextContent('システム');
  const login = { id: 'cursor-1', time: new Date().toISOString(), ip: '192.168.1.1', user: 'test', device: 'Mac', location: null, org: '', isLocal: true, historical: false };
  emit(streams[0], 'sshlogin', login);
  emit(streams[0], 'sshlogin', { ...login, location: 'ローカルネットワーク' });
  await act(async () => { resolveSSH(jsonResponse([])); });
  expect(screen.getAllByText('Mac')).toHaveLength(1);
});

test('a late VS Code status read cannot hide a reconnect reported by the stop operation', async () => {
  const original = global.fetch;
  let statusCalls = 0;
  let resolveStatus!: (response: Response) => void;
  global.fetch = jest.fn((input, options) => {
    if (String(input) === '/api/vscode/status') {
      if (++statusCalls === 1) return Promise.resolve(jsonResponse({ running: true, processCount: 1 }));
      return new Promise(resolve => { resolveStatus = resolve; });
    }
    if (String(input) === '/api/vscode/kill') return Promise.resolve(jsonResponse({ ok: true, outcome: 'restarted', running: true, processCount: 2 }));
    return original(input, options);
  });
  render(<App />);
  await screen.findByRole('button', { name: 'VS Codeを停止' });
  await waitFor(() => expect(screen.queryByText('SSH: 読み込み中…')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'VS Codeを停止' }));
  await screen.findByText(/VS Codeの再起動を検知しました/);
  await act(async () => { resolveStatus(jsonResponse({ running: false, processCount: 0 })); });
  expect(screen.getByText(/VS Codeサーバー稼働中.*2 プロセス/)).toBeInTheDocument();
});

test('logout aborts manual refresh and ignores responses arriving after the session ended', async () => {
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  const original = global.fetch;
  let resolveApps!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((input, options) => {
    if (String(input) === '/api/apps') { signal = options?.signal as AbortSignal; return new Promise(resolve => { resolveApps = resolve; }); }
    if (String(input) === '/auth/logout') return Promise.resolve(jsonResponse({ success: true }));
    return original(input, options);
  });
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
  await screen.findByRole('link', { name: 'Googleでログイン' });
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolveApps(jsonResponse(processes)); });
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  expect(streams[0].close).toHaveBeenCalled();
});

const sections = ['アプリの状態集計', 'セキュリティ', 'サーバー情報', '管理アプリ', 'Dockerコンテナ', 'SSH / VS Code Remote', '検出されたプロジェクト'];

test('section menu toggles, closes on Escape or outside click, and returns focus', async () => {
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  const button = screen.getByRole('button', { name: 'セクションメニュー' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  fireEvent.click(button);
  const menu = screen.getByRole('navigation', { name: 'セクション一覧' });
  expect(button).toHaveAttribute('aria-controls', menu.id);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(within(menu).getAllByRole('button').map(item => item.textContent)).toEqual(sections);
  expect(within(menu).getAllByRole('button')[0]).toHaveFocus();
  fireEvent.click(button);
  expect(menu).not.toBeVisible();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(menu).not.toBeVisible();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('heading', { level: 1 }));
  expect(menu).not.toBeVisible();
  expect(button).toHaveFocus();
});

test('menu only lists rendered sections and updates when server info becomes available', async () => {
  const original = global.fetch;
  let missing = true;
  global.fetch = jest.fn((input, options) => String(input) === '/api/info' && missing
    ? Promise.resolve(jsonResponse({}, 500)) : original(input, options));
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  fireEvent.click(screen.getByRole('button', { name: 'セクションメニュー' }));
  const menu = screen.getByRole('navigation');
  expect(within(menu).queryByRole('button', { name: 'サーバー情報' })).not.toBeInTheDocument();
  expect(within(menu).getAllByRole('button')).toHaveLength(6);
  fireEvent.keyDown(menu, { key: 'Escape' });
  missing = false;
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  await screen.findByRole('heading', { name: /サーバー情報/ });
  fireEvent.click(screen.getByRole('button', { name: 'セクションメニュー' }));
  expect(within(menu).getAllByRole('button')).toHaveLength(7);
});

test.each([false, true])('navigation expands, scrolls and focuses every section (reduced motion: %s)', async reduced => {
  (window.matchMedia as jest.Mock).mockReturnValue({ matches: reduced });
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  const scroll = Element.prototype.scrollIntoView as jest.Mock;
  for (const name of sections) {
    const toggle = screen.getByRole('button', { name });
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    fireEvent.click(toggle);
    expect(body).not.toBeVisible();
    scroll.mockImplementation(function (this: HTMLElement) {
      expect(body).toBeVisible();
      expect(this).toBe(toggle.closest('h2'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'セクションメニュー' }));
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name }));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle.closest('h2')).toHaveFocus();
    expect(scroll).toHaveBeenLastCalledWith({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('dashboard-collapsed-sections')!)).toEqual([]);
  }
  expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
});

test('each section toggles aria-expanded and restores its saved collapsed state after remount', async () => {
  const { unmount } = render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  for (const name of sections) {
    const toggle = screen.getByRole('button', { name });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeVisible();
  }
  expect(JSON.parse(localStorage.getItem('dashboard-collapsed-sections')!)).toHaveLength(7);
  unmount();
  render(<App />);
  await screen.findByRole('button', { name: 'サーバー情報' });
  for (const name of sections) {
    const toggle = screen.getByRole('button', { name });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeVisible();
  }
  expect(JSON.parse(localStorage.getItem('dashboard-collapsed-sections')!)).toEqual([]);
});

test.each(['unavailable', 'invalid-json', 'invalid-shape'])('collapse works with %s storage', async mode => {
  if (mode === 'unavailable') {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  } else localStorage.setItem('dashboard-collapsed-sections', mode === 'invalid-json' ? '{' : 'null');
  render(<App />);
  const toggle = await screen.findByRole('button', { name: 'サーバー情報' });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('collapsed sections keep polling and reveal updated data when expanded', async () => {
  jest.useFakeTimers();
  render(<App />);
  await screen.findByRole('button', { name: 'alpha の詳細とログ' });
  for (const name of sections) fireEvent.click(screen.getByRole('button', { name }));
  const original = global.fetch;
  global.fetch = jest.fn((input, options) => String(input) === '/api/apps'
    ? Promise.resolve(jsonResponse([{ ...processes[0], name: 'updated' }])) : original(input, options));
  await act(async () => { jest.advanceTimersByTime(10000); });
  for (const url of ['/api/apps', '/api/info', '/api/scan', '/api/docker', '/api/ssh/logins', '/api/vscode/status']) {
    expect(global.fetch).toHaveBeenCalledWith(url, expect.anything());
  }
  await act(async () => { jest.advanceTimersByTime(290000); });
  expect(global.fetch).toHaveBeenCalledWith('/api/security', expect.anything());
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '管理アプリ' }));
  expect(screen.getByRole('button', { name: 'updated の詳細とログ' })).toBeVisible();
});
