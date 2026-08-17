# 次回 · jikai

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)](https://github.com/liamzhong-dev/jikai-anime-schedule/releases)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

Windows 追番桌面小工具。本季番剧、播出时间表、更新倒计时、补番 deadline 放在同一个窗口里。

自带 2026 年 4 / 7 / 10 月三个季度共 219 部真实番剧数据，装上就能看，不用联网。名字的「次回」取自日语里的次回予告，也就是下集预告。

![本季番剧](screenshots/01-season.png)

## 功能

### 本季番剧

按季度（冬 / 春 / 夏 / 秋）切换，卡片显示封面、中日文名、制作公司、评分。顶部搜索框按中日文名、制作公司、标签实时过滤。点卡片右上角星标加入或取消追番。封面取不到时按标题生成渐变色块。

![详情抽屉](screenshots/05-detail.png)

### 播出时间表

周一开始的七天视图，今天那一列高亮并标出日期。时间换算到北京时间，日本写的「周三 25:30」会落到周四凌晨那一格。当天 18:00 到次日 06:00 的深夜档单独成块列出。右侧「今日更新」按时刻排出当天所有排播。

![播出时间表](screenshots/02-schedule.png)

### 追番队列

按下一次更新时间排序，每条显示倒计时（`2 天后`、`5 小时后`、`18 分钟后`），已播出的转成「几小时前已更新」。积压的提示「攒了 N 话没看」，已完结的不提示。每条可设为在看、想看、搁置、弃了，搁置和弃了不再提醒。右下角七格条形图显示本周每天有几部更新。

![追番队列](screenshots/03-following.png)

### 补番清单

自己给每部补番设 deadline，卡片显示还剩几天、还剩几话，配三档颜色：逾期（红）、三天内（黄）、时间宽裕（灰）。已补完的排在最后。逾期数量在侧边栏单独计数。

![补番清单](screenshots/04-catchup.png)

### 布局

界面由卡片组成，位置和大小都能拖，改动自动保存。自带 4 套预设：默认宽屏双栏、专注主卡优先、纵向堆叠、紧凑小窗总览。当前摆位可以存成自己的预设，能重命名、删除、导出成 JSON 再导回。窗口宽度小于 1180px 时卡片改成单列堆叠。

![布局预设](screenshots/11-settings-layout.png)

![窄窗口](screenshots/19-narrow.png)

### 主题

共九套，分三组：

| 分组 | 主题 |
| --- | --- |
| 默认 | 夜航 |
| 简洁 | Linear 极客黑、Notion 柔和白、Raycast 深邃蓝、Stripe 清爽紫 |
| ACG | 赛博霓虹、樱雪和风、马卡龙萌系、机甲战术风 |

换肤按钮在顶栏，快捷键 `T` 同样可以轮换。

![Notion 柔和白](screenshots/15-theme-notion.png)

![樱雪和风](screenshots/16-theme-sakura.png)

![赛博霓虹](screenshots/18-theme-cyber.png)

![机甲战术风](screenshots/17-theme-mecha.png)

### 壁纸

选一张本地图片做背景，自动缩到长边 1920 后保存。可调六项：不透明度、模糊、亮度、缩放、位置、暗角。卡片和侧栏的不透明度能单独压低，让壁纸透出来。

![壁纸](screenshots/07-wallpaper.png)

![模糊与暗角](screenshots/08-wallpaper-blur.png)

### 托盘

关闭窗口后进入托盘继续运行，不退出。托盘菜单显示今天有几部更新、待补几部、已逾期几部，可以直接跳到对应视图。支持开机自启，开机时带 `--hidden` 参数，不弹窗口。全局快捷键默认 `Ctrl+Shift+A`，在其他程序前台时也能呼出主窗口。

## 页面

四个主视图，由左侧栏切换：

| 视图 | 包含的内容 |
| --- | --- |
| 本季番剧 | 本季概览、番剧库 |
| 时间表 | 播出时间表、今日更新 |
| 我的追番 | 追番队列、接下来 7 天、追番分布 |
| 补番清单 | 补番清单、补番概览 |

点任意一张卡片从右侧打开详情抽屉，里面有简介、标签、话数，以及 Bangumi 和萌娘百科的外链。按 `?` 打开快捷键面板。

设置面板按 `,` 打开，共六个标签页：

| 标签页 | 内容 |
| --- | --- |
| 外观 | 主题切换、壁纸与六项参数 |
| 数据源 | 三档数据源、代理、网络诊断 |
| 布局 | 预设切换与保存、导入导出 |
| 提醒 | 关窗与最小化的行为、开机自启、全局快捷键 |
| 系统 | 季度缓存清理、隐藏功能列表、本机路径 |
| 联系 | 作者邮箱与 GitHub |

![外观设置](screenshots/09-settings-look.png)

![数据源设置](screenshots/10-settings-data.png)

![提醒设置](screenshots/12-settings-remind.png)

![系统设置](screenshots/13-settings-system.png)

## 快捷键

![快捷键面板](screenshots/14-shortcuts.png)

| 按键 | 作用 |
| --- | --- |
| `1` `2` `3` `4` | 切换四个主视图 |
| `/` | 聚焦搜索框 |
| `R` | 同步当前季度 |
| `T` | 轮换配色主题 |
| `B` | 开关壁纸 |
| `L` | 打开布局预设 |
| `,` | 打开设置 |
| `?` | 打开快捷键面板 |
| `Esc` | 清空搜索、关闭浮层 |
| `Ctrl+R` | 刷新界面 |
| `Ctrl+Shift+A` | 全局呼出主窗口 |

光标在输入框里时，单字符快捷键不生效。

## 运行

需要 Node.js 18 以上。

```bash
npm install
npm run desktop
```

也可以双击仓库根目录的 `启动次回.bat`，它会检查依赖和构建产物，缺的自己补上。

发布的是源码，没有安装包。目前只在 Windows 上验证过。

## 数据

设置里可以选三档数据源，默认是自带数据：

| 数据源 | 说明 |
| --- | --- |
| 自带数据（默认） | 2026 年 4 / 7 / 10 月三个季度共 219 部，离线可用 |
| bangumi-data | 拉取真实番剧表，只有排播信息 |
| bangumi-data + Bangumi API | 补上话数、评分、封面、简介、制作公司 |

自带数据来自 [bangumi-data](https://github.com/bangumi-data/bangumi-data)（CC BY 4.0）与 Bangumi v0 API。

联网需要代理，桌面版自动跟随系统代理，也可以在数据源页手填代理地址或自建反代。数据源页有网络诊断按钮，连接错误会显示成中文说明。拉取失败时界面顶部挂横幅，说明当前看到的是哪份数据。

![同步中](screenshots/06-syncing.png)

季度缓存和用户数据分开存，缓存最多保留 10 个季度，超出淘汰最旧的，可以在系统页查看和清理。用户数据在 Electron 的用户数据目录下，Windows 上是 `%APPDATA%\jikai\`。

## 已知限制

- 没有安装包，自动更新只做到「检查 + 跳去下载」，入口当前收起
- 只适配 Windows，macOS 和 Linux 未验证
- 托盘图标不随更新数量变化
- 换主题没有过渡动画
- 壁纸单张上限约 3.2MB，只存一份，不分视图

## 联系

用出问题，或者有想法想聊，发邮件给我：liam.zhong@foxmail.com

也可以在 GitHub 上找我：[@liamzhong-dev](https://github.com/liamzhong-dev)

## 许可

代码以 MIT 许可发布，见 [LICENSE](LICENSE)。

番剧数据来自 bangumi-data（CC BY 4.0）与 Bangumi v0 API，版权归原作者所有。封面图不打包进仓库，界面直接引用原站直链。本作与 Bangumi 官方无关。
