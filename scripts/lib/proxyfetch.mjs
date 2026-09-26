/**
 * 零依赖的 HTTP 客户端（支持走本地 HTTP 代理）。
 *
 * 为什么不用现成的：node 22 的内置 fetch 不吃系统代理，undici 的 ProxyAgent
 * 又要装包。而这里只想干一件事 —— 在命令行里验证 api.bgm.tv 通不通、
 * 返回的东西解析对不对。所以直接用 node:http 手写 CONNECT 隧道。
 *
 * 浏览器 / Electron 那一侧走的是各自的通道（系统代理自动生效），用不到这个。
 * 这个文件只服务于「离线在命令行里做真实网络验证」这一个场景。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** 常见本地代理端口。VPN 客户端（Clash / mihomo / v2rayN 之类）基本都在这里面。 */
export const PROXY_CANDIDATES = [
  7890, 7891, 7892, 7897, 2080, 1080, 1081, 10808, 10809, 8889, 8118, 8080,
];

/** 从环境变量取代理配置，形如 http://127.0.0.1:7890 或 127.0.0.1:7890 */
export function proxyFromEnv(env = process.env) {
  const raw = env.JIKAI_PROXY || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return null;
  const m = String(raw).trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  const [host, port] = m.split(':');
  if (!host || !port) return null;
  return { host, port: Number(port), from: 'env' };
}

/**
 * 走 CONNECT 隧道连到目标主机，拿到一条裸 socket。
 *
 * 导出是为了给 poolfetch.mjs 复用 —— 那边要在一条连接上连发多个请求
 * （全量抓取时每请求重建隧道太贵，而且并发一高代理侧就会断 TLS）。
 */
export function tunnel(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      fn(v);
    };
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(reject, new Error(`代理拒绝 CONNECT（HTTP ${res.statusCode}）`));
        return;
      }
      finish(resolve, socket);
    });
    req.once('timeout', () => {
      req.destroy();
      finish(reject, new Error(`代理 ${proxy.host}:${proxy.port} 握手超时`));
    });
    req.once('error', (e) => {
      finish(reject, new Error(`连不上代理 ${proxy.host}:${proxy.port}（${e.code || e.message}）`));
    });
    req.end();
  });
}

/**
 * 发一个 GET，返回 { status, headers, text, bytes }。
 * 传了 proxy 就走隧道，没传就直连。
 */
export async function httpGet(url, { proxy = null, headers = {}, timeoutMs = 15000 } = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port || (isHttps ? 443 : 80));

  let plain = null;
  let secure = null;

  if (proxy) {
    plain = await tunnel(proxy, u.hostname, port, timeoutMs);
    if (isHttps) {
      secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername: u.hostname }, () => resolve(s));
        s.once('error', (e) => reject(new Error(`TLS 握手失败：${e.message}`)));
        s.once('timeout', () => reject(new Error('TLS 握手超时')));
      });
    }
  }

  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      host: u.hostname,
      port,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { ...headers },
      timeout: timeoutMs,
    };

    // 关键：必须用一个「createConnection 已经被换掉」的 Agent 实例。
    // 直接写 agent: false + createConnection 是没用的 —— agent: false 时
    // node 会自己 new 一个默认 Agent，把传进来的 createConnection 丢掉，
    // 结果就是绕过隧道直连目标（在被墙的域名上表现为超时，很难看出原因）。
    let agent = null;
    if (plain) {
      const sock = isHttps ? secure : plain;
      agent = new mod.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => sock;
    }
    opts.agent = agent ?? false;

    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        agent?.destroy();
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: buf.toString('utf8'),
          bytes: buf.length,
        });
      });
      res.on('error', (e) => {
        agent?.destroy();
        reject(e);
      });
    });
    req.once('timeout', () => {
      req.destroy();
      agent?.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.once('error', (e) => {
      agent?.destroy();
      reject(e);
    });
    req.end();
  });
}

/**
 * 探测可用的本地代理。
 *
 * 端口扫描那一路：拿一个真实目标去连一次 CONNECT，连得上才算数 ——
 * 光看端口在监听不够，很多软件会开一堆监听端口但没一个能出网。
 *
 * ⚠️ 环境变量那一路必须**再真发一次请求**，只验 CONNECT 是不够的。
 * 踩过的坑：有些环境（沙盒 / CI）会注入 http_proxy 指向一个
 * 「能回 CONNECT、但不转发数据」的黑洞代理。它隧道建得成，于是被选中；
 * 之后每个请求都在 TLS 阶段被掐断，报
 * `Client network socket disconnected before secure TLS connection was established`
 * —— 看着像网络抖动或目标站不稳，其实是代理从头就选错了。
 * 本机实测就是这样：环境变量指向 11530（curl 直测 code=000），
 * 真正能用的是扫出来的 7892。
 *
 * 端口扫到的候选不必做这一步：那些是本机代理软件，CONNECT 通了数据就通。
 */
export async function detectProxy({ target = 'api.bgm.tv', port = 443, timeoutMs = 2500, env = process.env } = {}) {
  const fromEnv = proxyFromEnv(env);
  if (fromEnv) {
    try {
      const socket = await tunnel(fromEnv, target, port, timeoutMs);
      socket.destroy();
      const res = await httpGet(`https://${target}/v0/subjects/1`, {
        proxy: fromEnv,
        timeoutMs: Math.max(timeoutMs, 8000),
        headers: { 'User-Agent': 'jikai-proxy-probe' },
      });
      if (res.status > 0) return fromEnv;
    } catch {
      /* 环境变量里那个不可用（或只是个黑洞口），继续扫端口 */
    }
  }
  for (const p of PROXY_CANDIDATES) {
    const cand = { host: '127.0.0.1', port: p, from: 'scan' };
    try {
      const socket = await tunnel(cand, target, port, timeoutMs);
      socket.destroy();
      return cand;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

export function describeProxy(proxy) {
  if (!proxy) return '未检测到可用代理（将尝试直连）';
  const src = proxy.from === 'env' ? '环境变量' : '端口扫描';
  return `${proxy.host}:${proxy.port}（来自${src}）`;
}
