/*
 * 陪伴阅读 - Service Worker
 * 作用：缓存 App 外壳，实现离线可用，并让站点满足「可安装 PWA」的条件。
 * 提示：Service Worker 只能在 http(s) 或 localhost 下生效，file:// 直接打开无法注册。
 *
 * 旧版本的问题（会导致手机一直打开旧界面、改了代码也不生效）：
 *   1) 除导航请求外一律「缓存优先且永不更新」，localforage.min.js 等资源一旦缓存就锁死；
 *   2) 缓存名固定为 v1，发新版时旧缓存不会被判定为过期；
 *   3) 导航请求虽然是网络优先，但 fetch 默认会走浏览器 HTTP 缓存，仍可能拿到旧的 index.html。
 * 现在的策略：
 *   - HTML（导航）：强制绕过 HTTP 缓存取新版，只有断网时才回退缓存；
 *   - 同源静态资源：先给缓存（快），同时后台静默更新（下次就是新的）；
 *   - 跨域请求（AI 接口等）：完全不拦截。
 */

// 改动代码后请把这里的版本号 +1，可确保所有旧缓存被清掉
const SW_VERSION = 'v7';
const CACHE_NAME = 'peiban-reader-' + SW_VERSION;

// 需要预缓存的 App 外壳资源（单个失败不影响整体安装）
const APP_SHELL = [
    './',
    './index.html',
    './localforage.min.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(
                APP_SHELL.map((url) =>
                    cache.add(new Request(url, { cache: 'reload' }))
                        .catch((err) => console.warn('[SW] 预缓存失败:', url, err))
                )
            )
        )
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// 允许页面主动要求跳过等待（配合页面里的「发现新版本」逻辑）
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    if (req.method !== 'GET') return;

    // 跨域请求（AI 接口、字体等）一律放行，避免影响正常功能
    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.origin !== self.location.origin) return;

    // 修复页永不拦截：它是把用户从"旧缓存打不开新版本"的死循环里救出来的唯一通道，
    // 必须保证任何情况下都直接走网络拿最新文件。
    if (/\/reset\.html$/i.test(url.pathname)) return;

    // 带 __fresh / __probe 参数的请求也直接放行（修复页与诊断专用）
    if (url.search.indexOf('__fresh=') !== -1 || url.search.indexOf('__probe=') !== -1) return;

    // 页面导航 / HTML：始终取最新，绕过 HTTP 缓存；只有断网时才用缓存兜底
    const isHTML = req.mode === 'navigate' ||
        (req.headers.get('accept') || '').includes('text/html');

    if (isHTML) {
        event.respondWith(
            fetch(new Request(req.url, {
                cache: 'no-store',
                credentials: 'same-origin',
                redirect: 'follow'
            }))
                .then((res) => {
                    if (res && res.ok) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME)
                            .then((cache) => cache.put('./index.html', copy))
                            .catch(() => {});
                    }
                    return res;
                })
                .catch(() =>
                    caches.match('./index.html').then((r) => r || caches.match('./'))
                )
        );
        return;
    }

    // 其它同源资源：先用缓存保证秒开，同时后台拉新版写回缓存
    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req)
                .then((res) => {
                    if (res && res.ok) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
                    }
                    return res;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
