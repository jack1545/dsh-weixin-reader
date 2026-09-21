/**
 * dsh-weixin-reader — DeepSeek Harness 插件：读取微信公众号文章。
 *
 * 背景：DSH 内置的 web_fetch 对 mp.weixin.qq.com 常因环境校验、样式混淆
 * 而拿不到正文。本插件用一个零依赖的解析器抓取文章，把正文转成干净的
 * Markdown，再交给模型。
 *
 * 为什么不用子进程：DSH 沙箱会拦截 Node 对子进程管道的读取（EPERM），
 * 因此 url-md.exe 这类外部抓取器在插件内不可用；改用宿主 fetch（走
 * 进程既有的代理设置），并自行解析。
 *
 * 本文件刻意保持零外部 import：profile 的 node_modules 里不提供
 * @deepseek-ai/* 运行时依赖，只有纯 JS 插件才能稳定加载。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fetchArticle, formatArticle } from './lib/parser.js';

/** 插件名，与 package.json 的 dsh.bundle 行 id 保持一致。 */
export const name = 'dsh-weixin-reader';

/** 需要的服务：tools 注册表（工具注册）与 systemPrompt（可选提示段）。 */
export const inject = ['tools'];

/** 默认配置；所有可调项均可由 cordis.yml 的 config 覆盖。 */
const DEFAULTS = {
  timeoutMs: 30000,
  maxChars: 60000,
  saveToFile: false,
  saveDir: '',
  systemPromptOrder: 10120,
  userAgent: '',
};

/** 把 Markdown 截断到上限，并在末尾明确标注被截断。 */
function truncate(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  return {
    text: text.slice(0, maxChars) + '\n\n...（正文已截断，完整内容请用 saveToFile 或调大 maxChars）',
    truncated: true,
    originalChars: text.length,
  };
}

/** 生成一个文件系统安全的文件名。 */
function safeFileName(article) {
  const base = (article.title || 'weixin-article')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'weixin-article';
  const stamp = (article.publishedAt || '').slice(0, 10);
  return stamp ? `${stamp}-${base}.md` : `${base}.md`;
}

/** 把文章写入文件，返回绝对路径。 */
async function saveArticle(article, dir, baseDir) {
  const target = dir
    ? resolve(dir)
    : join(baseDir, 'weixin-articles');
  await mkdir(target, { recursive: true });
  const file = join(target, safeFileName(article));
  await writeFile(file, formatArticle(article), 'utf8');
  return file;
}

/**
 * 注册 weixin_read 工具。
 * @param {object} ctx Cordis 上下文
 * @param {object} config 解析后的插件配置
 */
function registerTool(ctx, config) {
  ctx.tools.register({
    name: 'weixin_read',
    description:
      '读取微信公众号文章正文（mp.weixin.qq.com）。返回标题、作者、发布时间与转成 Markdown 的正文，' +
      '适合需要阅读、总结或对比公众号文章的场景。仅接受 mp.weixin.qq.com 的文章链接。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '微信公众号文章链接，形如 https://mp.weixin.qq.com/s/xxxxxxxx',
        },
        maxChars: {
          type: 'integer',
          description: '返回正文的最大字符数，超出则截断；不传使用插件默认值。',
        },
        saveToFile: {
          type: 'boolean',
          description: '是否把完整正文写入工作区文件（默认 false；正文较长时建议开启）。',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          publishedAt: { type: 'string' },
          sourceUrl: { type: 'string' },
          wordCount: { type: 'integer' },
          imageCount: { type: 'integer' },
          markdown: { type: 'string' },
          truncated: { type: 'boolean' },
          savedTo: { type: 'string' },
          bodyChars: { type: 'integer' },
        },
        required: ['title', 'markdown'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const parts = [`# ${value.title || '(无标题)'}`];
        const meta = [];
        if (value.author) meta.push(`作者：${value.author}`);
        if (value.publishedAt) meta.push(`发布时间：${value.publishedAt}`);
        if (typeof value.wordCount === 'number') meta.push(`字数：约 ${value.wordCount}`);
        if (typeof value.imageCount === 'number') meta.push(`图片：${value.imageCount} 张`);
        if (value.sourceUrl) meta.push(`原文：${value.sourceUrl}`);
        if (meta.length) parts.push(meta.join(' ｜ '));
        if (value.savedTo) parts.push(`完整正文已保存到：${value.savedTo}`);
        if (value.truncated) parts.push('（正文已截断）');
        parts.push('---', value.markdown || '');
        return [{ type: 'text', text: parts.join('\n\n') }];
      },
    },
    async execute(args, exec) {
      // 绕过 defineTool 直接 register 时不会自动校验参数，这里手工把关，
      // 使非法调用的失败信息与 schema 声明保持一致。
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('参数必须是对象，且包含 url 字段。');
      }
      const known = ['url', 'maxChars', 'saveToFile'];
      const extra = Object.keys(args).filter((k) => !known.includes(k));
      if (extra.length) throw new Error('不支持的参数：' + extra.join('、'));
      if (args.maxChars !== undefined && (!Number.isInteger(args.maxChars) || args.maxChars <= 0)) {
        throw new Error('maxChars 必须是正整数。');
      }
      if (args.saveToFile !== undefined && typeof args.saveToFile !== 'boolean') {
        throw new Error('saveToFile 必须是布尔值。');
      }

      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) throw new Error('缺少参数 url，或它不是非空字符串。');

      const maxChars = Number.isFinite(args.maxChars) && args.maxChars > 0
        ? Math.floor(args.maxChars)
        : config.maxChars;

      const article = await fetchArticle(url, {
        timeoutMs: config.timeoutMs,
        signal: exec && exec.signal ? exec.signal : undefined,
        ...(config.userAgent ? { userAgent: config.userAgent } : {}),
      });

      // 规范值只承载正文本体；标题与元信息由 output.render 组合，
      // 避免渲染时出现重复标题。
      const clipped = truncate(article.markdown, maxChars);

      let savedTo = '';
      const wantSave = args.saveToFile === true || (args.saveToFile === undefined && config.saveToFile);
      if (wantSave) {
        try {
          savedTo = await saveArticle(article, config.saveDir, config.workspaceDir);
        } catch (error) {
          savedTo = '';
          ctx.logger
            ? ctx.logger.warn(`[dsh-weixin-reader] 保存正文失败：${error.message}`)
            : console.warn(`[dsh-weixin-reader] 保存正文失败：${error.message}`);
        }
      }

      return {
        title: article.title || '',
        author: article.author || '',
        publishedAt: article.publishedAt || '',
        sourceUrl: article.url || url,
        wordCount: article.wordCount,
        imageCount: article.imageCount,
        markdown: clipped.text,
        truncated: clipped.truncated,
        savedTo,
        bodyChars: clipped.originalChars,
      };
    },
  });
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {object} [rawConfig] cordis.yml 传入的配置
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig || {}) };

  // 保存目录基准：优先工作区，其次用户主目录。避免把文件写到不确定的位置。
  const cwd = (ctx.workspace && ctx.workspace.root)
    || (typeof process.cwd === 'function' ? process.cwd() : '')
    || join(homedir(), 'dsh-weixin-reader');
  config.workspaceDir = cwd;

  registerTool(ctx, config);

  // 可选：在系统提示词里说明这个工具的存在，帮助模型优先选它而不是 web_fetch。
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({
      name: 'tool:weixin-reader',
      order: config.systemPromptOrder,
      text:
        '读取微信公众号文章时优先使用 weixin_read 工具，它能把 mp.weixin.qq.com 的正文解析成干净的 Markdown；' +
        '内置 web_fetch 对该站点常因环境校验拿不到正文。',
    });
  }
}