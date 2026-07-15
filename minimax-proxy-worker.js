/*
 * 通用 CORS 反向代理 —— 用于「陪伴阅读」的 MiniMax TTS 直连被浏览器跨域(CORS)拦截时。
 *
 * 【部署步骤（约 3 分钟，免费）】
 * 1. 打开 https://dash.cloudflare.com/ ，登录（没有账号先免费注册）。
 * 2. 左侧菜单：Workers & Pages → Create（创建）→ Create Worker（创建 Worker）。
 * 3. 给它起个名字，点 Deploy（部署）。
 * 4. 点 "Edit code / 编辑代码"，把本文件的全部内容粘贴进去，替换默认代码，再点 Deploy。
 * 5. 复制它的访问网址（形如 https://your-worker-name.your-subdomain.workers.dev ）。
 * 6. 回到阅读器：设置 → 语音朗读 → 打开「启用 CORS 反代」开关，把上面的网址填进「反代地址」。
 *
 * 说明：
 * - 这是一个「通用」代理：真正要访问的目标地址由前端通过 ?url= 参数传入，代理原样转发并补上 CORS 头。
 * - 你的 API Key 会经过这个（你自己的）Worker 转发；因为 Worker 属于你自己的账号，相对安全。
 * - 如担心被他人滥用，可在下方 ALLOW_ORIGINS 里填上你的 GitHub Pages 域名做来源限制。
 */

// 允许的来源（留空数组表示允许任意来源）。例如：['https://yourname.github.io']
const ALLOW_ORIGINS = [];

// 仅允许转发到这些主机，防止代理被拿去转发任意站点
const ALLOW_HOSTS = [
  'api.minimaxi.com',
  'api-bj.minimaxi.com',
  'api.minimax.chat',
  'api.minimaxi.chat',
];

function corsHeaders(origin) {
  const allowOrigin = (ALLOW_ORIGINS.length === 0 || ALLOW_ORIGINS.includes(origin)) ? (origin || '*') : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: cors });
    }

    let targetUrl;
    try {
      targetUrl = new URL(decodeURIComponent(target));
    } catch (e) {
      return new Response('Invalid url', { status: 400, headers: cors });
    }

    if (!ALLOW_HOSTS.includes(targetUrl.hostname)) {
      return new Response('Host not allowed', { status: 403, headers: cors });
    }

    // 组装转发请求：保留 Authorization / Content-Type，去掉可能引发问题的头
    const fwdHeaders = new Headers();
    const auth = request.headers.get('Authorization');
    const ctype = request.headers.get('Content-Type');
    if (auth) fwdHeaders.set('Authorization', auth);
    if (ctype) fwdHeaders.set('Content-Type', ctype);

    const init = {
      method: request.method,
      headers: fwdHeaders,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : await request.arrayBuffer(),
    };

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: cors });
    }

    const respHeaders = new Headers(upstream.headers);
    Object.entries(cors).forEach(([k, v]) => respHeaders.set(k, v));
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  },
};
