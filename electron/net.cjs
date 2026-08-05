'use strict';

/**
 * 主进程网络通道。
 *
 * 为什么不让渲染层自己 fetch：
 *   1) 直连 api.bgm.tv 在浏览器里会被 CORS 拦掉；
 *   2) 用 Chromium 的 net 栈发请求，会自动跟随系统代理 —— 也就是说
 *      用户开了 VPN / 系统代理，这里跟着走，不用改一行代码；
 *      需要单独指定代理时再用 session.setProxy 覆盖。
 *
 * 安全边界：只放行 https；http 仅允许本机（给自建反代留口子）。
 */

const { net, session } = require('electron');

/** 把 Chromium 的错误码翻成人话，否则用户只会看到一长串 ERR_ */
function friendlyError(err) {
  const raw = String(err?.message ?? err ?? '未知错误');
  const table = [
    [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/i, '域名解析失败（没网，或者这个域名被拦了）'],
    [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/i, '连接超时（网络不通，或被墙 / 需要开代理）'],
    [/ERR_CONNECTION_REFUSED/i, '连接被拒绝（地址或端口不对，反代没起来？）'],
    [/ERR_INTERNET_DISCONNECTED/i, '当前没有网络连接'],
    [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/i, '连接被中断（可能是代理或中间设备掐断的）'],
    [/ERR_CERT|ERR_SSL/i, '证书校验失败（如果用的是自建反代，检查一下证书）'],
    [/ERR_PROXY_CONNECTION_FAILED/i, '代理连不上：填的代理地址可能没在跑'],
    [/ERR_TOO_MANY_REDIRECTS/i, '重定向次数过多'],
    [/ERR_BLOCKED_BY_CLIENT/i, '请求被拦截'],
  ];
  for (const [re, msg] of table) if (re.test(raw)) return msg;
  return raw.replace(/^net::/, '');
}

function isAllowedUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return false;
  } catch {
    return false;
  }
}

/** 最近一次设过的代理规则，值没变就不重复调 setProxy */
let lastProxy = '__unset__';

/**
 * 配置会话代理。
 *   ''        → 跟随系统（Windows 的系统代理 / VPN 就靠这条生效）
 *   'http://127.0.0.1:7890' → 走指定代理
 */
async function applyProxy(proxy) {
  const rules = String(proxy ?? '').trim();
  if (rules === lastProxy) return { applied: false, rules };
  try {
    if (!rules) {
      await session.defaultSession.setProxy({ mode: 'system' });
    } else {
      await session.defaultSession.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    }
    lastProxy = rules;
    return { applied: true, rules };
  } catch (err) {
    lastProxy = rules;
    return { applied: false, rules, error: err?.message ?? String(err) };
  }
}

/**
 * 发一个 GET 并解析 JSON。永远 resolve，不 reject —— 调用方拿到的是
 * { ok, status, data|error }，免得每个 IPC 都要包 try/catch。
 */
function fetchJson({ url, timeoutMs = 12000, headers } = {}) {
  return new Promise((resolve) => {
    if (!isAllowedUrl(url)) {
      resolve({ ok: false, status: 0, error: '这个地址不被允许（只支持 https，或本机 http）' });
      return;
    }

    let settled = false;
    const finish = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };

    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (err) {
      finish({ ok: false, status: 0, error: friendlyError(err) });
      return;
    }

    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* 已经结束了 */ }
      finish({ ok: false, status: 0, error: `请求超时（${Math.round(timeoutMs / 1000)}s）` });
    }, Math.max(1000, timeoutMs));

    try {
      req.setHeader('Accept', 'application/json, text/plain, */*');
      req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9');
      req.setHeader('User-Agent', `jikai/${require('../package.json').version} (Electron)`);
      for (const [k, v] of Object.entries(headers ?? {})) {
        if (v == null) continue;
        try { req.setHeader(k, String(v)); } catch { /* 非法头名，忽略 */ }
      }
    } catch { /* setHeader 失败不致命 */ }

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish({
            ok: false,
            status: res.statusCode,
            error: `HTTP ${res.statusCode}${body ? ` · ${body.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`,
          });
          return;
        }
        try {
          finish({ ok: true, status: res.statusCode, data: JSON.parse(body) });
        } catch {
          finish({ ok: false, status: res.statusCode, error: '返回的不是合法 JSON（是不是反代返回了 HTML？）' });
        }
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, status: 0, error: friendlyError(err) });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, status: 0, error: friendlyError(err) });
    });

    try { req.end(); } catch (err) { clearTimeout(timer); finish({ ok: false, status: 0, error: friendlyError(err) }); }
  });
}

module.exports = { fetchJson, applyProxy, friendlyError, isAllowedUrl };
