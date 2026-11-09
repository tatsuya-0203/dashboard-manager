import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface SecuritySummary {
  generatedAt: string;
  ssh: null | {
    windows: Record<'1h' | '24h' | '7d', { failed: number; uniqueIps: number; accepted: number }>;
    topIps24h: { ip: string; count: number; location: string | null; org: string; isLocal: boolean }[];
    topUsers24h: { user: string; count: number }[];
    accepted24h: { time: string; method: string; user: string; ip: string }[];
  };
  ufw: null | { blocked24h: number; topPorts: { port: string; count: number }[]; topSources: { ip: string; count: number }[] };
  fail2ban: null | { active: boolean; currentlyBanned: number | null; totalBanned: number | null; currentlyFailed: number | null };
  defenses: { name: string; ok: boolean; detail: string }[] | null;
}

const unavailable = '取得できませんでした';
const windows = ['1h', '24h', '7d'] as const;
const count = (value: number | null | undefined) => value == null ? unavailable : value.toLocaleString('ja-JP');

export default function SecurityPanel({ request, autoRefresh }: {
  request: (url: string, options?: RequestInit) => Promise<any>;
  autoRefresh: boolean;
}) {
  const [data, setData] = useState<SecuritySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const attempted = useRef(false);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    attempted.current = true;
    setLoading(true);
    try {
      const next: SecuritySummary = await request('/api/security', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!next || !Number.isFinite(Date.parse(next.generatedAt)) ||
          (next.defenses != null && (!Array.isArray(next.defenses) || next.defenses.some(item => typeof item.name !== 'string' || typeof item.ok !== 'boolean' || typeof item.detail !== 'string'))) ||
          (next.ssh != null && (!windows.every(key => next.ssh?.windows?.[key] && ['failed', 'uniqueIps', 'accepted'].every(field => {
            const value = next.ssh!.windows[key][field as 'failed' | 'uniqueIps' | 'accepted'];
            return Number.isSafeInteger(value) && value >= 0;
          })) ||
            !Array.isArray(next.ssh.topIps24h) || !Array.isArray(next.ssh.topUsers24h) || !Array.isArray(next.ssh.accepted24h)))) {
        throw new Error('セキュリティ情報の形式が不正です。');
      }
      setData(next); setError('');
    } catch (error) {
      if (!controller.signal.aborted && (error as Error).name !== 'AbortError') setError((error as Error).message);
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [request]);

  useEffect(() => {
    const visible = () => {
      if (!document.hidden && (autoRefresh || !attempted.current)) refresh();
      if (document.hidden) {
        pending.current?.abort(); pending.current = null; setLoading(false);
      }
    };
    visible();
    const interval = autoRefresh ? window.setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60 * 1000) : undefined;
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      pending.current?.abort(); pending.current = null;
      setLoading(false);
    };
  }, [autoRefresh, refresh]);

  const ssh = data?.ssh, ufw = data?.ufw, fail2ban = data?.fail2ban;
  const defenses = data?.defenses;
  const problems: string[] = [];
  if (error) problems.push(`最新情報を${unavailable}（${error}）`);
  if (!ssh) problems.push(`SSH情報を${unavailable}`);
  if (!ufw || !Number.isSafeInteger(ufw.blocked24h)) problems.push(`ufw情報を${unavailable}`);
  if (!fail2ban) problems.push(`fail2ban情報を${unavailable}`);
  else {
    if (!fail2ban.active) problems.push('fail2banが稼働していません');
    if ([fail2ban.currentlyBanned, fail2ban.totalBanned, fail2ban.currentlyFailed].some(value => !Number.isSafeInteger(value))) problems.push(`fail2banの集計を${unavailable}`);
  }
  if (!defenses?.length) problems.push(`防御情報を${unavailable}`);
  defenses?.filter(defense => !defense.ok).forEach(defense => problems.push(`${defense.name}が要確認`));
  // ponytail: same usernames are only a heuristic; verified ownership needs server-provided owner/key identities.
  const loginUsers = Array.from(new Set(ssh?.accepted24h.map(login => login.user)));
  if (loginUsers.length > 1) problems.push(`複数ユーザーの成功ログイン（${loginUsers.join('、')}）`);
  if (loginUsers.some(user => !user)) problems.push('成功ログインのユーザー名が不明です');
  if (ssh && ssh.windows['24h'].accepted !== ssh.accepted24h.length) problems.push('成功ログインの全件を確認できません（一覧は最大100件）');
  const attacks = (ssh?.windows['24h'].failed ?? 0) + (ufw?.blocked24h ?? 0);
  const maxAttacks = Math.max(1, ...(ssh?.topIps24h.map(entry => entry.count) ?? []));

  return (
    <section className="security-panel" aria-labelledby="security-title">
      <div className="section-header">
        <h2 id="security-title">セキュリティ</h2>
        <button onClick={refresh} disabled={loading} aria-label="セキュリティを更新">{loading ? '更新中…' : 'セキュリティを更新'}</button>
      </div>
      <div className={`security-verdict ${problems.length ? 'warning' : 'ok'}`} role="status">
        <strong>{!data && !error ? 'セキュリティ情報を読み込み中…' : problems.length ? `要確認：${problems.join(' / ')}` : attacks ? '攻撃を検知しています。取得時点の防御はすべて有効です。' : '過去24時間に攻撃の記録はなく、取得時点の防御はすべて有効です。'}</strong>
        {data && <p>取得できた記録・設定に基づく判定です。{loginUsers.length === 1 ? `成功ログインは同じユーザー（${loginUsers[0]}）ですが、` : ''}ユーザー名だけでは本人と断定できません。下の成功ログインを確認してください。</p>}
      </div>
      <p className="update-status">最終更新：{data ? <time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleString('ja-JP')}</time> : '未取得'} · {autoRefresh ? '5分ごとに更新（タブ非表示時は休止）' : '定期更新を停止中'}{error && data && ' · 前回取得時の情報を表示しています'}</p>
      <dl className="security-stats">
        {windows.map(window => <div className="info-card" key={window}><dt>SSH失敗 {window}</dt><dd>{count(ssh?.windows[window].failed)}<small className="muted">ユニークIP：{count(ssh?.windows[window].uniqueIps)}</small></dd></div>)}
        <div className="info-card"><dt>ufw遮断 (24h)</dt><dd>{count(ufw?.blocked24h)}</dd></div>
        <div className="info-card"><dt>fail2ban BAN累計</dt><dd>{count(fail2ban?.totalBanned)}</dd></div>
        <div className="info-card"><dt>fail2ban BAN現在</dt><dd>{count(fail2ban?.currentlyBanned)}</dd></div>
      </dl>
      <div className="security-details">
        <section className="info-card" aria-labelledby="security-origins">
          <h3 id="security-origins">どこから来ているか</h3>
          <p>SSH失敗の上位IP（24時間）</p>
          {!ssh ? <p>{unavailable}</p> : !ssh.topIps24h.length ? <p>攻撃元の記録はありません。</p> : <ul className="security-list">{ssh.topIps24h.map(entry => <li key={entry.ip}>
            <div className="security-row"><code>{entry.ip}</code><strong>{count(entry.count)}件</strong></div>
            <p>{entry.location || (entry.isLocal ? 'ローカルネットワーク' : '所在地不明')} · {entry.org || '組織不明'}</p>
            <div className="bar-container" aria-hidden="true"><div className="bar" style={{ width: `${entry.count / maxAttacks * 100}%`, background: 'var(--accent)' }} /></div>
          </li>)}</ul>}
        </section>
        <section className="info-card" aria-labelledby="security-users">
          <h3 id="security-users">狙われたユーザー名</h3><p>SSH失敗の上位ユーザー（24時間）</p>
          {!ssh ? <p>{unavailable}</p> : !ssh.topUsers24h.length ? <p>狙われたユーザー名の記録はありません。</p> : <ul className="security-list">{ssh.topUsers24h.map(entry => <li className="security-row" key={entry.user}><code>{entry.user}</code><strong>{count(entry.count)}件</strong></li>)}</ul>}
        </section>
        <section className="info-card" aria-labelledby="security-defenses">
          <h3 id="security-defenses">どう防げているか</h3>
          {!defenses?.length ? <p>{unavailable}</p> : <ul className="security-list">{defenses.map(defense => <li key={defense.name}>
            <div className="security-row"><strong>{defense.name}</strong><span className={`status-badge ${defense.ok ? 'online' : 'errored'}`} aria-label={`${defense.name}：${defense.ok ? '正常' : '要確認'}`}>{defense.ok ? 'OK' : 'NG'}</span></div>
            <p>{defense.detail}</p>
          </li>)}</ul>}
        </section>
        <section className="info-card" aria-labelledby="security-logins">
          <h3 id="security-logins">最近の成功ログイン</h3><p>過去24時間・最新20件。すべて自分のログインか確認してください。</p>
          {!ssh ? <p>{unavailable}</p> : !ssh.accepted24h.length ? <p>成功ログインの記録はありません。</p> : <ul className="security-list">{ssh.accepted24h.map((login, index) => <li key={`${login.time}-${index}`}>
            <div className="security-row"><strong>{login.user}</strong><time dateTime={login.time}>{new Date(login.time).toLocaleString('ja-JP')}</time></div>
            <p>接続元：<code>{login.ip}</code> · 認証方式：{login.method}</p>
          </li>)}</ul>}
        </section>
      </div>
    </section>
  );
}
