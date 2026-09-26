/**
 * 带连接复用的取数会话 —— 专为「一次几千个请求」的场景。
 *
 * 为什么不直接用 proxyfetch.mjs 里的 httpGet：
 *   那个每次调用都新建一条 CONNECT 隧道加一次完整 TLS 握手。实测约 1.3 秒/次，
 *   少量请求无所谓，全量抓取会同时撞两堵墙 ——
 *     ① 慢：1981 个请求串行要 40 分钟；
 *     ② 更麻烦的是并发一高，代理侧直接把 TLS 掐了，报
 *        `Client network socket disconnected before secure TLS connection
 *        was established`。这个报错看着像网络抖动，其实是自己把代理打爆了 ——
 *        真实踩到的表现是「第一季抓得好好的，从第二季起几乎全失败」。
 *
 * 做法：每个会话持有一条到目标的持久连接，在它上面串行发请求（HTTP/1.1 keep-alive），
 * 实测降到约 0.3 秒/次。会话数 = 并发数，一对一使用 ——
 * **一条连接同一时刻只跑一个请求**，所以不需要处理响应边界，
 * 也天然不会把代理的连接数打爆。
 *
 * 连接断了要能自己重建：服务端的 keep-alive 有超时，代理也可能中途掐。
 * 这里在每次请求前检查 socket 是否还活着，不活就重建；
 * 请求过程中断掉的，交给调用方重试（会话会把坏连接丢掉）。
 */

import https from 'node:https';
import tls from 'node:tls';

import { tunnel } from './proxyfetch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 建一个会话。
 *
 * @param {{proxy:object|null, host:string, port?:number, timeoutMs?:number}} opts
 * @returns {{request(path:string, opts?):Promise<{status:number,headers:object,text:string}>, close():void, stats:object}}
 */
export function makeSession({ proxy, host, port = 443, timeoutMs = 20000 }) {
  let agent = null;
  let socket = null;
  let closed = false;
  const stats = { connects: 0, requests: 0, reconnects: 0 };

  async function connect() {
    const plain = await tunnel(proxy, host, port, timeoutMs);
    const secure = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: host }, () => resolve(s));
      s.once('error', (e) => reject(new Error(`TLS 握手失败：${e.message}`)));
      s.once('timeout', () => reject(new Error('TLS 握手超时')));
    });
    const a = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
    // 关键：让 agent 复用我们这条已经握好手的隧道 socket。
    // 不能写 agent: false —— 那样 node 会自己 new 默认 Agent，
    // 把 createConnection 丢掉、绕过隧道直连目标（在被墙的域名上表现为超时）。
    a.createConnection = () => secure;
    agent = a;
    socket = secure;
    stats.connects += 1;
    return a;
  }

  function drop() {
    try { agent?.destroy(); } catch { /* 已经断了 */ }
    agent = null;
    socket = null;
  }

  async function ensure() {
    if (closed) throw new Error('会话已关闭');
    if (agent && socket && !socket.destroyed) return agent;
    if (agent) { stats.reconnects += 1; drop(); }
    return connect();
  }

  async function request(path, { headers = {}, timeoutMs: t = timeoutMs } = {}) {
    const a = await ensure();
    stats.requests += 1;
    return new Promise((resolve, reject) => {
      const req = https.request({ host, port, path, method: 'GET', headers, agent: a, timeout: t }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', (e) => { drop(); reject(e); });
      });
      req.once('timeout', () => { req.destroy(); drop(); reject(new Error(`请求超时（${t}ms）`)); });
      req.once('error', (e) => { drop(); reject(e); });
      req.end();
    });
  }

  return { request, close() { closed = true; drop(); }, stats };
}

/**
 * 按并发建一组会话，跑完关掉。
 *
 * @param {number} n
 * @param {object} opts 同 makeSession
 * @returns {Promise<{sessions:Array, closeAll:Function}>}
 */
export async function openSessions(n, opts) {
  const sessions = Array.from({ length: Math.max(1, n) }, () => makeSession(opts));
  return {
    sessions,
    closeAll() { for (const s of sessions) s.close(); },
  };
}

export { sleep };
