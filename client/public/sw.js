// Notifications only: never cache HTML, authenticated API responses or build assets.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json(); } catch { data = { body: event.data?.text() }; }
  if (typeof data === 'string') data = { body: data };
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  event.waitUntil(self.registration.showNotification(typeof data.title === 'string' ? data.title : 'サーバー通知', {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/logo192.png', badge: '/logo192.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    requireInteraction: data.requireInteraction === true,
    actions: Array.isArray(data.actions) ? data.actions.filter(action => action && typeof action.action === 'string' && typeof action.title === 'string').slice(0, 2) : [],
    data: data.data && typeof data.data === 'object' ? data.data : {},
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const action = event.action || '';
  // Accept the previous action format until already-delivered notifications expire.
  const legacyToken = /^kill_vscode:([a-f0-9]{48})$/.exec(action)?.[1];
  if (action === 'kill_vscode' || legacyToken) {
    event.waitUntil((async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let title, body;
      try {
        const token = event.notification.data?.killToken || legacyToken;
        const response = await fetch('/api/vscode/kill', {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        });
        if (!response.ok) throw new Error(response.status === 401 ? '停止リンクが期限切れか使用済みです。ダッシュボードで再操作してください。' : response.status === 409 ? '別の停止操作が進行中です。状態を確認してください。' : '停止または状態確認に失敗しました。ダッシュボードで確認してください。');
        const result = await response.json();
        if (result.ok !== true) throw new Error('停止結果を確認できませんでした。');
        const messages = {
          stopped: ['VS Code停止を確認', '2秒間の確認では停止しています。接続元の自動再接続で再起動する場合があります。'],
          'already-stopped': ['VS Codeは停止済み', '停止対象のプロセスはありませんでした。'],
          restarted: ['VS Codeの再起動を検知', '停止要求後に新しいプロセスを検知しました。接続元の自動再接続を止めてください。'],
          'still-running': ['VS Codeがまだ稼働中', '停止要求後もプロセスが残っています。ダッシュボードで確認してください。'],
        };
        [title, body] = messages[result.outcome] || ['VS Code停止要求を送信', '結果をダッシュボードで確認してください。'];
      } catch (error) {
        title = 'VS Code停止を確認できません';
        body = error.name === 'AbortError' ? '応答がありません。停止済みの可能性もあるため、状態を確認してください。' : error.message;
      } finally { clearTimeout(timeout); }
      await self.registration.showNotification(title, { body, icon: '/logo192.png', badge: '/logo192.png', tag: 'vscode-stop-result' });
    })());
    return;
  }
  if (action === 'dismiss') return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const dashboard = windows.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === '/');
    if (dashboard) { try { return await dashboard.focus(); } catch { /* Fall back to a new window. */ } }
    return self.clients.openWindow('/');
  })());
});
