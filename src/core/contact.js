/**
 * 作者联系方式 —— 只给设置面板的「联系」页用。
 *
 * 不参与任何业务逻辑，也不会随任何请求发出去：对外请求带的那一串 UA
 * 在 core/version.js，跟这里不是一回事，别把两处混着改。
 *
 * 之所以拆成几段再拼、而不是直接写一个字面量：仓库是公开的，一整串
 * 摆在那里的地址会被收地址的爬虫整包捞走。拆开之后，
 * 「@foxmail.com」这种完整写法在源码里搜不到。
 * 要换联系方式就改下面这几行，别动拼接方式。
 */

// 邮箱：本地部分（用户名）+ 域名，两段分开存
const MAIL_LOCAL = ['liam', 'zhong'].join('.');
const MAIL_DOMAIN = `${['fox', 'mail'].join('')}.com`;

// GitHub 主页：https://github.com/liamzhong-dev
const GH_HOST = ['github', 'com'].join('.');
const GH_USER = ['liamzhong', 'dev'].join('-');

/** 联系邮箱（明文，展示用） */
export const CONTACT_EMAIL = `${MAIL_LOCAL}@${MAIL_DOMAIN}`;

/** 写信用的 mailto 链接 */
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;

/** GitHub 用户名 */
export const CONTACT_GITHUB_USER = GH_USER;

/** GitHub 主页地址 */
export const CONTACT_GITHUB_URL = `https://${GH_HOST}/${GH_USER}`;
