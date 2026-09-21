# dsh-weixin-reader

[English](README.md) | 中文

微信公众号文章阅读插件（DeepSeek Harness bundle）。抓取 `mp.weixin.qq.com` 文章，把正文解析成干净的 Markdown 交给模型。

## 为什么需要它

Harness 内置的 `web_fetch` 对公众号文章经常拿不到正文：微信会返回环境校验页，正文被大量内联样式与嵌套容器包裹，图片走 `data-src` 懒加载。本插件专门处理这些情况，并对外只暴露一个窄接口。

## 它提供什么

一个模型可见的工具 `weixin_read`：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 文章链接，形如 `https://mp.weixin.qq.com/s/xxxxxxxx` |
| `maxChars` | integer | 否 | 返回正文的最大字符数，超出则截断；默认取插件配置 |
| `saveToFile` | boolean | 否 | 是否把完整正文写入工作区文件；默认取插件配置 |

返回的规范值含 `title`、`author`、`publishedAt`、`sourceUrl`、`wordCount`、`imageCount`、`markdown`、`truncated`、`savedTo`、`bodyChars`。模型看到的是渲染后的 Markdown：标题、元信息行，然后是正文。

插件还会注册一个 system-prompt 段落，提示模型读取公众号文章时优先选 `weixin_read`，而不是 `web_fetch`。

## 安装

```sh
dsh plugin --profile web add github:jack1545/dsh-weixin-reader
```

从源码检出运行时，把 `dsh` 换成 `pnpm dsh`。装完需要重启 Harness 进程才会加载新层。

先验证层已生效、暂不启动：

```sh
dsh --profile web --dump-config   # should contain a "# == dsh-weixin-reader" layer
```

卸载：

```sh
dsh plugin --profile web remove dsh-weixin-reader
```

## 配置

全部可调项都在 `cordis.patch.yml` 的 `config` 里，也可在 profile 自己的 `cordis.patch.yml` 中按 `id` 覆盖：

| 键 | 默认值 | 说明 |
|---|---|---|
| `timeoutMs` | `30000` | 单次抓取超时（毫秒） |
| `maxChars` | `60000` | 返回正文的字符上限，超出截断并标注 |
| `saveToFile` | `false` | 默认是否落盘完整正文 |
| `saveDir` | `""` | 保存目录；留空则写到 `<工作区>/weixin-articles/` |
| `systemPromptOrder` | `10120` | 提示段落顺序，越晚越靠近生成位置 |
| `userAgent` | `""` | 覆盖默认桌面浏览器 UA |

## 两处设计取舍

**不用子进程抓取。** Harness 的文件沙箱会拦截 Node 对子进程管道的读取，`execFileSync` 与管道式 `spawn` 都直接失败（`EPERM`），因此 `url-md.exe` 这类外部抓取器在插件内不可用。本插件改用宿主 `fetch`：它继承进程既有的代理设置，不受该限制。若把子进程的 stdout 重定向到文件描述符而非管道，确实可以绕开，但那会引入临时文件与额外的清理责任，在这里没有收益。

**零外部 import。** profile 的 `node_modules` 不提供 `@deepseek-ai/*` 运行时依赖，因此插件只使用 Node 内置模块与 `ctx`，不用 `defineTool`。代价是参数校验要手工写；该实现已完成，且失败信息与声明的 schema 一致。

## 已知限制

- **只接受 `mp.weixin.qq.com`。** 其他 host 一律拒绝，因此无法被改作通用抓取器。
- **触发风控时失败，而不是降级。** 环境校验页、文章被删除或受限、页面结构无法识别，都会抛出明确错误，不做静默重试或返回空正文。
- **正文是解析结果，不是原始 HTML。** 复杂排版（自定义卡片、互动组件）会退化为文本或图片链接；图片保留为 Markdown 图片语法，但不会下载。
- **不做批量抓取。** 请控制请求频率，遵守微信平台条款；本插件面向个人阅读与研究。

## 目录结构

```
dsh-weixin-reader/
├── package.json         # declares dsh.bundle
├── cordis.patch.yml     # the layer applied on install
├── index.js             # plugin entry: registers weixin_read and the prompt section
└── lib/parser.js        # zero-dependency parser, testable outside Harness
```

`lib/parser.js` 可独立使用：

```js
import { fetchArticle, formatArticle } from './lib/parser.js';

const article = await fetchArticle('https://mp.weixin.qq.com/s/xxxxxxxx');
console.log(article.title, article.author, article.wordCount);
console.log(formatArticle(article));
```

## 验证记录

在本机实测（2026-09-21）：

- `weixin_read` 成功抓取并解析一篇真实文章：标题、作者、发布时间均正确，正文 5049 字、16 张图，Markdown 结构干净。
- 参数校验按预期拒绝：缺 `url`、非对象参数、空字符串、`maxChars` 非正整数、未声明的多余键。
- 非 `mp.weixin.qq.com` 的 host 被拒绝。
- `maxChars` 截断生效且带标注；`saveToFile` 落盘路径与完整 Markdown 内容正确。
- 返回的规范值与 `output.schema` 完全一致：必填键齐全，无未声明的键。

## 许可

MIT。本插件与腾讯、微信官方无关，仅用于个人阅读与研究。