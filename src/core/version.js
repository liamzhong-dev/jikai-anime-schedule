/**
 * 应用版本，只此一份。
 *
 * package.json 才是权威，但业务层读不到它 —— 浏览器构建里不能直接 import
 * 一个 JSON（Node 那边又要 import attributes，两边写法不一致）。
 * 所以这里放一份常量，发版时和 package.json 一起改。
 * 主进程（CJS）仍然直接读 package.json，不受影响。
 */
export const APP_VERSION = '1.0.0';

/**
 * 项目主页。只用来拼请求 Bangumi API 时带的 User-Agent，
 * 不参与任何业务逻辑 —— 官方希望调用方是可追溯的，万一请求出问题对方能找到人。
 * 换仓库地址时改这一行就够（源码里没有第二处写死的地方）。
 */
export const PROJECT_URL = 'https://github.com/liamzhong-dev/jikai-anime-schedule';

/** 请求 Bangumi API 时带的 UA */
export const USER_AGENT = `jikai/${APP_VERSION} (+${PROJECT_URL})`;
