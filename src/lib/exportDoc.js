/*
 * lib/exportDoc.js — turns one or more captured records into a clean,
 * "save this conversation" document: prompt, full answer (with ChatGPT's
 * inline citations rendered as numbered footnotes linked to the matching
 * source), then organized sections for sources / fan-out queries / brand
 * mentions / products / places / entities.
 *
 * Two consumers:
 *  - panel.js: direct ".html" file download (one conversation or a bulk,
 *    multi-section document from Saved Conversations).
 *  - ui/export.html: renders the same HTML into a real page, then the user
 *    hits Ctrl+P / the page's Print button and saves as PDF via the browser's
 *    native print engine — no vendored PDF library, no remote code, prints
 *    with real (selectable) text.
 *
 * ChatGPT vs Gemini: ChatGPT embeds inline citation markers in the answer
 * text (see adapters/chatgpt.js tokenizeAnswerMarkup) which we can resolve to
 * numbered footnotes. Gemini's web app does not expose inline citation
 * positions at all — its answer is already plain text, so a Gemini export
 * gets the full answer plus a separate, unnumbered source list. This is a
 * real platform limitation (documented in project memory), not a bug here.
 */

import { tokenizeAnswerMarkup } from "../adapters/chatgpt.js";
import { ANSWER_TEXT_CAP } from "../schema.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Page titles/snippets scraped by ChatGPT sometimes arrive with un-decoded
// HTML entities baked into the text (e.g. a title literally containing the 6
// characters "&amp;" instead of "&", from the source page's raw <title> tag).
// Decode the common ones before esc() re-escapes them, or the export would
// show a double-escaped "&amp;amp;" instead of a clean "&".
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}
function escText(s) {
  return esc(decodeEntities(s));
}

// Brand-mention passages are short raw excerpts (see cleanPassage in
// adapters/chatgpt.js) — PUA markers are already cleaned, but markdown table
// syntax around them isn't, since that function only ever aimed to strip the
// invisible marker junk. This appendix list isn't full-answer markdown
// rendering like the main body, so just flatten the noise for readability.
function stripMarkdownNoise(s) {
  return String(s ?? "")
    .replace(/\*\*/g, "")
    .replace(/\|/g, " ")
    .replace(/-{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtDate(ts) {
  if (!ts) return "Unknown date";
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch (_) {
    return String(ts);
  }
}

/* ---------- minimal markdown -> HTML (headings, bold, bullets, tables, paragraphs) ----------
 * `raw` must already be safe to HTML-escape wholesale — any trusted inline
 * HTML (footnote links, bolded entity/product names) is passed via
 * `placeholders` and spliced back in after escaping + block parsing, so
 * nothing we generate ourselves gets double-escaped or mangled by the
 * markdown pass, and nothing from the answer text can break out of it.
 */
function markdownToHtml(raw, placeholders) {
  let text = esc(raw).replace(/\r\n?/g, "\n");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  // Underscore emphasis (ChatGPT sometimes uses _x_ instead of *x*) — require a
  // non-word char or line start/end just outside so snake_case_words aren't touched.
  text = text.replace(/(^|[^\w])_([^_\n]+)_($|[^\w])/g, "$1<em>$2</em>$3");

  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length + 1, 6); // shift down one so H1 stays the doc title
      blocks.push(`<h${level}>${heading[2]}</h${level}>`);
      i++;
      continue;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      flushPara();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim());
        i++;
      }
      // drop a markdown separator row like |---|---|
      const dataRows = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      if (dataRows.length) {
        const cellsOf = (r) => r.slice(1, -1).split("|").map((c) => c.trim());
        const [head, ...body] = dataRows;
        let table = "<table><thead><tr>";
        table += cellsOf(head).map((c) => `<th>${c}</th>`).join("");
        table += "</tr></thead><tbody>";
        for (const r of body) table += "<tr>" + cellsOf(r).map((c) => `<td>${c}</td>`).join("") + "</tr>";
        table += "</tbody></table>";
        blocks.push(table);
      }
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(`<li>${lines[i].trim().replace(/^[-*]\s+/, "")}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${lines[i].trim().replace(/^\d+\.\s+/, "")}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    para.push(trimmed);
    i++;
  }
  flushPara();

  let html = blocks.join("\n");
  if (placeholders && placeholders.length) {
    html = html.replace(/ P(\d+) /g, (_, n) => placeholders[Number(n)] ?? "");
  }
  return html;
}

/* ---------- ChatGPT: inline citation markers -> numbered footnotes ---------- */
function renderChatGptAnswer(record) {
  const segs = tokenizeAnswerMarkup(record.answerText || "");
  const markerToSource = new Map();
  for (const s of record.sources || []) {
    for (const id of (s.platformSpecific && s.platformSpecific.markerIds) || []) {
      markerToSource.set(id, s);
    }
  }

  const footnotes = []; // [{ n, source }]
  const footnoteBySourceUrl = new Map();
  let unresolvedCitations = false;

  let raw = "";
  const placeholders = [];
  const place = (html) => {
    const tok = ` P${placeholders.length} `;
    placeholders.push(html);
    return tok;
  };

  for (const seg of segs) {
    if (seg.type === "text") {
      raw += seg.value;
    } else if (seg.type === "entity" || seg.type === "product") {
      raw += place(`<strong>${esc(seg.name)}</strong>`);
    } else if (seg.type === "cite") {
      const nums = [];
      for (const id of seg.ids) {
        const src = markerToSource.get(id);
        if (!src) {
          unresolvedCitations = true;
          continue;
        }
        let n = footnoteBySourceUrl.get(src.url);
        if (!n) {
          n = footnotes.length + 1;
          footnoteBySourceUrl.set(src.url, n);
          footnotes.push({ n, source: src });
        }
        if (!nums.includes(n)) nums.push(n);
      }
      if (nums.length) {
        raw += place(nums.map((n) => `<sup class="fn"><a href="#fn-${record.captureId}-${n}">[${n}]</a></sup>`).join(""));
      }
    }
    // productsBulk / map: carousel metadata, nothing meaningful inline —
    // those items already appear in the Products / Places sections below.
  }

  return { bodyHtml: markdownToHtml(raw, placeholders), footnotes, unresolvedCitations };
}

/* ---------- Gemini: plain answer text, no inline citation positions ---------- */
function renderGeminiAnswer(record) {
  return { bodyHtml: markdownToHtml(record.answerText || "", []), footnotes: [], unresolvedCitations: false };
}

/* ---------- build one conversation's export model ---------- */
export function buildExportModel(record) {
  // Defense-in-depth: light records (as returned by the "get-records" list
  // endpoint) have answerText stripped for popup speed — building a document
  // from one silently produces an empty, otherwise-fine-looking export. Both
  // current callers (panel.js exportRecordsAsHtml, ui/export.js) always
  // fetch the full record via "get-record" first, so this should never fire;
  // it's here so a future caller mistake fails loudly instead of shipping a
  // hollow PDF.
  if (!record.answerText && (record.answerChars || 0) > 0) {
    console.warn(
      "buildExportModel: record has answerChars but no answerText — pass the FULL record (get-record), not a light list row (get-records).",
      record.captureId
    );
  }
  const isChatGpt = record.platform === "chatgpt";
  const { bodyHtml, footnotes, unresolvedCitations } = isChatGpt ? renderChatGptAnswer(record) : renderGeminiAnswer(record);

  return {
    captureId: record.captureId,
    platform: record.platform,
    model: record.model || (isChatGpt ? "ChatGPT" : "Gemini"),
    prompt: record.userPrompt || "(no prompt captured)",
    title: record.generatedTitle || null,
    capturedAt: record.capturedAt,
    bodyHtml,
    footnotes,
    hasInlineCitations: isChatGpt,
    unresolvedCitations, // some cite markers pointed at a source not in this record — old capture, pre-markerIds
    truncated: (record.answerText || "").length >= ANSWER_TEXT_CAP,
    sources: record.sources || [],
    fanout: record.fanout || { search: [], shopping: [], image: [] },
    brandMentions: record.brandMentions || [],
    products: record.products || [],
    places: record.places || [],
    entities: record.entities || [],
    // Image URLs are hosted externally (images.openai.com / merchant CDNs),
    // not something this extension fetches — the exported document just
    // references them like any normal <img src>, so this works both in the
    // extension's export.html page (MV3's default CSP doesn't restrict
    // img-src) and in the plain downloaded .html file. They CAN'T be inlined
    // as self-contained data: URIs without a host_permissions change, so old
    // captures may show a broken image if the CDN URL has since expired —
    // handled with a sized placeholder + onerror fallback, not a hard failure.
    images: record.images || [],
    reasoning: (record.platformSpecific && record.platformSpecific.reasoning) || null,
  };
}

/* ---------- section renderers shared by single + bulk documents ---------- */
function renderSourcesSection(model) {
  if (model.hasInlineCitations && model.footnotes.length) {
    const rows = model.footnotes
      .map(
        ({ n, source }) => `<li id="fn-${model.captureId}-${n}"><span class="fn-num">[${n}]</span>
          <a href="${esc(source.url)}" target="_blank" rel="noreferrer">${escText(source.title || source.domain)}</a>
          <span class="muted"> — ${escText(source.domain)}</span>${source.snippet ? `<div class="snippet">${escText(source.snippet)}</div>` : ""}
        </li>`
      )
      .join("\n");
    const citedUrls = new Set(model.footnotes.map((f) => f.source.url));
    const others = model.sources.filter((s) => !citedUrls.has(s.url));
    const othersHtml = others.length
      ? `<h4>Also fetched (not cited in the answer)</h4><ul class="src-list muted">${others
          .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${escText(s.title || s.domain)}</a> — ${escText(s.domain)}</li>`)
          .join("")}</ul>`
      : "";
    return `<h3>Sources</h3><ol class="src-list">${rows}</ol>${othersHtml}`;
  }
  if (!model.sources.length) return "";
  // No resolved footnotes — either Gemini (no inline citation positions at
  // all) or a ChatGPT capture that predates markerIds. Mirror the tight
  // footnote-branch layout instead of a full snippet per source: a snippet
  // under EVERY fetched result reads as a wall of text once there are more
  // than a handful (a real export with 15 sources made this obvious) — show
  // the fuller detail only for what was actually cited, a compact line for
  // the rest.
  const note = model.platform === "gemini"
    ? `<p class="muted">Gemini doesn't expose where in the answer each source was used, so citations aren't numbered inline — here's everything it drew on.</p>`
    : `<p class="muted">Citation markers in this answer couldn't be matched to a source (capture predates citation-source linking) — sources are listed but not numbered inline.</p>`;
  const cited = model.sources.filter((s) => s.outcome === "cited");
  const rest = model.sources.filter((s) => s.outcome !== "cited");
  const detailed = (s) =>
    `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${escText(s.title || s.domain)}</a>
      <span class="muted"> — ${escText(s.domain)}</span>${s.snippet ? `<div class="snippet">${escText(s.snippet)}</div>` : ""}
    </li>`;
  const compact = (s) =>
    `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${escText(s.title || s.domain)}</a> — ${escText(s.domain)}</li>`;
  const citedHtml = cited.length ? `<ol class="src-list">${cited.map(detailed).join("\n")}</ol>` : "";
  const restLabel = cited.length ? "Also fetched (not cited in the answer)" : "Fetched";
  const restHtml = rest.length
    ? `${cited.length ? `<h4>${restLabel}</h4>` : ""}<ul class="src-list muted">${rest.map(compact).join("")}</ul>`
    : "";
  return `<h3>Sources</h3>${note}${citedHtml}${restHtml}`;
}

function renderFanoutSection(model) {
  const { search, shopping, image } = model.fanout;
  if (!search.length && !shopping.length && !image.length) return "";
  const list = (label, arr) =>
    arr.length ? `<h4>${label}</h4><ul>${arr.map((q) => `<li>${escText(q.query)}</li>`).join("")}</ul>` : "";
  return `<h3>Fan-out queries</h3>${list("Search", search)}${list("Shopping", shopping)}${list("Image", image)}`;
}

function renderBrandsSection(model) {
  if (!model.brandMentions.length) return "";
  const rows = model.brandMentions
    .map((b) => {
      const badge = b.count > 0 ? `${b.count} mention${b.count === 1 ? "" : "s"}` : "Shown, not named";
      const passage = stripMarkdownNoise((b.passages && b.passages[0]) || b.passage);
      return `<li><strong>${escText(b.brand)}</strong> <span class="muted">— ${badge}</span>${
        passage ? `<div class="snippet">"${escText(passage)}"</div>` : ""
      }</li>`;
    })
    .join("\n");
  return `<h3>Brand &amp; entity mentions</h3><ul class="brand-list">${rows}</ul>`;
}

// A broken/expired external image degrades to just hiding the <img> (via
// onerror) rather than showing the browser's broken-image icon — the sized
// container keeps the layout stable either way.
function imgTag(url, alt) {
  if (!url) return "";
  return `<img class="thumb" src="${esc(url)}" alt="${escText(alt || "")}" loading="lazy" onerror="this.style.display='none'">`;
}

function renderProductsSection(model) {
  if (!model.products.length) return "";
  const rows = model.products
    .map((p) => {
      const bits = [p.price, p.merchant, p.rating ? `${p.rating}★` : null].filter(Boolean).join(" · ");
      return `<li class="with-thumb">${imgTag(p.image, p.name)}<div><strong>${escText(p.name)}</strong>${
        bits ? `<div class="muted">${escText(bits)}</div>` : ""
      }</div></li>`;
    })
    .join("\n");
  return `<h3>Products shown</h3><ul class="thumb-list">${rows}</ul>`;
}

function renderImagesSection(model) {
  if (!model.images.length) return "";
  const items = model.images
    .map(
      (img) =>
        `<figure>${imgTag(img.url, img.title)}<figcaption>${escText(img.title || "")}${img.price ? ` — ${escText(img.price)}` : ""}</figcaption></figure>`
    )
    .join("\n");
  return `<h3>Images</h3><div class="img-grid">${items}</div>`;
}

function renderPlacesSection(model) {
  if (!model.places.length) return "";
  const rows = model.places
    .map((p) => {
      const bits = [p.category, p.rating ? `${p.rating}★${p.reviews ? ` (${p.reviews})` : ""}` : null, p.priceRange]
        .filter(Boolean)
        .join(" · ");
      return `<li><strong>${escText(p.name)}</strong>${bits ? ` <span class="muted">— ${escText(bits)}</span>` : ""}${
        p.address ? `<div class="snippet">${escText(p.address)}</div>` : ""
      }</li>`;
    })
    .join("\n");
  return `<h3>Local businesses shown</h3><ul>${rows}</ul>`;
}

function renderReasoningSection(model) {
  if (!model.reasoning) return "";
  return `<h3>Model reasoning trace</h3><p class="muted small">${escText(model.reasoning).replace(/\n/g, "<br>")}</p>`;
}

function renderOneConversation(model, { anchorId, showPrompt = true } = {}) {
  const flags = [];
  if (model.unresolvedCitations) {
    flags.push(
      `<p class="notice">Some citation markers in this answer couldn't be matched to a source — this capture predates citation-source linking. Re-run the prompt (or "↻ Reprocess all captures" in the About tab) to fix this for future exports.</p>`
    );
  }
  if (model.truncated) {
    flags.push(`<p class="notice">This answer was very long and is capped at ${ANSWER_TEXT_CAP.toLocaleString()} characters.</p>`);
  }

  return `
    <section class="conversation" id="${anchorId || `c-${model.captureId}`}">
      <header class="conv-header">
        <div class="conv-meta">${esc(model.model)} · ${esc(fmtDate(model.capturedAt))}${model.title ? ` · ${esc(model.title)}` : ""}</div>
        ${showPrompt ? `<h2 class="prompt">${esc(model.prompt)}</h2>` : ""}
      </header>
      ${flags.join("")}
      <div class="answer">${model.bodyHtml}</div>
      ${renderSourcesSection(model)}
      ${renderFanoutSection(model)}
      ${renderBrandsSection(model)}
      ${renderProductsSection(model)}
      ${renderImagesSection(model)}
      ${renderPlacesSection(model)}
      ${renderReasoningSection(model)}
    </section>`;
}

const DOC_STYLE = `
  /* Deliberately light-only, regardless of OS/browser dark mode. This
     document is meant to be printed, saved as PDF, or shared — a report that
     silently comes out with a near-black page background because the
     recipient's system is in dark mode is a bug, not a feature (and wastes
     ink if actually printed on paper). Earlier this followed
     prefers-color-scheme, which is exactly what produced the black-background
     PDFs/HTML exports. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    line-height: 1.55; color: #1a1a1a; background: #fff; margin: 0;
    padding: 32px 24px 64px; max-width: 820px; margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2.prompt { font-size: 19px; margin: 4px 0 12px; line-height: 1.35; }
  h3 { font-size: 15px; margin: 28px 0 10px; padding-top: 14px; border-top: 1px solid #e3e3e3; }
  h4 { font-size: 13px; margin: 14px 0 6px; color: #444; }
  .doc-header { margin-bottom: 28px; position: relative; }
  .doc-header .sub { color: #666; font-size: 13px; }
  .conversation { margin-bottom: 40px; }
  .conversation + .conversation { padding-top: 32px; border-top: 2px solid #ddd; }
  .conv-meta { font-size: 12px; color: #777; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
  .answer { font-size: 14.5px; }
  .answer p { margin: 0 0 12px; }
  /* Answer-internal markdown headings (###, ##...) need their own hierarchy —
     they used to fall through to the document's h3/h4 rules, which are sized
     for SECTION labels (15px/13px), smaller than the 14.5px body text they'd
     be introducing inside .answer. Inverted visual hierarchy read as
     "unstructured" in a real export. These override by specificity, not by
     shifting heading levels, so the section h3's border-top rule stays intact. */
  .answer h2, .answer h3, .answer h4, .answer h5, .answer h6 {
    border-top: none; padding-top: 0; margin: 18px 0 8px; color: inherit; line-height: 1.3;
  }
  .answer h2 { font-size: 19px; }
  .answer h3 { font-size: 17px; }
  .answer h4 { font-size: 15.5px; }
  .answer h5, .answer h6 { font-size: 14.5px; }
  .answer table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13.5px; }
  .answer th, .answer td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  .answer th { background: #f5f5f5; }
  .answer ul, .answer ol { margin: 0 0 12px; padding-left: 22px; }
  tr { break-inside: avoid; } /* don't split a table row across a page boundary */
  .fn a { text-decoration: none; color: #0b5fff; font-size: 0.75em; }
  ol.src-list, ul.src-list { list-style: none; padding-left: 0; font-size: 13.5px; }
  ol.src-list li, ul.src-list li { margin-bottom: 10px; padding-left: 4px; }
  .fn-num { color: #0b5fff; font-weight: 600; margin-right: 4px; }
  ul.brand-list { list-style: none; padding-left: 0; font-size: 13.5px; }
  ul.brand-list li { margin-bottom: 8px; }
  .snippet { color: #555; font-size: 12.5px; margin-top: 2px; }
  .muted { color: #777; }
  .small { font-size: 12.5px; }
  .notice { background: #fff8e1; border: 1px solid #f0d878; border-radius: 6px; padding: 8px 12px; font-size: 12.5px; color: #6b5900; margin: 10px 0; }
  .toc { margin-bottom: 32px; padding: 16px; background: #f7f7f7; border-radius: 8px; }
  .toc h3 { margin-top: 0; border-top: none; padding-top: 0; }
  .toc ol { padding-left: 20px; }
  .toc a { color: #0b5fff; text-decoration: none; }
  .print-bar { margin-bottom: 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .print-bar button {
    font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc;
    background: #fff; cursor: pointer;
  }
  /* Thumbnails (Products) and full images (Images section). External URLs
     (images.openai.com / merchant CDNs) — a sized, bordered box keeps the
     layout stable even if one 404s (onerror hides the broken <img>). */
  ul.thumb-list { list-style: none; padding-left: 0; font-size: 13.5px; }
  ul.thumb-list li.with-thumb { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 10px; }
  .thumb { width: 56px; height: 56px; object-fit: contain; border: 1px solid #e3e3e3; border-radius: 6px; background: #fafafa; flex-shrink: 0; }
  .img-grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .img-grid figure { margin: 0; width: 130px; }
  .img-grid img { width: 130px; height: 130px; object-fit: contain; border: 1px solid #e3e3e3; border-radius: 6px; background: #fafafa; }
  .img-grid figcaption { font-size: 11.5px; color: #666; margin-top: 4px; }
  /* Diagonal, low-opacity brand watermark. Fixed-position elements are one
     of the few things Chrome's print engine repeats on EVERY printed page
     (unlike normal document flow) — this is what makes it show on all 4
     pages of a multi-page PDF, not just the first. pointer-events:none keeps
     it from intercepting clicks/selection on the real content underneath. */
  .watermark {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg);
    font-size: 90px; font-weight: 700; color: #000; opacity: 0.045;
    pointer-events: none; z-index: 9999; white-space: nowrap; user-select: none;
  }
  @media print {
    .print-bar { display: none; }
    body { padding: 0; max-width: none; background: #fff !important; color: #1a1a1a !important; }
    .conversation + .conversation { break-before: page; border-top: none; padding-top: 0; }
  }
`;

/**
 * Builds a full, self-contained, styled HTML document string from 1+ export
 * models. `withPrintBar` adds a "Print / Save as PDF" button (used by
 * ui/export.html, not the direct .html download).
 */
export function renderStandaloneHtml(models, { docTitle, withPrintBar = false } = {}) {
  const single = models.length === 1;
  const title = docTitle || (single ? models[0].prompt : `${models.length} conversations`);

  const toc = !single
    ? `<nav class="toc"><h3>Contents</h3><ol>${models
        .map((m, i) => `<li><a href="#c-${m.captureId}">${esc(m.prompt)}</a> <span class="muted small">(${esc(m.model)}, ${esc(fmtDate(m.capturedAt))})</span></li>`)
        .join("")}</ol></nav>`
    : "";

  const printBar = withPrintBar
    ? `<div class="print-bar">
        <button id="printBtn" onclick="window.print()">🖨️ Print / Save as PDF</button>
        <span class="muted small">Tip: in the print dialog, uncheck "Headers and footers" for a clean PDF (Chrome adds its own page URL/date otherwise).</span>
      </div>`
    : "";

  // Single-conversation exports repeated the prompt (once as the page <h1>,
  // again inside the conversation section) — found in a real export. Fix:
  // for a single conversation, drop the top-level <h1> entirely (below) and
  // let the section heading — which has the fuller context, model/date/title
  // right next to it — be the ONE place the prompt appears. Bulk exports
  // keep both: the top <h1> is a generic label ("N conversations") and each
  // section still needs its own prompt to tell them apart.
  const body = models.map((m) => renderOneConversation(m, { showPrompt: true })).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="watermark" aria-hidden="true">CitoSkeleton</div>
${printBar}
<header class="doc-header">
  ${single ? "" : `<h1>${esc(title)}</h1>`}
  <div class="sub">Exported from <strong>CitoSkeleton</strong> · ${esc(fmtDate(Date.now()))} · Made by Shwetank Ojha</div>
</header>
${toc}
${body}
</body>
</html>`;
}
