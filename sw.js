// Glockys Prop Grader service worker: ONLY shows push notifications (new lines, new grades, support replies).
// No fetch handler and no caching, so it never changes how the site loads.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || 'Glockys Prop Grader';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: '/assets/icon-192.png', badge: '/assets/icon-192.png', data: { url: d.url || '/' }
  }).then(function () {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      cs.forEach(function (c) { c.postMessage({ gpPush: d }); });
    });
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) { if (cs[i].url.indexOf(self.location.origin) === 0 && 'focus' in cs[i]) { cs[i].navigate(url).catch(function () {}); return cs[i].focus(); } }
    return self.clients.openWindow(url);
  }));
});
