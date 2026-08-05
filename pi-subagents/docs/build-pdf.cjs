const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const hljs = require('highlight.js');
const puppeteer = require('puppeteer-core');
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');

// ==================== Configuration ====================
const BOOK_DIR = 'F:/Project/agent/general/pi-subagents/docs';
const OUTPUT_PDF = path.join(BOOK_DIR, 'pi-subagents-docs.pdf');
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MERMAID_JS_PATH = 'C:/Users/jingc/.workbuddy/skills/md-to-pdf/scripts/mermaid.min.js';
const HLJS_CSS_PATH = 'C:/Users/jingc/.workbuddy/binaries/node/workspace/node_modules/highlight.js/styles/github.min.css';
const TEMP_HTML = path.join(BOOK_DIR, '.temp-docs.html');

// ==================== Chapter Structure ====================
const structure = [
  { type: 'preface', file: 'pi-subagents 概览.md', title: 'pi-subagents 概览' },
  { type: 'part', title: '第一部分　架构与运行', subtitle: '从模块分层到执行流程' },
  { type: 'chapter', file: '架构与运行流程.md', title: '架构与运行流程' },
  { type: 'part', title: '第二部分　工具与配置', subtitle: 'subagent 工具与可调参数' },
  { type: 'chapter', file: '工具参考.md', title: '工具参考' },
  { type: 'chapter', file: '配置参考.md', title: '配置参考' },
];

// ==================== Configure Marked ====================
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code(token) {
      const lang = (token.lang || '').trim();
      const text = token.text;
      if (lang === 'mermaid') {
        return `<div class="mermaid">${escapeHtml(text)}</div>`;
      }
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      let highlighted;
      try {
        highlighted = hljs.highlight(text, { language }).value;
      } catch (e) {
        highlighted = escapeHtml(text);
      }
      return `<pre class="code-block"><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    }
  }
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ==================== Read & Convert ====================
function convertAll() {
  const sections = [];
  let chapterIndex = 0;

  for (const item of structure) {
    if (item.type === 'part') {
      sections.push({
        type: 'part',
        title: item.title,
        subtitle: item.subtitle || '',
      });
      console.log(`  -- PART: ${item.title}`);
      continue;
    }

    const filePath = path.join(BOOK_DIR, item.file);
    const md = fs.readFileSync(filePath, 'utf-8');
    const chapterDir = path.dirname(filePath).replace(/\\/g, '/');
    let html = marked.parse(md);
    html = html.replace(/src="images\//g, `src="file:///${chapterDir}/images/`);
    // .md 链接降级为不可点击锚点，避免 PDF 中报错
    html = html.replace(/href="([^"]+)\.md(#[^"]*)?"/g, () => `href="#" onclick="return false"`);
    chapterIndex++;
    sections.push({
      type: item.type,
      file: item.file,
      html: html,
      index: chapterIndex,
      configTitle: item.title,
    });
    console.log(`  [${chapterIndex}] ${item.type}: ${item.file}`);
  }

  return sections;
}

// ==================== Build HTML Document ====================
function buildHTML(sections) {
  const mermaidJs = fs.readFileSync(MERMAID_JS_PATH, 'utf-8');
  const hljsCss = fs.readFileSync(HLJS_CSS_PATH, 'utf-8');

  let body = '';

  // Title page
  body += `
    <div class="title-page">
      <div class="title-main">pi-subagents</div>
      <div class="title-sub">项目文档</div>
      <div class="title-desc">Pi 编程助手的子代理（subagent）扩展</div>
      <div class="title-quote">v0.34.0 · MIT License · Nico Bailon</div>
    </div>
  `;

  // Table of contents
  body += '<div class="toc-page"><h1 class="toc-title">目　录</h1><div class="toc-list">';
  let chapterNum = 0;
  for (const s of sections) {
    if (s.type === 'preface' || s.type === 'chapter') {
      chapterNum++;
      const structItem = structure.find(st => st.file === s.file && st.type === s.type);
      const configTitle = structItem?.title || s.configTitle;
      const title = extractTitle(s.html);
      const fileTitle = s.file.replace(/\.md$/, '').replace(/_/g, ' ');
      const displayTitle = configTitle || title || fileTitle;
      const anchorId = `ch-${chapterNum}`;
      const labelPrefix = s.type === 'preface' ? '序' : chapterNum.toString().padStart(2, '0');
      body += `<div class="toc-item"><span class="toc-num">${labelPrefix}</span><a href="#${anchorId}">${displayTitle}</a></div>`;
    }
  }
  body += '</div></div>';

  // Content sections
  let contentIdx = 0;
  for (const s of sections) {
    if (s.type === 'preface' || s.type === 'chapter') {
      contentIdx++;
      const anchorId = `ch-${contentIdx}`;
      body += `<div class="chapter" id="${anchorId}">${s.html}</div>`;
    } else if (s.type === 'part') {
      body += `<div class="part-page"><div class="part-title">${s.title}</div>${s.subtitle ? `<div class="part-subtitle">${s.subtitle}</div>` : ''}</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="file:///${BOOK_DIR.replace(/\\/g, '/')}/">
<style>
${hljsCss}

@page {
  size: A4;
  margin: 2.5cm 2.2cm 2.5cm 2.2cm;
}

* { box-sizing: border-box; }

body {
  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
  font-size: 11pt;
  line-height: 1.85;
  color: #2c2c2c;
  margin: 0;
  padding: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.title-page {
  text-align: center;
  padding-top: 220px;
  page-break-after: always;
}
.title-main {
  font-size: 48pt;
  font-weight: bold;
  letter-spacing: 12px;
  margin-bottom: 20px;
  color: #1a1a1a;
}
.title-sub {
  font-size: 22pt;
  color: #555;
  margin-bottom: 10px;
  letter-spacing: 2px;
}
.title-desc {
  font-size: 14pt;
  color: #888;
  margin-bottom: 60px;
}
.title-quote {
  font-size: 11pt;
  color: #aaa;
  font-style: italic;
}

.toc-page { page-break-after: always; }
.toc-title {
  text-align: center;
  font-size: 20pt;
  border-bottom: 2px solid #333;
  padding-bottom: 10px;
  margin-bottom: 30px;
}
.toc-item {
  font-size: 10.5pt;
  color: #444;
  padding: 3px 0 3px 0;
  line-height: 1.8;
  display: flex;
  align-items: baseline;
}
.toc-num {
  display: inline-block;
  width: 70px;
  color: #6c5ce7;
  font-weight: bold;
  flex-shrink: 0;
}
.toc-item a {
  color: #2c2c2c;
  text-decoration: none;
  flex-grow: 1;
}
.toc-item a:hover { color: #6c5ce7; }

.chapter { page-break-before: always; }

.part-page {
  page-break-before: always;
  page-break-after: always;
  text-align: center;
  padding-top: 280px;
  min-height: 80vh;
}
.part-title {
  font-size: 28pt;
  font-weight: bold;
  color: #1a1a1a;
  letter-spacing: 4px;
  margin-bottom: 20px;
}
.part-subtitle {
  font-size: 13pt;
  color: #888;
  letter-spacing: 1px;
  font-style: italic;
}

h1 {
  font-size: 20pt;
  font-weight: bold;
  color: #1a1a1a;
  border-bottom: 2px solid #e0e0e0;
  padding-bottom: 8px;
  margin: 0 0 24px 0;
  line-height: 1.4;
}
h2 {
  font-size: 15pt;
  font-weight: bold;
  color: #222;
  margin: 32px 0 14px 0;
  padding-left: 10px;
  border-left: 4px solid #6c5ce7;
  line-height: 1.4;
}
h3 {
  font-size: 13pt;
  font-weight: bold;
  color: #333;
  margin: 24px 0 10px 0;
  line-height: 1.4;
}
h4 {
  font-size: 11.5pt;
  font-weight: bold;
  color: #444;
  margin: 18px 0 8px 0;
  line-height: 1.4;
}
h5, h6 {
  font-size: 11pt;
  font-weight: bold;
  color: #555;
  margin: 14px 0 6px 0;
}

p {
  margin: 0 0 12px 0;
  text-align: justify;
}

pre.code-block {
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 6px;
  padding: 14px 18px;
  overflow-x: auto;
  font-size: 9pt;
  line-height: 1.55;
  margin: 14px 0;
  page-break-inside: avoid;
  white-space: pre-wrap;
  word-wrap: break-word;
}
pre.code-block code {
  background: none;
  padding: 0;
  font-size: inherit;
  border-radius: 0;
}
code {
  background: #f0f0f4;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9.5pt;
  font-family: "Cascadia Code", "Consolas", "Courier New", "Source Code Pro", monospace;
  color: #c7254e;
}

table {
  border-collapse: collapse;
  width: 100%;
  margin: 16px 0;
  font-size: 9.5pt;
  page-break-inside: avoid;
  line-height: 1.5;
}
thead { display: table-header-group; }
th {
  background: #6c5ce7;
  color: #fff;
  font-weight: bold;
  padding: 8px 12px;
  text-align: left;
  border: 1px solid #5b4bd6;
}
td {
  padding: 6px 12px;
  border: 1px solid #d0d7de;
  vertical-align: top;
}
tbody tr:nth-child(even) { background: #f9f9fb; }

blockquote {
  border-left: 4px solid #6c5ce7;
  background: #faf8ff;
  padding: 10px 18px;
  color: #555;
  margin: 14px 0;
  border-radius: 0 6px 6px 0;
  page-break-inside: avoid;
}
blockquote p { margin: 4px 0; }

ul, ol {
  padding-left: 26px;
  margin: 8px 0 12px 0;
}
li { margin: 3px 0; }

.mermaid {
  text-align: center;
  margin: 20px 0;
  page-break-inside: avoid;
}
.mermaid svg {
  max-width: 100%;
  height: auto;
}

img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 14px auto;
}

hr {
  border: none;
  border-top: 1px solid #e0e0e0;
  margin: 24px 0;
}

a { color: #6c5ce7; text-decoration: none; }

details {
  margin: 10px 0;
  padding: 8px 14px;
  background: #f9f9fb;
  border-radius: 6px;
}
summary { font-weight: bold; cursor: pointer; }

h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
pre, blockquote, table, .mermaid, details { page-break-inside: avoid; }
</style>
</head>
<body>
${body}
<script>
${mermaidJs}
</script>
<script>
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
  sequence: { useMaxWidth: true },
  gantt: { useMaxWidth: true },
  journey: { useMaxWidth: true },
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif'
});

window.__mermaidReady = false;
window.addEventListener('DOMContentLoaded', async function() {
  try {
    const elements = document.querySelectorAll('.mermaid');
    console.log('Found ' + elements.length + ' mermaid diagrams');
    if (elements.length > 0) {
      await mermaid.run({ querySelector: '.mermaid', suppressErrors: true });
    }
    console.log('Mermaid rendering complete');
  } catch(e) {
    console.error('Mermaid error:', e.message);
  }
  window.__mermaidReady = true;
});
</script>
</body>
</html>`;
}

function extractTitle(html) {
  const match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (match) {
    return match[1].replace(/<[^>]+>/g, '').trim();
  }
  return '';
}

// ==================== Generate PDF ====================
async function generatePDF(htmlFile) {
  console.log('\nLaunching Chrome...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });

  const page = await browser.newPage();

  console.log('Loading HTML...');
  await page.goto('file:///' + htmlFile.replace(/\\/g, '/'), {
    waitUntil: 'networkidle0',
    timeout: 120000,
  });

  console.log('Waiting for Mermaid rendering...');
  await page.waitForFunction('window.__mermaidReady === true', { timeout: 60000 });

  // Extra wait for layout settling
  await new Promise(r => setTimeout(r, 2000));

  // 计算每个章节的页码
  console.log('Calculating page numbers for each chapter...');
  const chapterCount = structure.filter(s => s.type === 'chapter' || s.type === 'preface').length;
  const pageInfo = await page.evaluate((chCount) => {
    const result = { chapters: {} };
    const pageHeight = 1123;
    const marginTop = 72;
    const marginBottom = 72;

    const allAnchors = {};
    for (let i = 1; i <= chCount; i++) {
      allAnchors[`ch-${i}`] = `ch-${i}`;
    }

    for (const [id, key] of Object.entries(allAnchors)) {
      const el = document.getElementById(id);
      if (el) {
        const rect = el.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const absoluteTop = rect.top + scrollTop;
        const pageNum = Math.floor((absoluteTop - marginTop) / (pageHeight - marginTop - marginBottom)) + 1;
        result.chapters[key] = Math.max(1, pageNum);
      }
    }
    return result;
  }, chapterCount);

  console.log('Chapter page numbers:', JSON.stringify(pageInfo.chapters));

  // 生成临时 PDF
  const tempPdf = OUTPUT_PDF + '.temp.pdf';
  console.log('Generating PDF...');
  await page.pdf({
    path: tempPdf,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '2.5cm',
      bottom: '2.5cm',
      left: '2.2cm',
      right: '2.2cm',
    },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `
      <div style="width: 100%; text-align: center; font-size: 8pt; color: #999; font-family: 'Microsoft YaHei', sans-serif;">
        <span class="pageNumber"></span>
      </div>
    `,
    timeout: 300000,
  });

  await browser.close();

  // 使用 pdf-lib 添加 PDF 书签
  console.log('Adding PDF bookmarks...');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(tempPdf));
  const pages = pdfDoc.getPages();

  const allBookmarks = [];
  let chapterIdx = 0;
  for (const item of structure) {
    if (item.type === 'chapter' || item.type === 'preface') {
      chapterIdx++;
      const anchorKey = `ch-${chapterIdx}`;
      const pageNum = pageInfo.chapters[anchorKey] || chapterIdx;
      const title = item.title || item.file;
      const label = item.type === 'preface' ? '序' : chapterIdx.toString().padStart(2, '0');
      allBookmarks.push({ page: pageNum, title: `${label} ${title}` });
    }
  }

  const outlineRoot = pdfDoc.context.obj({
    Type: 'Outlines',
    Count: allBookmarks.length,
  });
  const outlineRootRef = pdfDoc.context.register(outlineRoot);

  const bookmarkRefs = [];
  for (let i = 0; i < allBookmarks.length; i++) {
    const bm = allBookmarks[i];
    const pageIndex = Math.min(bm.page - 1, pages.length - 1);
    const page = pages[pageIndex];

    const bookmark = pdfDoc.context.obj({
      Title: PDFString.of(bm.title),
      Dest: [page.ref, 'XYZ', null, null, null],
      Parent: outlineRootRef,
      Count: 0,
    });

    const bookmarkRef = pdfDoc.context.register(bookmark);
    bookmarkRefs.push(bookmarkRef);
  }

  if (bookmarkRefs.length > 0) {
    outlineRoot.set(PDFName.of('First'), bookmarkRefs[0]);
    outlineRoot.set(PDFName.of('Last'), bookmarkRefs[bookmarkRefs.length - 1]);
  }

  pdfDoc.catalog.set(PDFName.of('Outlines'), outlineRootRef);

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(OUTPUT_PDF, pdfBytes);

  try {
    fs.unlinkSync(tempPdf);
  } catch (e) {
    // ignore
  }

  console.log('PDF generated with bookmarks: ' + OUTPUT_PDF);
}

// ==================== Main ====================
async function main() {
  console.log('=== MD to PDF Converter (pi-subagents) ===');
  console.log('Book directory: ' + BOOK_DIR);
  console.log('\nReading and converting markdown files...');
  const sections = convertAll();
  console.log(`\nTotal: ${sections.length} sections`);

  console.log('\nBuilding HTML document...');
  const html = buildHTML(sections);
  fs.writeFileSync(TEMP_HTML, html, 'utf-8');
  console.log('Temp HTML: ' + TEMP_HTML + ' (' + (html.length / 1024 / 1024).toFixed(2) + ' MB)');

  console.log('\nGenerating PDF...');
  await generatePDF(TEMP_HTML);

  // Cleanup
  try {
    fs.unlinkSync(TEMP_HTML);
    console.log('Temp file cleaned up.');
  } catch (e) {
    // ignore
  }

  const stats = fs.statSync(OUTPUT_PDF);
  console.log('\n=== Done! ===');
  console.log('Output: ' + OUTPUT_PDF);
  console.log('Size: ' + (stats.size / 1024 / 1024).toFixed(2) + ' MB');
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
