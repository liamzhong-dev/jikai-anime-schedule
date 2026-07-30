/**
 * 功能开关：只隐藏，不删除。
 *
 * 有些功能代码写完了、界面也接上了，但在当前条件下**点下去只会让人失望** ——
 * 最典型的是自动更新：还没有安装包、也没有发布渠道，点「检查更新」只会回一句
 * 「未配置更新源」。这种东西挂在界面上，消耗的是对其它功能的信任。
 *
 * 所以统一收到这里：visible 为 false 的一律不渲染入口，代码原样留着。
 * 等条件具备了（真的打了安装包、发了 release），把这一行改回来就复活了。
 * 不删代码 —— 删了以后再想加回来，得重新踩一遍坑。
 *
 * 注意这里管的是「界面入口」，不是「实现」：底层的 IPC 通道、纯函数、测试
 * 都还在跑。所以改回来的时候不需要重新验证一遍逻辑，只是把门打开。
 */
export const FEATURES = {
  autoUpdate: {
    visible: false,
    label: '自动更新',
    reason: '还没有安装包和发布渠道，点「检查更新」只会说「未配置更新源」',
  },
};

/** 该功能的入口要不要显示。没登记过的一律按「显示」处理 */
export function isVisible(key) {
  return FEATURES[key]?.visible !== false;
}

/** 藏起来的原因，用来在文档 / 调试面板里说清「为什么藏」 */
export function hiddenReason(key) {
  const f = FEATURES[key];
  return f && f.visible === false ? f.reason : null;
}

/** 全部被隐藏的功能，给「关于」里那句说明用 */
export function hiddenFeatures() {
  return Object.entries(FEATURES)
    .filter(([, f]) => f.visible === false)
    .map(([id, f]) => ({ id, label: f.label, reason: f.reason }));
}
