import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import SecurityPanel, { SecuritySummary } from './SecurityPanel';

const fullData = (): SecuritySummary => ({
  generatedAt: '2026-11-10T01:00:00Z',
  ssh: {
    windows: { '1h': { failed: 12, uniqueIps: 3, accepted: 1 }, '24h': { failed: 240, uniqueIps: 24, accepted: 1 }, '7d': { failed: 1700, uniqueIps: 70, accepted: 5 } },
    topIps24h: [{ ip: '203.0.113.1', count: 120, location: '日本', org: 'Example Network', isLocal: false }, { ip: '2001:db8::1', count: 60, location: null, org: '', isLocal: false }],
    topUsers24h: [{ user: 'root', count: 100 }],
    accepted24h: [{ time: '2026-11-10T00:30:00Z', method: 'publickey', user: 'owner', ip: '192.168.1.5' }],
  },
  ufw: { blocked24h: 500, topPorts: [], topSources: [] },
  fail2ban: { active: true, currentlyBanned: 4, totalBanned: 800, currentlyFailed: 2 },
  defenses: [{ name: 'SSHパスワードログイン無効', ok: true, detail: '鍵による認証のみ許可' }],
});

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('renders full security data with counts, origins, defenses and verifiable successful logins', async () => {
  const request = jest.fn().mockResolvedValue(fullData());
  render(<SecurityPanel request={request} autoRefresh />);
  expect(await screen.findByText('攻撃を検知しています。取得時点の防御はすべて有効です。')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith('/api/security', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  for (const [label, value] of [['SSH失敗 1h', '12'], ['SSH失敗 24h', '240'], ['SSH失敗 7d', '1,700'], ['ufw遮断 (24h)', '500'], ['fail2ban BAN累計', '800'], ['fail2ban BAN現在', '4']]) {
    expect(screen.getByText(label).nextElementSibling).toHaveTextContent(value);
  }
  expect(screen.getByText('ユニークIP：24')).toBeInTheDocument();
  const origins = within(screen.getByRole('region', { name: 'どこから来ているか' }));
  expect(origins.getByText('日本 · Example Network')).toBeInTheDocument();
  expect(origins.getByText('所在地不明 · 組織不明')).toBeInTheDocument();
  expect(origins.getByText('120件')).toBeInTheDocument();
  expect(screen.getByText('root')).toBeInTheDocument();
  expect(screen.getByLabelText('SSHパスワードログイン無効：正常')).toHaveTextContent('OK');
  expect(screen.getByText('鍵による認証のみ許可')).toBeInTheDocument();
  const logins = within(screen.getByRole('region', { name: '最近の成功ログイン' }));
  expect(logins.getByText(/過去24時間・最新100件/)).toBeInTheDocument();
  expect(logins.getByText('owner')).toBeInTheDocument();
  expect(logins.getByText('192.168.1.5')).toBeInTheDocument();
  expect(logins.getByText(/publickey/)).toBeInTheDocument();
  expect(screen.getByText(/最終更新/).querySelector('time')).toHaveAttribute('dateTime', fullData().generatedAt);
  expect(screen.getByText(/ユーザー名だけでは本人と断定できません/)).toBeInTheDocument();
});

test('renders null sections without claiming safety', async () => {
  render(<SecurityPanel request={jest.fn().mockResolvedValue({ ...fullData(), ssh: null, ufw: null, fail2ban: null, defenses: null })} autoRefresh />);
  expect(await screen.findByText(/要確認：SSH情報を取得できませんでした/)).toBeInTheDocument();
  for (const name of ['どこから来ているか', '狙われたユーザー名', 'どう防げているか', '最近の成功ログイン']) {
    expect(within(screen.getByRole('region', { name })).getByText('取得できませんでした')).toBeInTheDocument();
  }
  expect(screen.queryByText(/防御はすべて有効です/)).not.toBeInTheDocument();
});

test('switches the verdict to a named warning when a defense becomes unhealthy', async () => {
  const data = fullData();
  const request = jest.fn().mockResolvedValueOnce(data).mockResolvedValue({ ...data, defenses: [{ ...data.defenses![0], ok: false }] });
  render(<SecurityPanel request={request} autoRefresh />);
  await screen.findByText(/取得時点の防御はすべて有効です/);
  fireEvent.click(screen.getByRole('button', { name: 'セキュリティを更新' }));
  expect(await screen.findByText('要確認：SSHパスワードログイン無効が要確認')).toBeInTheDocument();
  expect(screen.getByLabelText('SSHパスワードログイン無効：要確認')).toHaveTextContent('NG');
  expect(screen.queryByText(/防御はすべて有効です/)).not.toBeInTheDocument();
});

test.each(['ssh', 'ufw', 'fail2ban', 'defenses'] as const)('warns if only %s is missing', async section => {
  render(<SecurityPanel request={jest.fn().mockResolvedValue({ ...fullData(), [section]: null })} autoRefresh />);
  await screen.findByText(/要確認：/);
  expect(screen.queryByText(/防御はすべて有効です/)).not.toBeInTheDocument();
});

test('warns about mixed login users, truncated logins and inactive fail2ban', async () => {
  const data = fullData();
  data.ssh!.accepted24h.push({ ...data.ssh!.accepted24h[0], user: 'stranger' });
  data.ssh!.windows['24h'].accepted = 30;
  data.fail2ban!.active = false;
  render(<SecurityPanel request={jest.fn().mockResolvedValue(data)} autoRefresh />);
  const verdict = await screen.findByText(/要確認：/);
  expect(verdict).toHaveTextContent('複数ユーザーの成功ログイン（owner、stranger）');
  expect(verdict).toHaveTextContent('成功ログインの全件を確認できません');
  expect(verdict).toHaveTextContent('fail2banが稼働していません');
});

test('refreshes every five minutes, pauses when hidden or disabled, and supports manual refresh', async () => {
  jest.useFakeTimers();
  const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const request = jest.fn().mockResolvedValue(fullData());
  const { rerender, unmount } = render(<SecurityPanel request={request} autoRefresh />);
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(299999); });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(request).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => { jest.advanceTimersByTime(600000); });
  expect(request).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(false);
  await act(async () => { fireEvent(document, new Event('visibilitychange')); });
  expect(request).toHaveBeenCalledTimes(3);
  rerender(<SecurityPanel request={request} autoRefresh={false} />);
  await act(async () => { jest.advanceTimersByTime(600000); fireEvent(document, new Event('visibilitychange')); });
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'セキュリティを更新' })); });
  expect(request).toHaveBeenCalledTimes(4);
  unmount();
  await act(async () => { jest.advanceTimersByTime(600000); });
  expect(request).toHaveBeenCalledTimes(4);
});

test('a failed refresh warns and explicitly labels retained data as old', async () => {
  const request = jest.fn().mockResolvedValueOnce(fullData()).mockRejectedValue(new Error('HTTP 500'));
  render(<SecurityPanel request={request} autoRefresh />);
  await screen.findByText(/取得時点の防御はすべて有効です/);
  fireEvent.click(screen.getByRole('button', { name: 'セキュリティを更新' }));
  expect(await screen.findByText(/要確認：最新情報を取得できませんでした/)).toHaveTextContent('HTTP 500');
  expect(screen.getByText(/前回取得時の情報を表示しています/)).toBeInTheDocument();
  expect(screen.queryByText(/防御はすべて有効です/)).not.toBeInTheDocument();
});
