'use strict';

/**
 * 自动更新的「取数」部分（跑在主进程）。
 *
 * 判断逻辑（怎么比版本号、要不要跳过某个版本）全在 src/core/update.js 里，
 * 那是纯函数，渲染层直接调、也能被测试覆盖。这里只负责把那个 URL 的 JSON
 * 拿回来 —— 走 net.cjs 的网络通道，于是它自动跟随系统代理 / VPN，
 * 也能带上 GitHub API 需要的 Accept 头。
 *
 * 为什么单独一个文件而不是塞进 main.cjs：main.cjs 已经管了窗口、托盘、
 * 落盘、通知四件事，再往里加网络取数就太杂了。这里只做一件事，方便单测。
 *
 * 支持两种更新源（与 normalizeManifest 的分支一一对应）：
 *   1) 自定义 manifest：{ version, notes, url, mandatory, sha256 }
 *   2) GitHub Releases API：{ tag_name, body, html_url, assets: [...] }
 *
 * 注意：把「GitHub 仓库地址」翻译成 API 地址这一步不在这里，在
 * src/core/update.js 的 toApiUrl() 里 —— 它是纯字符串变换，放在纯函数层
 * 才能进测试。这里拿到的已经是最终请求地址。
 */

const { fetchJson } = require('./net.cjs');

/**
 * 取更新源 JSON。永远 resolve，不 reject：调用方拿到的是
 * { ok, status, url, data|error }，跟 fetchJson 同一套形状，
 * 渲染层的 platform.checkUpdate 直接照着判就行。
 */
async function checkUpdate({ manifestUrl, timeoutMs = 12000 } = {}) {
  const raw = String(manifestUrl ?? '').trim();
  if (!raw) return { ok: false, status: 0, error: '没有配置更新源地址' };
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, status: 0, error: '更新源地址必须以 http:// 或 https:// 开头' };
  }

  const res = await fetchJson({
    url: raw,
    timeoutMs,
    // 同一串头对自定义 manifest 也无害：普通 HTTP 服务会忽略它
    headers: {
      Accept: 'application/vnd.github+json, application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  return { ...res, url: raw };
}

module.exports = { checkUpdate };
