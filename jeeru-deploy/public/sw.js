// Jeeru service worker — only job is push notifications.
// (No offline caching here on purpose: this is a live two-person chat,
// stale cached HTML would be actively confusing.)

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignore */ }

  const title = data.title || 'Jeeru';
  const body = data.body || 'Naya message aaya hai';

  event.waitUntil((async () => {
    // If the app is already open and focused, let the page show its own
    // in-app banner instead of a duplicate OS notification.
    const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    const visibleClient = allClients.find(c => c.visibilityState === 'visible' && c.focused);

    if (visibleClient) {
      visibleClient.postMessage({ type: 'jeeru-push', title, body });
      return;
    }

    await self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'jeeru-message',
      renotify: true,
      data: { url: '/' }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
