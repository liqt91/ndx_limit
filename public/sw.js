/**
 * Service Worker：离线兜底 + 静态资源缓存。
 *
 * 策略：
 *   · 页面导航 → 网络优先，失败回落缓存。数据每天变，宁可慢一点也不给旧数据
 *     （只有断网时才用缓存，并标注是缓存）。
 *   · 静态资源 → 缓存优先。带 hash 的文件改了名字，不会拿到旧的。
 *
 * 缓存名带版本号：改完 sw.js 记得把 VER 往上加一位，否则老缓存不会失效。
 */
const VER = 'qdii-v3';
const CACHE = `${VER}`;
// 预缓存的是 /ndx100/ 而不是 /：根路径现在只是个跳转垫片，
// 断网时回落到它会拿到一页「正在前往」，等于没有内容。
const PRECACHE = ['/ndx100/', '/favicon.svg', '/og.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/ndx100/')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
