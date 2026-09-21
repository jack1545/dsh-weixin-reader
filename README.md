# dsh-weixin-reader

[English](README.md) | [中文](README.zh.md)

A WeChat Official Account article reader for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It fetches a `mp.weixin.qq.com` article and parses the body into clean Markdown for the model.

## Why

Harness's built-in `web_fetch` often fails on WeChat articles: the site returns an environment-check page, the body is buried under heavy inline styles and nested containers, and images load lazily through `data-src`. This plugin handles those cases and exposes a single narrow tool.

## What it provides

One model-facing tool, `weixin_read`:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Article link, e.g. `https://mp.weixin.qq.com/s/xxxxxxxx` |
| `maxChars` | integer | no | Maximum body characters before truncation; falls back to the plugin config |
| `saveToFile` | boolean | no | Write the full body to a workspace file; falls back to the plugin config |

The canonical result carries `title`, `author`, `publishedAt`, `sourceUrl`, `wordCount`, `imageCount`, `markdown`, `truncated`, `savedTo`, and `bodyChars`. What the model sees is rendered Markdown: the title, a metadata line, then the body.

The plugin also registers a system-prompt section telling the model to prefer `weixin_read` over `web_fetch` for WeChat articles.

## Install

```sh
dsh plugin --profile web add github:jack1545/dsh-weixin-reader
```

Running from a source checkout, use `pnpm dsh` instead of `dsh`. Restart the Harness process to load the new layer.

Verify the layer without starting:

```sh
dsh --profile web --dump-config   # should contain a "# == dsh-weixin-reader" layer
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-weixin-reader
```

## Configuration

Every tunable lives in the `config` block of `cordis.patch.yml`, and can be overridden by `id` in a profile's own `cordis.patch.yml`:

| Key | Default | Description |
|---|---|---|
| `timeoutMs` | `30000` | Fetch timeout in milliseconds |
| `maxChars` | `60000` | Body character limit; longer bodies are truncated and flagged |
| `saveToFile` | `false` | Whether to save the full body by default |
| `saveDir` | `""` | Save directory; empty writes to `<workspace>/weixin-articles/` |
| `systemPromptOrder` | `10120` | Prompt-section order; later sits closer to generation |
| `userAgent` | `""` | Overrides the default desktop browser UA |

## Two design decisions

**No subprocess for fetching.** The Harness file sandbox blocks Node from reading a child process's pipes; `execFileSync` and piped `spawn` both fail with `EPERM`, so external fetchers such as `url-md.exe` cannot be used from inside a plugin. This plugin uses the host `fetch` instead, which inherits the process's existing proxy settings and is unaffected by that limit. Redirecting a child's stdout to a file descriptor rather than a pipe would work around it, but that adds temporary files and cleanup responsibility for no benefit here.

**Zero external imports.** A profile's `node_modules` does not provide `@deepseek-ai/*` runtime dependencies, so the plugin uses only Node built-ins and `ctx`, and does not use `defineTool`. The cost is manual argument validation, which is implemented and whose failure messages match the declared schema.

## Limitations

- **`mp.weixin.qq.com` only.** Other hosts are rejected, so it cannot be repurposed as a general fetcher.
- **Fails loudly rather than degrading.** An environment-check page, a deleted or restricted article, and an unrecognizable page structure each raise an explicit error instead of silently retrying or returning an empty body.
- **The body is a parse result, not raw HTML.** Rich layouts (custom cards, interactive components) degrade to text or image links; images stay as Markdown image syntax and are not downloaded.
- **No bulk fetching.** Keep the request rate low and respect WeChat's platform terms; this plugin is for personal reading and research.

## Layout

```
dsh-weixin-reader/
├── package.json         # declares dsh.bundle
├── cordis.patch.yml     # the layer applied on install
├── index.js             # plugin entry: registers weixin_read and the prompt section
└── lib/parser.js        # zero-dependency parser, testable outside Harness
```

`lib/parser.js` works standalone:

```js
import { fetchArticle, formatArticle } from './lib/parser.js';

const article = await fetchArticle('https://mp.weixin.qq.com/s/xxxxxxxx');
console.log(article.title, article.author, article.wordCount);
console.log(formatArticle(article));
```

## Verification

Measured locally on 2026-09-21:

- `weixin_read` fetched and parsed a real article: title, author, and publication time correct; 5049 characters and 16 images; clean Markdown structure.
- Argument validation rejects, as intended: a missing `url`, a non-object argument, an empty string, a non-positive-integer `maxChars`, and an undeclared extra key.
- A non-`mp.weixin.qq.com` host is rejected.
- `maxChars` truncation applies and is flagged; `saveToFile` writes the correct path and full Markdown content.
- The canonical result matches `output.schema` exactly: all required keys present, no undeclared keys.

## License

MIT. This plugin is not affiliated with Tencent or WeChat, and is intended for personal reading and research.