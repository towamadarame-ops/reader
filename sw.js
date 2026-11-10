/*
 * ♡‧₊ ✧ ₊‧♡ - Service Worker
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
 *
 * 只管自己（v14 起）：
 *   GitHub Pages 上同一个账号的所有项目共用一个网址（xxx.github.io），浏览器把它们当成同一个网站，
 *   缓存是共享的。以前升级时「除了当前版本全删」，会把同网址下其它 App（比如私享衣橱）的
 *   离线缓存、分享暂存的图片一起删掉；部署在根目录时还会把别的 App 的页面当成自己的首页存起来。
 *   现在只删 peiban-reader- 开头的缓存，也只处理本目录下的文件，子目录里的其它 App 一律放行。
 *
 * 从文件管理器「分享」TXT（v15 起）：
 *   装到桌面后，文件管理器的分享菜单里会出现本 App。分享过来的文件以 POST 发到 share-target，
 *   这里接住、存进 SHARE_CACHE，再把页面打开成 ?share=1，由 index.html 的 takeSharedBooks() 取走导入。
 */

// 改动代码后请把这里的版本号 +1，可确保所有旧缓存被清掉
const SW_VERSION = 'v15';
const CACHE_PREFIX = 'peiban-reader-';          // index.html 的 ?reset=1 和 reset.html 也按这个前缀认
const CACHE_NAME = CACHE_PREFIX + SW_VERSION;
const SCOPE = self.registration.scope;          // 形如 https://xxx.github.io/reader/
const SCOPE_PATH = new URL(SCOPE).pathname;     // 形如 /reader/
// 下面两个名字必须跟 index.html 里 manifest 的 share_target.action、shareCacheName() 一致。
// 分享缓存也以 CACHE_PREFIX 开头（修复页能一并清掉），但升级清旧缓存时要跳过它，免得还没取走的书被删了。
const SHARE_PATH = SCOPE_PATH + 'share-target';
const SHARE_CACHE_PREFIX = CACHE_PREFIX + 'share|';
const SHARE_CACHE = SHARE_CACHE_PREFIX + SCOPE;

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
                keys.filter((key) => key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME
                        && key.indexOf(SHARE_CACHE_PREFIX) !== 0)
                    .map((key) => caches.delete(key))
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

    // 从文件管理器分享过来的 TXT
    if (req.method === 'POST') {
        let u;
        try { u = new URL(req.url); } catch (e) { return; }
        if (u.origin === self.location.origin && u.pathname === SHARE_PATH) {
            event.respondWith(receiveShare(req));
        }
        return;
    }
    if (req.method !== 'GET') return;

    // 跨域请求（AI 接口、字体等）一律放行，避免影响正常功能
    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.origin !== self.location.origin) return;

    // 只管本目录下的文件：不在作用域里、或在更深一层子目录里的（同网址下的其它 App）一律放行
    if (url.pathname.indexOf(SCOPE_PATH) !== 0) return;
    if (url.pathname.slice(SCOPE_PATH.length).indexOf('/') !== -1) return;

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

// 接住分享过来的文件。
// 这时页面还没打开，没法直接把文件交过去，所以先存进 SHARE_CACHE，再 303 跳到 ?share=1，页面启动后自己来取。
// 只留最新这一次分享：上次没取走的先清掉，免得哪天突然冒出一堆旧书。
async function receiveShare(req) {
    try {
        const form = await req.formData();
        const files = form.getAll('books').filter((f) => f && typeof f === 'object' && f.size);
        await caches.delete(SHARE_CACHE);
        if (files.length) {
            const cache = await caches.open(SHARE_CACHE);
            const stamp = Date.now();
            await Promise.all(files.map((f, i) => cache.put(
                SCOPE + '__share__/' + stamp + '-' + String(i).padStart(3, '0'),
                new Response(f, {
                    headers: {
                        // 有的文件管理器给的文件不带类型，到这里会变成 application/octet-stream。
                        // 分享菜单本来只对文本文件显示本 App，能走到这里的基本都是 TXT，按纯文本处理
                        'Content-Type': (!f.type || f.type === 'application/octet-stream') ? 'text/plain' : f.type,
                        'X-File-Name': encodeURIComponent(f.name || '')
                    }
                })
            )));
        }
    } catch (err) {
        // 收不到就当没分享，页面照常打开，那边会提示「没收到分享过来的文件」
    }
    return Response.redirect(SCOPE + '?share=1', 303);
}
