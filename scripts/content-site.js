const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ARTICLE_DIR = path.join(ROOT, "content", "articles");
const SITE_URL = "https://garrettcountyadventures.com";
const ARTICLE_ORDER = [
  "/things-to-do-garrett-county.html",
  "/things-to-do-near-deep-creek-besides-the-lake.html",
  "/first-time-deep-creek.html",
  "/deep-creek-without-a-boat.html",
  "/garrett-county-with-kids.html",
  "/rainy-day-deep-creek.html",
  "/swallow-falls.html",
  "/oakland.html",
  "/simon-pearce-glassblowing.html",
  "/spruce-forest-artisan-village.html",
  "/englanders-oakland.html",
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function isSafeHref(value) {
  return /^(https?:\/\/|mailto:)/i.test(value) ||
    (/^(?!\/\/)(?![a-z][a-z\d+.-]*:)[^\s"'<>]+$/i.test(value) &&
      (value.startsWith("/") || value.startsWith("#") || !value.startsWith("\\")));
}

function field(frontmatter, name) {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
  if (!match) return "";
  const value = match[1].trim();
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function records(frontmatter, sectionName) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${sectionName}:\\s*$`).test(line));
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:\s*/.test(line)) break;
    const entry = line.match(/^\s*-\s+([a-z_]+):\s*(.*)$/);
    if (entry) {
      items.push({ [entry[1]]: entry[2].replace(/^(["'])(.*)\1$/, "$2") });
      continue;
    }
    const property = line.match(/^\s+([a-z_]+):\s*(.*)$/);
    if (property && items.length) items[items.length - 1][property[1]] = property[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return items;
}

function inlineMarkdown(value) {
  let html = escapeHtml(value.replace(/&amp;/g, "&"));
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    const safeUrl = isSafeHref(url) ? url : "#";
    const external = /^https?:/.test(safeUrl) ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(safeUrl)}"${external}>${label}</a>`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  return html;
}

function headingSlug(value) {
  const plain = value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "and").replace(/&[^;]+;/g, "");
  return plain.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

const SAFE_HTML_TAGS = new Set("a article aside blockquote br code dd details div dl dt em figcaption figure h2 h3 h4 h5 h6 hr li ol p section small span strong sub summary sup table tbody td th thead tr ul".split(" "));
const SAFE_HTML_VOID_TAGS = new Set(["br", "hr"]);

function sanitizeHtml(html) {
  const safeBlocks = html.replace(/<(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  return safeBlocks.replace(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)(\s[^<>]*?)?>/gi, (tag, name, rawAttributes = "") => {
    if (!name) return "";
    const tagName = name.toLowerCase();
    if (!SAFE_HTML_TAGS.has(tagName)) return "";
    if (tag.startsWith("</")) return SAFE_HTML_VOID_TAGS.has(tagName) ? "" : `</${tagName}>`;
    const attributes = [];
    const matcher = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = matcher.exec(rawAttributes))) {
      const key = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      if (!(key === "class" || key === "id" || key === "role" || key === "scope" || key === "colspan" || key === "rowspan" || key === "target" || key === "rel" || key.startsWith("aria-"))) continue;
      if (key === "target" && value !== "_blank" && value !== "_self") continue;
      attributes.push(`${key}="${escapeHtml(value)}"`);
    }
    const href = rawAttributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    if (tagName === "a" && href) {
      const value = href[1] ?? href[2] ?? href[3] ?? "";
      if (isSafeHref(value)) attributes.push(`href="${escapeHtml(value)}"`);
    }
    if (attributes.includes('target="_blank"') && !attributes.some((attribute) => attribute.startsWith("rel="))) attributes.push('rel="noopener noreferrer"');
    return `<${tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  });
}

function renderMarkdown(markdown) {
  const source = markdown
    .replace(/\{%\s*photo\b[\s\S]*?%\}/g, "")
    .replace(/^\s*\[PHOTO:[^\]]*\]\s*$/gm, "")
    .trim();
  const lines = source.split(/\r?\n/);
  const output = [];
  const headingCounts = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      const title = inlineMarkdown(heading[2]);
      const baseSlug = headingSlug(title);
      const count = (headingCounts.get(baseSlug) || 0) + 1;
      headingCounts.set(baseSlug, count);
      const id = count === 1 ? baseSlug : `${baseSlug}-${count}`;
      output.push(`<h${level} id="${id}">${title}</h${level}>`);
      i++; continue;
    }
    if (/^<\/?(p|div|figure|table|ul|ol|blockquote|details|section|aside|hr)\b/i.test(line)) {
      const block = [line];
      i++;
      while (i < lines.length && lines[i].trim()) block.push(lines[i++].trim());
      output.push(block.join("\n"));
      continue;
    }
    if (/^([-*_])\1\1+\s*$/.test(line)) { output.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      output.push(`<blockquote><p>${inlineMarkdown(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    const listMatch = line.match(/^\s*([-*+]\s+|\d+[.)]\s+)/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (i < lines.length) {
        const item = lines[i].trim().match(/^([-*+]\s+|\d+[.)]\s+)(.+)$/);
        if (!item || (/^\d/.test(item[1]) !== ordered)) break;
        items.push(`<li>${inlineMarkdown(item[2])}</li>`);
        i++;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    if (line.startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i++].trim().split("|").slice(1, -1).map((cell) => cell.trim()));
      }
      const header = rows.shift() || [];
      rows.shift();
      output.push(`<table><thead><tr>${header.map((cell) => `<th scope="col">${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^(#{1,6}\s|[-*_]{3,}\s*$|>\s?|\s*([-*+]\s+|\d+[.)]\s+)|<\/?(p|div|figure|table|ul|ol|blockquote|details|section|aside|hr)\b)/.test(lines[i])) {
      paragraph.push(lines[i++].trim());
    }
    output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return sanitizeHtml(output.join("\n"));
}

function readArticles() {
  return fs.readdirSync(ARTICLE_DIR).filter((name) => name.endsWith(".md")).map((name) => {
    const source = fs.readFileSync(path.join(ARTICLE_DIR, name), "utf8");
    const sections = source.split(/^---\s*$/m);
    if (sections.length < 3) throw new Error(`Missing YAML front matter: ${name}`);
    const frontmatter = sections[1];
    const body = sections.slice(2).join("---").trim();
    const title = field(frontmatter, "title");
    const description = field(frontmatter, "description") || field(frontmatter, "dek");
    const permalink = field(frontmatter, "permalink");
    const lastChecked = field(frontmatter, "last_checked");
    if (!title || !description || !/^\/[\w-]+\.html$/.test(permalink)) {
      throw new Error(`Article needs title, description, and a root .html permalink: ${name}`);
    }
    return {
      title, description, permalink, lastChecked,
      related: records(frontmatter, "related"), sources: records(frontmatter, "sources"),
      body: renderMarkdown(body),
    };
  }).sort((a, b) => {
    const aOrder = ARTICLE_ORDER.indexOf(a.permalink);
    const bOrder = ARTICLE_ORDER.indexOf(b.permalink);
    return (aOrder < 0 ? Number.MAX_SAFE_INTEGER : aOrder) - (bOrder < 0 ? Number.MAX_SAFE_INTEGER : bOrder) || a.title.localeCompare(b.title);
  });
}

function articlePage(article) {
  const canonical = `${SITE_URL}${article.permalink}`;
  const checkedDate = new Date(article.lastChecked);
  const checkedIso = Number.isNaN(checkedDate.getTime()) ? "" : checkedDate.toISOString().slice(0, 10);
  const structuredData = {
    "@context": "https://schema.org", "@type": "Article", headline: article.title,
    description: article.description, mainEntityOfPage: canonical,
    author: { "@type": "Organization", name: "Garrett County Adventures" },
    publisher: { "@type": "Organization", name: "Garrett County Adventures", url: SITE_URL },
    inLanguage: "en-US",
  };
  if (checkedIso) structuredData.dateModified = checkedIso;
  const related = article.related.filter((item) => item.title && /^[\w-]+\.html$/.test(item.url || ""));
  const relatedHtml = related.length ? `<aside class="related-guides"><h2>Related Garrett County guides</h2>${related.map((item) => `<a class="related-guide" href="./${escapeHtml(item.url)}"><strong>${escapeHtml(item.title)}</strong>${item.description ? `<span>${escapeHtml(item.description)}</span>` : ""}</a>`).join("")}</aside>` : "";
  const sources = article.sources.filter((item) => item.label);
  const sourcesHtml = sources.length ? `<details class="source-list"><summary>Sources and planning links</summary><ul>${sources.map((item) => `<li>${/^https:\/\//.test(item.url || "") ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>` : escapeHtml(item.label)}</li>`).join("")}</ul><p>Hours, access, and seasonal activities can change. Check current details with the listed organization before your visit.</p></details>` : "";
  const sections = [...article.body.matchAll(/<h3 id="([^"]+)">([\s\S]*?)<\/h3>/g)];
  const contentsHtml = sections.length > 2 ? `<details class="article-contents"><summary>In this guide <span>${sections.length} sections</span></summary><nav aria-label="On this page">${sections.map((match) => `<a href="#${escapeHtml(match[1])}">${match[2]}</a>`).join("")}</nav></details>` : "";
  const wordCount = article.body.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.ceil(wordCount / 220));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#203a31">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="${escapeHtml(article.description)}">
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="./site.css">
  <link rel="manifest" href="./manifest.webmanifest">
  <link rel="icon" href="./images/gcadv-logo.png" type="image/png">
  <script defer src="./site.js"></script>
  <title>${escapeHtml(article.title)}</title>
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Garrett County Adventures">
  <meta property="og:title" content="${escapeHtml(article.title)}">
  <meta property="og:description" content="${escapeHtml(article.description)}">
  <meta property="og:url" content="${canonical}">
  <script type="application/ld+json">${JSON.stringify(structuredData)}</script>
</head>
<body class="editorial-page">
  <header class="editorial-header"><a class="editorial-brand" href="./" aria-label="Garrett County Adventures home">Garrett County Adventures</a><nav aria-label="Main navigation"><a href="./#trip-guides">Trip guides</a><a href="./#about-gcadv">About</a></nav></header>
  <main class="article-main">
    <header class="article-hero"><div class="article-hero-inner"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="./">Home</a><span aria-hidden="true">/</span><a href="./#trip-guides">Garrett County Guides</a><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(article.title)}</span></nav><p class="eyebrow">A GARRETT COUNTY FIELD GUIDE</p><h1>${escapeHtml(article.title)}</h1><p class="article-dek">${escapeHtml(article.description)}</p><p class="article-meta"><span>${readMinutes} MIN READ</span>${checkedIso ? `<span>UPDATED <time datetime="${checkedIso}">${escapeHtml(article.lastChecked)}</time></span>` : "<span>WESTERN MARYLAND</span>"}</p></div></header>
  <div class="article-layout${contentsHtml ? "" : " no-contents"}">${contentsHtml}<article class="guide-article">
      <div class="article-body">${article.body}</div>
      ${relatedHtml}
      ${sourcesHtml}
      <aside class="article-install"><h2>Keep planning wherever you go</h2><p>Add the guides and saved trip details to your home screen. Some guide and trail information is available offline; map tiles need an internet connection.</p><button id="install-app" class="button button-primary" type="button">Install the app</button><details class="install-help"><summary>How to add it on this device</summary><p>On Windows, use the Install app button in Chrome or Edge’s address bar or menu. On Mac in Safari, choose File &gt; Add to Dock. On iPhone or iPad, open this page in Safari, tap Share, then choose Add to Home Screen. On Android, open your browser menu and choose Install app or Add to Home Screen.</p></details><p id="install-status" class="install-status" role="status"></p></aside>
    </article>
    <footer class="editorial-footer"><a href="./#trip-guides">Browse all trip guides</a><span>Built with &lt;3 by <a href="https://mnix.dev">Mikey Nichols</a></span><a href="./explore.html">Open the adventure map</a></footer>
  </main>
</body>
</html>`;
}

function buildSite() {
  const articles = readArticles();
  const cardDesigns = {
    "/things-to-do-garrett-county.html": ["ridge", "⌁", "local-finds-background.webp"],
    "/things-to-do-near-deep-creek-besides-the-lake.html": ["water", "≈", "herrington-manor.webp"],
    "/first-time-deep-creek.html": ["compass", "✧", "hoye-crest.webp"],
    "/deep-creek-without-a-boat.html": ["water", "◌"],
    "/garrett-county-with-kids.html": ["wildlife", "❋", "deer-sky-valley.webp"],
    "/rainy-day-deep-creek.html": ["rain", "☂"],
    "/swallow-falls.html": ["falls", "≋", "install-stream.webp"],
    "/simon-pearce-glassblowing.html": ["craft", "✦"],
    "/spruce-forest-artisan-village.html": ["forest", "❧"],
    "/englanders-oakland.html": ["town", "⌂"],
    "/oakland.html": ["rail", "↝"],
  };
  const card = (article, label) => {
    const [theme, mark, photo] = cardDesigns[article.permalink] || ["forest", "✧"];
    const title = escapeHtml(article.title);
    const description = escapeHtml(article.description);
    const href = `.${article.permalink}`;
    const artMark = photo ? "" : `<span>${mark}</span>`;
    return `<article class="guide-card guide-card--${theme}${photo ? " guide-card--photo" : ""}"${photo ? ` style="--guide-card-image:url('/images/${photo}')"` : ""}><div class="guide-card-inner"><div class="guide-card-side guide-card-front"><div class="guide-card-art" aria-hidden="true">${artMark}</div><div class="guide-card-copy"><p class="guide-card-label">${label}</p><h3>${title}</h3><p>${description}</p><a class="guide-card-front-link" href="${href}">Read the guide <span aria-hidden="true">→</span></a></div></div><div class="guide-card-side guide-card-back"><p class="guide-card-label">${label}</p><h3>${title}</h3><p>${description}</p><a class="guide-card-link" href="${href}">Read the guide <span aria-hidden="true">→</span></a></div></div></article>`;
  };
  const planningSlugs = new Set([
    "/things-to-do-garrett-county.html", "/things-to-do-near-deep-creek-besides-the-lake.html",
    "/first-time-deep-creek.html", "/deep-creek-without-a-boat.html",
    "/garrett-county-with-kids.html", "/rainy-day-deep-creek.html",
  ]);
  const planningCards = articles.filter((article) => planningSlugs.has(article.permalink)).map((article) => card(article, "PLAN YOUR TRIP")).join("\n");
  const localCards = articles.filter((article) => !planningSlugs.has(article.permalink)).map((article) => card(article, "LOCAL DISCOVERY")).join("\n");
  const homeCards = `${planningCards}\n${localCards}`;
  const pages = articles.map((article) => ({ name: article.permalink.slice(1), source: articlePage(article) }));
  pages.push({ name: "sitemap.xml", source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    `${SITE_URL}/`, `${SITE_URL}/explore.html`, ...articles.map((article) => `${SITE_URL}${article.permalink}`),
  ].map((url) => `  <url><loc>${escapeHtml(url)}</loc></url>`).join("\n")}\n</urlset>\n` });
  pages.push({ name: "robots.txt", source: `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n` });
  return { articles, homeCards, planningCards, localCards, pages };
}

module.exports = { buildSite };
