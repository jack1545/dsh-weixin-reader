/**
 * 微信公众号文章解析器：HTML → 结构化 Markdown。
 *
 * 零依赖，只用 Node 内置能力，可脱离 DSH 独立测试。
 *
 * 导出：
 *   fetchArticle(url, options)  抓取并解析一篇 mp.weixin.qq.com 文章
 *   parseArticle(html, url)     纯函数解析（便于离线测试）
 *   formatArticle(article)      渲染成适合模型阅读的 Markdown
 */

/** 桌面浏览器 UA：微信对无 UA 的请求会返回验证页。 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 只有这些 host 的文章走本解析器。 */
const ALLOWED_HOSTS = new Set(['mp.weixin.qq.com']);

/** 自闭合/空元素，不参与树的嵌套。 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 整块丢弃的标签（内容也不保留）。 */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'video', 'audio']);

/** 块级标签：在 Markdown 中独占段落。 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'table', 'thead', 'tbody', 'tr', 'hr', 'figure', 'figcaption',
]);

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  times: '\u00d7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', plusmn: '\u00b1', laquo: '\u00ab', raquo: '\u00bb',
  bull: '\u2022', dagger: '\u2020', prime: '\u2032', Prime: '\u2033',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  sect: '\u00a7', para: '\u00b6', permil: '\u2030',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
};

/**
 * 解码 HTML 实体（命名实体 + 十进制/十六进制数字实体）。
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (!text || text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, body) ? HTML_ENTITIES[body] : match;
  });
}

/**
 * 读取一个标签属性值，兼容单引号、双引号与无引号写法。
 * @param {string} attrs
 * @param {string} name
 * @returns {string | null}
 */
export function getAttr(attrs, name) {
  if (!attrs) return null;
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  const value = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] || ''));
  return decodeEntities(value).trim();
}

/**
 * 把 HTML 解析成极简节点树，只保留结构信息。
 * @param {string} html
 * @returns {Array<object>} 根节点数组
 */
function buildTree(html) {
  const roots = [];
  const stack = [{ tag: '#root', children: roots }];
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/gi;
  let lastIndex = 0;
  let match;
  let dropDepth = 0;

  const pushText = (text) => {
    if (!text) return;
    stack[stack.length - 1].children.push({ tag: '#text', text: decodeEntities(text) });
  };

  while ((match = tagRe.exec(html)) !== null) {
    if (dropDepth === 0) pushText(html.slice(lastIndex, match.index));
    lastIndex = tagRe.lastIndex;

    const raw = match[0];
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue;

    const closing = match[1];
    const tag = (match[2] || '').toLowerCase();
    const attrs = match[3] || '';
    const selfClosing = match[4];
    if (!tag) continue;

    if (closing) {
      if (dropDepth > 0) {
        if (DROP_TAGS.has(tag)) dropDepth -= 1;
        continue;
      }
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }

    if (dropDepth > 0) {
      if (DROP_TAGS.has(tag) && !VOID_TAGS.has(tag)) dropDepth += 1;
      continue;
    }
    if (DROP_TAGS.has(tag)) {
      if (!VOID_TAGS.has(tag) && !selfClosing) dropDepth += 1;
      continue;
    }
    if (VOID_TAGS.has(tag)) {
      stack[stack.length - 1].children.push({ tag, attrs });
      continue;
    }

    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  if (dropDepth === 0) pushText(html.slice(lastIndex));
  return roots;
}

/** 把图片节点解析成绝对 URL（微信懒加载用 data-src）。 */
function imageUrl(node) {
  const raw = getAttr(node.attrs, 'data-src') || getAttr(node.attrs, 'src') || '';
  if (!raw) return '';
  return raw.startsWith('//') ? 'https:' + raw : raw;
}

/**
 * 行内渲染：把节点数组渲染成 Markdown 文本。
 * @param {Array<object>} nodes
 * @returns {string}
 */
function renderInline(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.tag === '#text') {
      out.push(node.text.replace(/\s+/g, ' '));
      continue;
    }
    if (node.tag === 'br') { out.push('\n'); continue; }
    if (node.tag === 'img') {
      const src = imageUrl(node);
      if (!src) continue;
      out.push('![' + (getAttr(node.attrs, 'alt') || '') + '](' + src + ')');
      continue;
    }
    const inner = renderInline(node.children || []);
    const trimmed = inner.trim();
    switch (node.tag) {
      case 'strong': case 'b': out.push(trimmed ? '**' + trimmed + '**' : ''); break;
      case 'em': case 'i': out.push(trimmed ? '*' + trimmed + '*' : ''); break;
      case 'del': case 's': case 'strike': out.push(trimmed ? '~~' + trimmed + '~~' : ''); break;
      case 'code': out.push(trimmed ? '`' + trimmed.replace(/`/g, '') + '`' : ''); break;
      case 'a': {
        const href = getAttr(node.attrs, 'href') || '';
        if (!trimmed) break;
        out.push(href && href !== trimmed ? '[' + trimmed + '](' + href + ')' : trimmed);
        break;
      }
      default: out.push(inner);
    }
  }
  return out.join('');
}

/** 代码块按原样取出，不解释其中的标签文本。 */
function collectCodeText(node) {
  let text = '';
  const walk = (n) => {
    if (n.tag === '#text') { text += n.text; return; }
    if (n.tag === 'br') { text += '\n'; return; }
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** 列表渲染，支持嵌套。 */
function renderList(node, ordered, indent) {
  const lines = [];
  let index = 1;
  const items = (node.children || []).filter((c) => c.tag === 'li');
  for (const item of items) {
    const body = renderBlocks(item.children || [], indent + '  ');
    const collapsed = body.replace(/\n{2,}/g, '\n').trim();
    const marker = ordered ? (index + '. ') : '- ';
    index += 1;
    if (!collapsed) { lines.push((indent + marker).replace(/\s+$/, '')); continue; }
    const parts = collapsed.split('\n');
    lines.push(indent + marker + parts[0]);
    const pad = ' '.repeat(indent.length + marker.length);
    for (const line of parts.slice(1)) lines.push(line ? pad + line : '');
  }
  return lines.join('\n');
}

/** 表格渲染成 GitHub 风格 Markdown。 */
function renderTable(node) {
  const rows = [];
  const walk = (n) => {
    if (n.tag === 'tr') {
      const cells = (n.children || [])
        .filter((c) => c.tag === 'td' || c.tag === 'th')
        .map((c) => renderInline(c.children || []).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
      if (cells.length) rows.push(cells);
      return;
    }
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  if (!rows.length) return '';
  const width = Math.max.apply(null, rows.map((r) => r.length));
  const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
  const head = pad(rows[0]);
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
  for (const row of rows.slice(1)) lines.push('| ' + pad(row).join(' | ') + ' |');
  return lines.join('\n');
}

/**
 * 块级渲染：把节点数组渲染成 Markdown 段落流。
 * @param {Array<object>} nodes
 * @param {string} [indent] 当前嵌套缩进（列表内使用）
 * @returns {string}
 */
export function renderBlocks(nodes, indent) {
  const pad = indent || '';
  const parts = [];
  let inlineBuffer = [];

  const flushInline = () => {
    if (!inlineBuffer.length) return;
    const text = renderInline(inlineBuffer)
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, i, arr) => line || (i > 0 && i < arr.length - 1))
      .join('\n')
      .trim();
    inlineBuffer = [];
    if (text) parts.push(pad + text.replace(/\n/g, '\n' + pad));
  };

  for (const node of nodes) {
    if (node.tag === '#text') { inlineBuffer.push(node); continue; }
    if (!BLOCK_TAGS.has(node.tag)) { inlineBuffer.push(node); continue; }
    flushInline();

    switch (node.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(node.tag[1]);
        const text = renderInline(node.children || []).replace(/\s+/g, ' ').trim();
        if (text) parts.push('#'.repeat(level) + ' ' + text);
        break;
      }
      case 'hr': parts.push('---'); break;
      case 'pre': {
        const code = collectCodeText(node);
        if (code.trim()) parts.push('```\n' + code + '\n```');
        break;
      }
      case 'blockquote': {
        const inner = renderBlocks(node.children || [], '').trim();
        if (inner) parts.push(inner.split('\n').map((l) => ('> ' + l).replace(/\s+$/, '')).join('\n'));
        break;
      }
      case 'ul': { const list = renderList(node, false, pad); if (list) parts.push(list); break; }
      case 'ol': { const list = renderList(node, true, pad); if (list) parts.push(list); break; }
      case 'table': { const table = renderTable(node); if (table) parts.push(table); break; }
      case 'figcaption': {
        const text = renderInline(node.children || []).replace(/\s+/g, ' ').trim();
        if (text) parts.push(pad + '*' + text + '*');
        break;
      }
      case 'li': {
        const text = renderInline(node.children || []).replace(/\s+/g, ' ').trim();
        if (text) parts.push(pad + '- ' + text);
        break;
      }
      default: {
        const inner = renderBlocks(node.children || [], pad).trim();
        if (inner) parts.push(inner);
      }
    }
  }
  flushInline();
  return parts.join('\n\n');
}

/**
 * 从 <div id="js_content"> 开始按深度计数截出正文片段。
 * 比贪婪正则可靠：正文含大量嵌套 div/section。
 * @param {string} html
 * @returns {string | null}
 */
export function extractContentHtml(html) {
  const openRe = /<div[^>]*\bid\s*=\s*["']js_content["'][^>]*>/i;
  const open = openRe.exec(html);
  if (!open) return null;

  const start = open.index + open[0].length;
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  tagRe.lastIndex = start;
  let depth = 1;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    if ((match[2] || '').toLowerCase() !== 'div') continue;
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return html.slice(start, match.index);
    } else if (!match[4]) {
      depth += 1;
    }
  }
  return html.slice(start);
}

/** 从 meta 或 JS 变量里取第一个命中的值。 */
function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] !== undefined) {
      const value = decodeEntities(m[1]).trim();
      if (value) return value;
    }
  }
  return null;
}

/**
 * 解析微信文章 HTML（纯函数）。
 * @param {string} html
 * @param {string} [url]
 * @returns {object} 解析结果
 */
export function parseArticle(html, url) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('页面内容为空');

  const blocked = /环境异常|wappoc_appmsgcaptcha/.test(html);
  const removed = /该内容已被发布者删除|此内容因违规无法查看|参数错误/.test(html);

  const title = firstMatch(html, [
    /property\s*=\s*"og:title"\s+content\s*=\s*"([^"]*)"/i,
    /content\s*=\s*"([^"]*)"\s+property\s*=\s*"og:title"/i,
    /var\s+msg_title\s*=\s*'([^']*)'/i,
  ]) || '';

  const author = firstMatch(html, [
    /var\s+nickname\s*=\s*htmlDecode\s*\(\s*"([^"]*)"\s*\)/i,
    /var\s+nickname\s*=\s*"([^"]*)"/i,
    /var\s+nickname\s*=\s*'([^']*)'/i,
    /property\s*=\s*"og:article:author"\s+content\s*=\s*"([^"]*)"/i,
    /id\s*=\s*"js_name"[^>]*>([\s\S]*?)<\//i,
  ]);

  const ctRaw = firstMatch(html, [
    /var\s+ct\s*=\s*"(\d{9,})"/i,
    /var\s+ct\s*=\s*'(\d{9,})'/i,
    /var\s+ct\s*=\s*(\d{9,})/i,
  ]);
  const publishedAt = ctRaw ? new Date(Number(ctRaw) * 1000).toISOString() : null;

  const cover = firstMatch(html, [
    /property\s*=\s*"og:image"\s+content\s*=\s*"([^"]*)"/i,
    /var\s+msg_cdn_url\s*=\s*"([^"]*)"/i,
  ]);

  const contentHtml = extractContentHtml(html);
  const nodes = contentHtml ? buildTree(contentHtml) : [];
  const markdown = renderBlocks(nodes)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const wordCount = markdown.replace(/[\s!\[\]()#*>`~\-|]/g, '').length;
  const imageCount = (markdown.match(/!\[[^\]]*\]\(/g) || []).length;

  return {
    url: url || '',
    title,
    author,
    publishedAt,
    cover,
    markdown,
    wordCount,
    imageCount,
    readingMinutes: Math.max(1, Math.round(wordCount / 400)),
    empty: markdown.length === 0,
    blocked,
    removed,
  };
}

/**
 * 抓取并解析一篇微信公众号文章。
 * @param {string} url
 * @param {{ timeoutMs?: number, userAgent?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<object>}
 */
export async function fetchArticle(url, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 30000;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const signal = opts.signal;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('不是合法的 URL：' + url);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('只支持 http/https 链接：' + url);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('只支持微信公众号文章（mp.weixin.qq.com），收到：' + parsed.hostname);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response;
  try {
    response = await fetch(parsed.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('抓取超时（' + timeoutMs + 'ms）：' + url);
    throw new Error('抓取失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!response.ok) throw new Error('抓取失败：HTTP ' + response.status + ' ' + response.statusText);

  const html = await response.text();
  const article = parseArticle(html, parsed.href);

  if (article.blocked) throw new Error('触发微信环境验证（页面返回“环境异常”），请稍后重试。');
  if (article.removed) throw new Error('文章不可访问：已被发布者删除或因违规无法查看。');
  if (article.empty) throw new Error('未能提取正文：页面结构可能已变化，或该链接不是文章正文页。');
  return article;
}

/**
 * 把解析结果渲染成适合模型阅读的 Markdown 全文。
 * @param {object} article
 * @returns {string}
 */
export function formatArticle(article) {
  const blocks = ['# ' + (article.title || '(无标题)')];
  const info = [];
  if (article.author) info.push('作者：' + article.author);
  if (article.publishedAt) info.push('发布时间：' + article.publishedAt);
  if (article.wordCount) info.push('字数：约 ' + article.wordCount);
  if (article.imageCount) info.push('图片：' + article.imageCount + ' 张');
  if (info.length) blocks.push(info.join(' ｜ '));
  if (article.url) blocks.push('原文：' + article.url);
  return blocks.join('\n\n') + '\n\n---\n\n' + article.markdown;
}