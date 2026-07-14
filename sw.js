/*
 * 陪伴阅读 - Service Worker
 * 作用：缓存 App 外壳，实现离线可用，并让站点满足「可安装 PWA」的条件。
 * 提示：Service Worker 只能在 http(s) 或 localhost 下生效，file:// 直接打开无法注册。
 */
const CACHE_NAME = 'peiban-reader-v1';

// 需要预缓存的 App 外壳资源
const APP_SHELL = [
    './',
    './index.html',
    'https://unpkg.com/localforage@1.10.0/dist/localforage.min.js'
];

// 安装：逐个预缓存（单个失败不影响整体安装）
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(
                APP_SHELL.map((url) =>
                    cache.add(url).catch((err) => console.warn('[SW] 预缓存失败:', url, err))
                )
            )
        )
    );
});

// 激活：清理旧版本缓存并立即接管页面
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) =>
                Promise.all(
                    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // 只处理 GET 请求
    if (req.method !== 'GET') return;

    // 页面导航：网络优先，失败时回退到缓存的首页（保证离线可打开）
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => {});
                    return res;
                })
                .catch(() =>
                    caches.match('./index.html').then((r) => r || caches.match('./'))
                )
        );
        return;
    }

    // 其它资源：缓存优先，未命中则请求网络并写入缓存
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
                    return res;
                })
                .catch(() => cached);
        })
    );
});
