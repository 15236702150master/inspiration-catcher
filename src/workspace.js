import DOMPurify from "dompurify";
import { marked } from "marked";

const MARK_KINDS = new Set(["highlight", "underline", "comment", "ai"]);
const COLORS = new Set(["key", "action", "evidence", "doubt"]);
const FILTERS = [
  ["all", "全部"], ["key", "重点"], ["action", "行动"], ["evidence", "案例"],
  ["doubt", "存疑"], ["comment", "批注"], ["orphaned", "待重新定位"]
];
const COLOR_LABELS = { key: "重点", action: "行动", evidence: "案例/证据", doubt: "存疑" };
let activeWorkspace = null;

const uid = prefix => `${prefix}_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const escapeHtml = (value = "") => { const node = document.createElement("div"); node.textContent = String(value); return node.innerHTML; };
const articleImageSrc = (value = "") => /^https?:\/\//i.test(String(value || ""))
  ? `api/image-proxy?url=${encodeURIComponent(String(value || ""))}`
  : String(value || "");
const normalize = value => String(value || "").normalize("NFC").replace(/\r\n?/g, "\n");
const compact = (value, length = 76) => { const clean = normalize(value).replace(/\s+/g, " ").trim(); return clean.length > length ? `${clean.slice(0, length)}…` : clean; };
const safeMarkdown = value => DOMPurify.sanitize(marked.parse(String(value || "")), {
  ALLOWED_TAGS: ["h1", "h2", "h3", "h4", "p", "br", "strong", "em", "u", "s", "blockquote", "ul", "ol", "li", "code", "pre", "a", "hr", "table", "thead", "tbody", "tr", "th", "td"],
  ALLOWED_ATTR: ["href", "title", "target", "rel"]
});
const debounce = (fn, wait) => { let timer; let lastArgs = []; const wrapped = (...args) => { lastArgs = args; clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...lastArgs); }, wait); }; wrapped.flush = () => { if (!timer) return undefined; clearTimeout(timer); timer = null; return fn(...lastArgs); }; wrapped.cancel = () => { clearTimeout(timer); timer = null; }; return wrapped; };

function textBlocks(value = "") {
  const chunks = normalize(value).trim().split(/\n{2,}|(?<=[。！？；])\s*(?=\S)/).filter(Boolean);
  return chunks.map((text, index) => ({ id: `legacy-${index + 1}`, type: "paragraph", text, order: index }));
}

function normalizeBlocks(document = {}) {
  const source = document.blocks || document.blocksJson || document.blocks_json;
  let blocks = source;
  if (typeof blocks === "string") { try { blocks = JSON.parse(blocks); } catch { blocks = null; } }
  if (blocks?.blocks) blocks = blocks.blocks;
  if (!Array.isArray(blocks) || !blocks.length) blocks = textBlocks(document.plainText || document.rawText || document.text || document.markdown || "");
  return blocks.map((block, index) => ({
    id: String(block.id || block.blockId || `block-${index + 1}`),
    type: block.type || "paragraph",
    text: normalize(block.text || block.plainText || block.content || ""),
    url: String(block.url || block.src || block.href || ""),
    alt: String(block.alt || block.title || block.text || ""),
    order: Number.isFinite(block.order) ? block.order : index,
    sourceAnchor: block.sourceAnchor || block.sourceMap || null
  }));
}

function annotationAnchor(annotation, display = true) {
  const raw = display ? (annotation.displayAnchor || annotation.display_anchor || annotation.displayAnchorJson) : (annotation.canonicalAnchor || annotation.canonical_anchor || annotation.canonicalAnchorJson);
  if (!raw) return null;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return null; } }
  return raw;
}

function selectionOffsets(root, range) {
  const blocks = [...root.querySelectorAll("[data-block-id]")];
  const selected = [];
  blocks.forEach(block => {
    if (!range.intersectsNode(block)) return;
    const blockRange = document.createRange();
    blockRange.selectNodeContents(block);
    const startRange = document.createRange();
    startRange.selectNodeContents(block);
    if (block.contains(range.startContainer)) startRange.setEnd(range.startContainer, range.startOffset);
    const endRange = document.createRange();
    endRange.selectNodeContents(block);
    if (block.contains(range.endContainer)) endRange.setEnd(range.endContainer, range.endOffset);
    const start = block.contains(range.startContainer) ? startRange.toString().length : 0;
    const end = block.contains(range.endContainer) ? endRange.toString().length : block.textContent.length;
    if (end > start) selected.push({ block, start, end, text: block.textContent.slice(start, end) });
    blockRange.detach(); startRange.detach(); endRange.detach();
  });
  return selected;
}

function segmentBlock(text, annotations, blockId) {
  const intervals = annotations.map(annotation => {
    const anchor = annotationAnchor(annotation);
    const pos = anchor?.position || anchor;
    if ((anchor?.blockId || pos?.blockId) !== blockId) return null;
    return { annotation, start: Math.max(0, Number(pos.start) || 0), end: Math.min(text.length, Number(pos.end) || 0) };
  }).filter(item => item && item.end > item.start);
  if (!intervals.length) return escapeHtml(text);
  const points = new Set([0, text.length]);
  intervals.forEach(item => { points.add(item.start); points.add(item.end); });
  const sorted = [...points].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1];
    const active = intervals.filter(item => item.start < end && item.end > start).map(item => item.annotation);
    if (!active.length) return escapeHtml(text.slice(start, end));
    const highlight = active.find(item => item.kind === "highlight");
    const underline = active.some(item => item.kind === "underline");
    const comment = active.some(item => item.kind === "comment" || item.comment);
    const ai = active.some(item => item.kind === "ai" || item.kind === "ai_note");
    const classes = [highlight ? `tw-mark tw-mark-${highlight.color || "key"}` : "", underline ? "tw-underline" : "", comment ? "tw-has-comment" : "", ai ? "tw-ai-mark" : ""].filter(Boolean).join(" ");
    return `<span class="${classes}" data-annotation-ids="${active.map(item => escapeHtml(item.id)).join(",")}">${escapeHtml(text.slice(start, end))}</span>`;
  }).join("");
}

export class TranscriptWorkspace {
  constructor(root, options = {}) {
    this.root = root;
    this.api = options.api;
    this.getProvider = options.getProvider || (() => "deepseek");
    this.context = options.context || "quick";
    this.noteId = options.noteId || null;
    this.legacy = options.legacy || {};
    this.mode = "source";
    this.workspace = null;
    this.documents = new Map();
    this.document = null;
    this.annotations = [];
    this.filter = "all";
    this.selection = null;
    this.annotationUndo = [];
    this.annotationRedo = [];
    this.annotationRenderLimit = 36;
    this.annotationBatchSize = 28;
    this.annotationWindowStart = 0;
    this.activeAnnotationId = null;
    this.connectorFrame = 0;
    this.editor = null;
    this.personal = { contentJson: null, revision: 0 };
    this.personalLoaded = false;
    this.personalDirty = false;
    this.editSessionStartedAt = null;
    this.exitPayload = null;
    this.annotationLoadToken = 0;
    this.pendingReanchor = null;
    this.online = navigator.onLine;
    this.root.dataset.offline = String(!navigator.onLine);
    this.savePersonalDebounced = debounce(() => this.savePersonal(), 800);
    this.renderShell();
    this.bind();
    if (this.noteId || this.legacy.transcript || this.legacy.formattedTranscript) this.load(options);
  }

  renderShell() {
    this.root.className = `transcript-workspace transcript-workspace-${this.context}`;
    this.root.dataset.testid = "transcript-workspace";
    this.root.dataset.workspaceContext = this.context;
    this.root.innerHTML = `
      <header class="tw-head">
        <div class="tw-mode" role="tablist" aria-label="笔记编辑模式">
          <button type="button" class="is-active" role="tab" aria-selected="true" data-mode="source" data-testid="workspace-mode-source">原文标注</button>
          <button type="button" role="tab" aria-selected="false" data-mode="personal" data-testid="workspace-mode-personal">我的加工稿</button>
        </div>
        <div class="tw-head-actions">
          <label class="tw-version-label">阅读版本<select data-role="version" data-testid="transcript-version-select" aria-label="选择阅读版本"></select></label>
          <button type="button" class="tw-version-delete" data-action="delete-version" data-role="delete-version" title="删除当前版本" disabled>删</button>
          <div class="tw-menu-wrap"><button type="button" class="tw-icon-button" data-action="toggle-export" aria-haspopup="menu" aria-expanded="false" title="复制或导出">⇩</button>
            <div class="tw-export-menu" data-role="export-menu" data-testid="export-menu" role="menu" hidden>
              <button role="menuitem" data-action="delete-version" data-role="delete-version-menu">删除当前版本</button>
              <button role="menuitem" data-export="raw" data-testid="export-raw">原始转写</button>
              <button role="menuitem" data-export="annotated" data-testid="export-annotated">带标注版本</button>
              <button role="menuitem" data-export="personal" data-testid="export-personal">我的加工稿</button>
            </div>
          </div>
        </div>
      </header>
      <div class="tw-status-row"><span data-role="document-meta">等待转写</span><span data-role="sync-status" data-testid="personal-save-status" aria-live="polite"></span></div>
      <div class="tw-reanchor-banner" data-role="reanchor-banner" hidden><span>请在正文中重新选择准确的句子，旧位置会保留在历史中。</span><div><button type="button" data-action="cancel-reanchor">取消</button><button type="button" class="primary" data-action="confirm-reanchor">确认定位</button></div></div>
      <section class="tw-source" data-pane="source">
        <div class="tw-reading-layout">
          <svg class="tw-annotation-connectors" data-role="annotation-connectors" aria-hidden="true"></svg>
          <article class="tw-document transcript-reader" data-role="document" data-testid="transcript-document" aria-label="转写正文"><div class="empty">解析视频后即可标注正文。</div></article>
          <aside class="tw-annotation-rail" aria-label="标注目录">
            <div class="tw-annotation-head"><div><strong>我的标注</strong><span data-role="annotation-count">0</span></div><button type="button" class="tw-icon-button" data-action="toggle-index" aria-expanded="true" title="收起标注目录">›</button></div>
            <div class="tw-filter" data-role="filters" aria-label="筛选标注">${FILTERS.map(([value, label]) => `<button type="button" class="${value === "all" ? "is-active" : ""}" data-filter="${value}">${label}</button>`).join("")}</div>
            <div class="tw-annotation-list" data-role="annotation-list" data-testid="annotation-list" role="list" aria-label="当前阅读版本的标注"></div>
          </aside>
        </div>
      </section>
      <section class="tw-personal" data-pane="personal" hidden>
        <div class="tw-editor-head">
          <div class="tw-editor-toolbar" role="toolbar" aria-label="加工稿格式">
            <button type="button" data-editor="undo" title="撤销">↶</button><button type="button" data-editor="redo" title="重做">↷</button>
            <span class="tw-tool-separator"></span><button type="button" data-editor="bold" title="粗体"><b>B</b></button><button type="button" data-editor="italic" title="斜体"><i>I</i></button><button type="button" data-editor="underline" title="下划线"><u>U</u></button><button type="button" data-editor="highlight" title="高亮">▤</button>
            <button type="button" data-editor="heading" title="二级标题">H2</button><button type="button" data-editor="bullet" title="项目列表">•</button><button type="button" data-editor="quote" title="引用">❝</button><button type="button" data-editor="clear" title="清除格式">Tx</button>
          </div>
          <div class="tw-editor-history-actions"><button type="button" class="tw-text-button" data-action="personal-snapshot">保存版本</button><button type="button" class="tw-text-button" data-action="personal-history">版本记录</button></div>
        </div>
        <div class="tw-personal-empty" data-role="personal-empty">
          <strong>把阅读痕迹整理成自己的内容</strong><p>从高亮生成初稿，或从空白开始自由整理。</p>
          <div><button type="button" class="primary" data-action="draft-from-highlights">从高亮生成初稿</button><button type="button" class="secondary" data-action="blank-personal">空白开始</button></div>
        </div>
        <div class="tw-editor" data-role="personal-editor" data-testid="personal-editor" aria-label="我的加工稿编辑器"></div>
      </section>
      <div class="tw-selection-toolbar" data-role="selection-toolbar" data-testid="selection-toolbar" role="toolbar" aria-label="文字标注工具" hidden>
        <div class="tw-highlight-menu"><button type="button" data-action="highlight" title="高亮重点"><span class="tw-swatch tw-swatch-key"></span>高亮</button><div class="tw-colors" hidden>${Object.entries(COLOR_LABELS).map(([color, label]) => `<button type="button" data-color="${color}"><span class="tw-swatch tw-swatch-${color}"></span>${label}</button>`).join("")}</div></div>
        <button type="button" data-action="underline"><u>U</u><span>下划线</span></button><button type="button" data-action="comment">✎<span>批注</span></button><button type="button" data-action="more">•••<span>更多</span></button>
        <div class="tw-more-menu" data-role="more-menu" hidden>
          <button data-action="copy-selection">复制</button><button data-action="excerpt">摘到加工稿</button><button data-action="action-item">转为待实践</button>
          <button data-ai="explain">AI 解释</button><button data-ai="counterexample">AI 反例</button><button data-ai="case">AI 补充案例</button><button data-ai="action_steps">AI 行动步骤</button>
        </div>
      </div>
      <div class="tw-mobile-toolbar" data-role="mobile-toolbar" data-testid="selection-toolbar-mobile" role="toolbar" aria-label="文字标注工具" hidden>
        <button data-action="highlight"><span class="tw-swatch tw-swatch-key"></span><span>高亮</span></button><button data-action="underline"><u>U</u><span>下划线</span></button><button data-action="comment">✎<span>批注</span></button><button data-action="more">•••<span>更多</span></button>
      </div>
      <div class="tw-sheet" data-role="sheet" hidden><button class="tw-sheet-backdrop" data-action="close-sheet" aria-label="关闭"></button><section class="tw-sheet-panel" role="dialog" aria-modal="true"><div class="tw-sheet-handle"></div><div data-role="sheet-content"></div></section></div>
      <div class="tw-conflict" data-role="conflict" data-testid="personal-conflict" role="alertdialog" aria-modal="true" hidden>
        <strong>这份加工稿在另一处被修改过</strong><p>两个版本都已保留。请选择继续编辑哪一份。</p><div><button data-action="use-server" data-testid="conflict-use-server">使用服务器版本</button><button class="primary" data-action="use-local" data-testid="conflict-use-local">保留我的版本</button></div>
      </div>`;
  }

  bind() {
    this.root.addEventListener("click", event => this.onClick(event));
    this.root.addEventListener("change", event => { if (event.target.matches('[data-role="version"]')) this.selectDocument(event.target.value); });
    this.root.addEventListener("pointerover", event => { const item = event.target.closest("[data-annotation-id]"); if (item) this.activateAnnotation(item.dataset.annotationId); });
    this.root.addEventListener("focusin", event => { const item = event.target.closest("[data-annotation-id]"); if (item) this.activateAnnotation(item.dataset.annotationId); });
    this.root.addEventListener("pointerup", event => { if (event.pointerType !== "touch") setTimeout(() => this.captureSelection(), 0); });
    document.addEventListener("selectionchange", this.onSelectionChange = () => {
      if (matchMedia("(pointer: coarse)").matches && this.root.contains(document.getSelection()?.anchorNode)) setTimeout(() => this.captureSelection(), 180);
    });
    document.addEventListener("scroll", this.onScroll = () => { this.hideSelectionTools(); this.scheduleConnectors(); }, { capture: true, passive: true });
    window.addEventListener("resize", this.onResize = () => this.scheduleConnectors());
    window.addEventListener("online", this.onOnline = () => { this.online = true; this.root.dataset.offline = "false"; this.flushOutbox(); });
    window.addEventListener("offline", this.onOffline = () => { this.online = false; this.root.dataset.offline = "true"; this.setSyncStatus("离线待同步", "offline"); });
    document.addEventListener("visibilitychange", this.onVisibility = () => { if (document.hidden) this.savePersonalForExit("hidden"); });
    window.addEventListener("pagehide", this.onPageHide = () => this.savePersonalForExit("pagehide"));
    document.addEventListener("keydown", this.onKeydownEvent = event => this.onKeydown(event));
  }

  async load(options = {}) {
    const nextNoteId = options.noteId !== undefined ? options.noteId : this.noteId;
    if (this.noteId && nextNoteId && String(nextNoteId) !== String(this.noteId) && this.editor) await this.flushPersonal(true, "switch-note");
    if (options.noteId !== undefined) this.noteId = options.noteId;
    if (options.legacy) this.legacy = { ...this.legacy, ...options.legacy };
    this.root.dataset.noteId = this.noteId || "";
    this.personalLoaded = false;
    this.personalDirty = false;
    this.editSessionStartedAt = null;
    this.editor?.destroy();
    this.editor = null;
    this.annotations = [];
    this.annotationRenderLimit = 36;
    this.annotationWindowStart = 0;
    this.activeAnnotationId = null;
    this.documents.clear();
    if (this.noteId) {
      try {
        const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/workspace`);
        this.workspace = result.workspace || result;
        this.annotations = this.workspace.annotations || this.workspace.annotationItems || [];
        this.personal = this.workspace.personalDocument || this.workspace.personal || this.personal;
      } catch (error) {
        if (error.status !== 404 && error.status !== 501) this.toastError(error);
        this.workspace = null;
      }
    }
    this.populateVersions();
    await this.selectDefaultDocument();
    this.renderAnnotations();
  }

  setLegacy(legacy = {}) {
    this.legacy = { ...this.legacy, ...legacy };
    if (legacy.noteId && legacy.noteId !== this.noteId) return this.load({ noteId: legacy.noteId, legacy });
    if (!this.workspace) { this.populateVersions(); this.selectDefaultDocument(); }
  }

  populateVersions() {
    const versions = [];
    const transcripts = this.workspace?.transcriptVersions || this.workspace?.transcripts || [];
    const readings = this.workspace?.readingDocuments || this.workspace?.documents || [];
    transcripts.forEach((item, index) => versions.push({ ...item, id: item.id || item.transcriptVersionId, kind: "raw", label: item.label || `原始转写 v${item.versionNo || index + 1}` }));
    readings.forEach((item, index) => versions.push({ ...item, id: item.id || item.documentId, kind: "reading", label: item.label || `AI 阅读版 v${item.versionNo || index + 1}` }));
    if (!versions.length && this.legacy.transcript) versions.push({ id: "legacy-raw", kind: "raw", label: "原始转写", rawText: this.legacy.transcript });
    if (this.legacy.formattedTranscript && !versions.some(item => item.id === "legacy-reading")) versions.push({ id: "legacy-reading", kind: "reading", label: "AI 阅读版", markdown: this.legacy.formattedTranscript, plainText: this.legacy.formattedTranscript });
    this.versions = versions;
    const select = this.root.querySelector('[data-role="version"]');
    select.innerHTML = versions.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
    select.disabled = versions.length < 2;
    this.updateVersionDeleteButton();
  }

  updateVersionDeleteButton() {
    const select = this.root.querySelector('[data-role="version"]');
    const version = this.versions?.find(item => String(item.id) === String(select?.value));
    const canDelete = Boolean(this.noteId && version && !String(version.id).startsWith("legacy-") && (this.versions || []).filter(item => !String(item.id).startsWith("legacy-")).length > 1);
    this.root.querySelectorAll('[data-role="delete-version"],[data-role="delete-version-menu"]').forEach(button => {
      button.disabled = !canDelete;
      button.hidden = this.mode !== "source";
      button.title = canDelete ? `删除当前${version.kind === "raw" ? "原始转写" : "AI阅读"}版本` : "至少保留一个版本";
    });
  }

  async selectDefaultDocument() {
    const preferred = this.workspace?.activeDocumentId || this.workspace?.activeReadingDocumentId || this.workspace?.active_reading_document_id;
    const selected = this.versions.find(item => item.id === preferred) || this.versions.find(item => item.kind === "reading") || this.versions[0];
    if (!selected) return this.renderEmpty();
    this.root.querySelector('[data-role="version"]').value = selected.id;
    await this.selectDocument(selected.id);
  }

  async selectDocument(id) {
    let version = this.versions.find(item => String(item.id) === String(id));
    if (!version) return;
    let documentData = this.documents.get(version.id);
    if (!documentData && this.noteId && !String(version.id).startsWith("legacy-")) {
      try {
        if (version.kind === "raw") {
          const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/transcript-versions`);
          documentData = (result.items || result.versions || []).find(item => String(item.id) === String(version.id));
        } else {
          const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/documents/${encodeURIComponent(version.id)}`);
          documentData = result.document || result;
        }
      } catch (error) {
        if (version.kind === "raw" && this.legacy.transcript) documentData = { ...version, rawText: this.legacy.transcript };
        else this.toastError(error);
      }
    }
    documentData ||= version;
    documentData = { ...version, ...documentData, blocks: normalizeBlocks({ ...version, ...documentData }) };
    this.documents.set(version.id, documentData);
    this.document = documentData;
    this.updateVersionDeleteButton();
    this.annotationRenderLimit = 36;
    this.annotationWindowStart = 0;
    this.activeAnnotationId = null;
    await this.loadAnnotations();
    this.renderDocument();
    this.renderAnnotations();
  }

  async loadAnnotations() {
    if (!this.noteId || !this.document?.id || String(this.document.id).startsWith("legacy-")) return;
    const token = ++this.annotationLoadToken;
    try {
      const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations?documentId=${encodeURIComponent(this.document.id)}&status=&limit=100`);
      this.annotations = result.items || result.annotations || this.annotations;
      if (result.nextCursor) setTimeout(() => this.loadRemainingAnnotations(token, result.nextCursor), 0);
    } catch (error) { if (error.status !== 404 && error.status !== 501) this.toastError(error); }
  }

  async loadRemainingAnnotations(token, cursor) {
    const noteId = this.noteId;
    const documentId = this.document?.id;
    let nextCursor = cursor;
    const collected = [];
    try {
      while (nextCursor && token === this.annotationLoadToken && String(noteId) === String(this.noteId) && String(documentId) === String(this.document?.id)) {
        const result = await this.api(`api/notes/${encodeURIComponent(noteId)}/annotations?documentId=${encodeURIComponent(documentId)}&status=&limit=100&cursor=${encodeURIComponent(nextCursor)}`);
        collected.push(...(result.items || []));
        nextCursor = result.nextCursor;
      }
      if (!collected.length || token !== this.annotationLoadToken) return;
      const known = new Set(this.annotations.map(item => String(item.id)));
      const added = collected.filter(item => !known.has(String(item.id)));
      this.annotations.push(...added);
      this.refreshAnnotationBlocks(added);
      this.renderAnnotations();
    } catch (error) { if (token === this.annotationLoadToken) this.toastError(error); }
  }

  renderEmpty() {
    this.document = null;
    this.root.querySelector('[data-role="document"]').innerHTML = '<div class="empty">转写完成后，这里可以高亮、批注并整理加工稿。</div>';
    this.root.querySelector('[data-role="document-meta"]').textContent = "等待转写";
  }

  renderDocument() {
    if (!this.document) return this.renderEmpty();
    const heading = type => type === "heading" || /^h[1-4]$/.test(type);
    this.root.querySelector('[data-role="document"]').innerHTML = this.document.blocks.map(block => {
      if (block.type === "image" && block.url) {
        const rendered = this.renderedBlock(block);
        return `<figure class="tw-article-image" data-block-id="${escapeHtml(block.id)}" data-block-order="${block.order}" tabindex="-1">${rendered.content}</figure>${rendered.comments}`;
      }
      const tag = heading(block.type) ? (block.type === "heading" ? "h2" : block.type) : block.type === "blockquote" ? "blockquote" : block.type === "listItem" ? "li" : "p";
      const rendered = this.renderedBlock(block);
      return `<${tag} data-block-id="${escapeHtml(block.id)}" data-block-order="${block.order}" tabindex="-1">${rendered.content}</${tag}>${rendered.comments}`;
    }).join("");
    const date = this.document.createdAt ? ` · ${new Date(this.document.createdAt).toLocaleString("zh-CN")}` : "";
    if (this.document.kind === "raw") {
      const job = this.document.originJobId ? ` · 任务 ${this.document.originJobId}` : "";
      const checksum = this.document.sha256 ? ` · 校验 ${this.document.sha256.slice(0, 12)}` : "";
      this.root.querySelector('[data-role="document-meta"]').textContent = `原始转写 · Whisper medium${job}${date}${checksum}`;
    } else {
      const model = this.document.model ? ` · ${this.document.model}` : "";
      this.root.querySelector('[data-role="document-meta"]').textContent = `AI 阅读版${model}${date}`;
    }
    this.scheduleConnectors();
  }

  renderedBlock(block) {
    if (block.type === "image" && block.url) {
      const alt = block.alt || block.text || "文章图片";
      return {
        content: `<img src="${escapeHtml(articleImageSrc(block.url))}" data-source-url="${escapeHtml(block.url)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${escapeHtml(alt)}</figcaption>`,
        comments: ""
      };
    }
    const visible = this.visibleAnnotations();
    const renderable = visible.map(item => this.document.kind === "raw" ? { ...item, displayAnchor: item.canonicalAnchor || item.canonical_anchor } : item);
    const comments = visible.filter(item => {
      const anchor = this.currentAnchor(item);
      return (anchor?.blockId || anchor?.position?.blockId) === block.id && (item.kind === "comment" || item.comment);
    });
    return {
      content: segmentBlock(block.text, renderable, block.id),
      comments: comments.length ? `<div class="tw-inline-comments">${comments.map(item => `<button data-jump-annotation="${escapeHtml(item.id)}">✎ ${escapeHtml(compact(item.comment, 48))}</button>`).join("")}</div>` : ""
    };
  }

  refreshAnnotationBlocks(items = []) {
    if (!this.document) return;
    const blockIds = new Set(items.flatMap(item => [annotationAnchor(item)?.blockId, annotationAnchor(item, false)?.blockId]).filter(Boolean));
    for (const blockId of blockIds) {
      const block = this.document.blocks.find(item => item.id === blockId);
      const node = [...this.root.querySelectorAll('[data-role="document"] [data-block-id]')].find(item => item.dataset.blockId === blockId);
      if (!block || !node) continue;
      const rendered = this.renderedBlock(block);
      node.innerHTML = rendered.content;
      if (node.nextElementSibling?.classList.contains("tw-inline-comments")) node.nextElementSibling.remove();
      if (rendered.comments) node.insertAdjacentHTML("afterend", rendered.comments);
    }
  }

  visibleAnnotations() {
    return this.annotations.filter(item => !item.deletedAt && (!item.displayReadingDocumentId && !item.display_reading_document_id || String(item.displayReadingDocumentId || item.display_reading_document_id) === String(this.document?.id) || item.anchorScope === "canonical" || item.anchor_scope === "canonical"));
  }

  currentAnchor(item) {
    return this.document?.kind === "raw" ? annotationAnchor(item, false) : annotationAnchor(item) || annotationAnchor(item, false);
  }

  filteredAnnotations() {
    return this.visibleAnnotations().filter(item => this.filter === "all" || (this.filter === "orphaned" ? item.status === "orphaned" : this.filter === "comment" ? item.kind === "comment" || item.comment : item.color === this.filter));
  }

  renderAnnotations() {
    const all = this.visibleAnnotations();
    const items = this.filteredAnnotations();
    this.annotationWindowStart = Math.min(this.annotationWindowStart, Math.max(0, items.length - 1));
    const rendered = items.slice(this.annotationWindowStart, this.annotationWindowStart + this.annotationRenderLimit);
    const before = this.annotationWindowStart;
    const remaining = Math.max(0, items.length - this.annotationWindowStart - rendered.length);
    const list = this.root.querySelector('[data-role="annotation-list"]');
    this.root.querySelector('[data-role="annotation-count"]').textContent = String(all.length);
    list.dataset.totalCount = String(items.length);
    list.dataset.renderedCount = String(rendered.length);
    list.setAttribute("aria-label", `${items.length} 条标注，已显示 ${rendered.length} 条`);
    list.innerHTML = items.length ? (before ? `<button type="button" class="tw-load-more" data-action="load-previous-annotations" aria-label="加载前面的标注">查看前面的 ${before} 条</button>` : "") + rendered.map((item, index) => {
      const anchor = this.currentAnchor(item);
      const exact = anchor?.quote?.exact || item.excerpt || "标注内容";
      const scope = item.anchorScope || item.anchor_scope;
      const status = item.status || "active";
      const type = item.kind === "underline" ? "下划线" : item.kind === "comment" ? "批注" : item.kind === "ai" || item.kind === "ai_note" ? "AI 批注" : COLOR_LABELS[item.color] || "高亮";
      return `<article class="tw-annotation-item ${status === "orphaned" ? "is-orphaned" : ""} ${String(item.id) === String(this.activeAnnotationId) ? "is-active" : ""}" data-annotation-id="${escapeHtml(item.id)}" role="listitem" aria-posinset="${this.annotationWindowStart + index + 1}" aria-setsize="${items.length}">
        <button type="button" class="tw-annotation-main" data-jump-annotation="${escapeHtml(item.id)}"><span class="tw-annotation-type"><i class="tw-dot tw-dot-${escapeHtml(item.color || item.kind)}"></i>${escapeHtml(type)}${scope === "version_bound" ? " · 版本限定" : ""}${item.optimistic ? " · 保存中" : ""}</span><q>${escapeHtml(compact(exact, 92))}</q>${item.comment ? `<p>${escapeHtml(compact(item.comment, 120))}</p>` : ""}</button>
        <div class="tw-annotation-actions">${item.optimistic ? "" : `${status === "orphaned" || scope === "version_bound" ? `<button data-reanchor="${escapeHtml(item.id)}">重新定位</button>` : ""}${item.kind === "comment" || item.comment ? `<button data-edit-comment="${escapeHtml(item.id)}">编辑</button>` : ""}<button data-delete-annotation="${escapeHtml(item.id)}">删除</button>`}</div>
      </article>`;
    }).join("") + (remaining ? `<button type="button" class="tw-load-more" data-action="load-more-annotations" data-role="annotation-sentinel" aria-label="继续加载 ${Math.min(this.annotationBatchSize, remaining)} 条标注">继续加载 · 还有 ${remaining} 条</button>` : "") : `<div class="tw-annotation-empty">${this.filter === "all" ? "选中文字，留下第一处阅读痕迹。" : "没有符合筛选条件的标注。"}</div>`;
    this.observeAnnotationSentinel();
    this.scheduleConnectors();
  }

  observeAnnotationSentinel() {
    this.annotationObserver?.disconnect();
    const sentinel = this.root.querySelector('[data-role="annotation-sentinel"]');
    if (!sentinel || typeof IntersectionObserver === "undefined" || matchMedia("(max-width: 900px)").matches) return;
    this.annotationObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      this.annotationRenderLimit += this.annotationBatchSize;
      this.renderAnnotations();
    }, { root: this.root.querySelector('[data-role="annotation-list"]'), rootMargin: "180px 0px" });
    this.annotationObserver.observe(sentinel);
  }

  ensureAnnotationRendered(id) {
    const index = this.filteredAnnotations().findIndex(item => String(item.id) === String(id));
    if (index < 0 || (index >= this.annotationWindowStart && index < this.annotationWindowStart + this.annotationRenderLimit)) return;
    this.annotationWindowStart = Math.max(0, Math.min(index - Math.floor(this.annotationRenderLimit / 2), this.filteredAnnotations().length - this.annotationRenderLimit));
    this.renderAnnotations();
  }

  activateAnnotation(id) {
    if (!id || String(id) === String(this.activeAnnotationId)) return;
    this.activeAnnotationId = id;
    this.root.querySelectorAll("[data-annotation-id]").forEach(item => item.classList.toggle("is-active", String(item.dataset.annotationId) === String(id)));
    this.scheduleConnectors();
  }

  scheduleConnectors() {
    cancelAnimationFrame(this.connectorFrame);
    this.connectorFrame = requestAnimationFrame(() => this.renderConnectors());
  }

  textPointForAnchor(anchor) {
    const blockId = anchor?.blockId || anchor?.position?.blockId;
    const end = Number(anchor?.position?.end ?? anchor?.end);
    const block = [...this.root.querySelectorAll('[data-role="document"] [data-block-id]')].find(node => node.dataset.blockId === blockId);
    if (!block || !Number.isFinite(end)) return block?.getBoundingClientRect() || null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node; let consumed = 0;
    while ((node = walker.nextNode())) {
      const next = consumed + node.data.length;
      if (end <= next) {
        const range = document.createRange();
        range.setStart(node, Math.max(0, Math.min(node.data.length, end - consumed)));
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        return rect.width || rect.height ? rect : block.getBoundingClientRect();
      }
      consumed = next;
    }
    return block.getBoundingClientRect();
  }

  renderConnectors() {
    const svg = this.root.querySelector('[data-role="annotation-connectors"]');
    const layout = this.root.querySelector(".tw-reading-layout");
    if (!svg || !layout || matchMedia("(max-width: 900px)").matches) { if (svg) svg.innerHTML = ""; return; }
    const layoutRect = layout.getBoundingClientRect();
    const railRect = this.root.querySelector('[data-role="annotation-list"]')?.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${Math.max(1, layoutRect.width)} ${Math.max(1, layoutRect.height)}`);
    const cards = [...this.root.querySelectorAll(".tw-annotation-item[data-annotation-id]")].filter(card => {
      const rect = card.getBoundingClientRect();
      return railRect && rect.bottom >= railRect.top && rect.top <= railRect.bottom;
    }).slice(0, 10);
    svg.innerHTML = cards.map(card => {
      const annotation = this.annotations.find(item => String(item.id) === String(card.dataset.annotationId));
      const anchorRect = this.textPointForAnchor(this.currentAnchor(annotation || {}));
      const cardRect = card.getBoundingClientRect();
      if (!anchorRect || anchorRect.bottom < layoutRect.top || anchorRect.top > layoutRect.bottom) return "";
      const x1 = Math.max(0, anchorRect.right - layoutRect.left + 6);
      const y1 = Math.max(0, anchorRect.top - layoutRect.top + Math.max(5, anchorRect.height / 2));
      const x2 = Math.max(x1 + 24, cardRect.left - layoutRect.left - 7);
      const y2 = Math.max(0, cardRect.top - layoutRect.top + Math.min(30, cardRect.height / 2));
      const bend = Math.max(22, (x2 - x1) * .46);
      const active = String(card.dataset.annotationId) === String(this.activeAnnotationId);
      return `<path data-testid="annotation-connector" data-annotation-id="${escapeHtml(card.dataset.annotationId)}" class="${active ? "is-active" : ""}" d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + bend).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - bend).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
    }).join("");
  }

  captureSelection() {
    const selection = document.getSelection();
    const documentRoot = this.root.querySelector('[data-role="document"]');
    if (!selection || selection.isCollapsed || !selection.rangeCount || !documentRoot.contains(selection.anchorNode) || !documentRoot.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0).cloneRange();
    const parts = selectionOffsets(documentRoot, range);
    if (!parts.length || parts.reduce((sum, part) => sum + part.text.length, 0) > 5000) return;
    this.selection = { range, parts, text: parts.map(part => part.text).join("\n") };
    activeWorkspace = this;
    const coarse = matchMedia("(pointer: coarse)").matches;
    if (coarse) {
      const mobile = this.root.querySelector('[data-role="mobile-toolbar"]');
      mobile.hidden = false;
    } else {
      const toolbar = this.root.querySelector('[data-role="selection-toolbar"]');
      toolbar.hidden = false;
      const rect = range.getBoundingClientRect();
      const own = this.root.getBoundingClientRect();
      toolbar.style.left = `${Math.max(8, Math.min(own.width - toolbar.offsetWidth - 8, rect.left - own.left + rect.width / 2 - toolbar.offsetWidth / 2))}px`;
      toolbar.style.top = `${Math.max(8, rect.top - own.top + this.root.scrollTop - toolbar.offsetHeight - 10)}px`;
    }
  }

  hideSelectionTools(clear = false) {
    this.root.querySelector('[data-role="selection-toolbar"]').hidden = true;
    this.root.querySelector('[data-role="mobile-toolbar"]').hidden = true;
    this.root.querySelector('[data-role="more-menu"]').hidden = true;
    this.root.querySelector(".tw-colors").hidden = true;
    if (clear) { this.selection = null; document.getSelection()?.removeAllRanges(); }
  }

  createAnchor(part) {
    const text = part.block.textContent;
    return {
      schema: 1,
      blockId: part.block.dataset.blockId,
      position: { start: part.start, end: part.end, unit: "utf16" },
      quote: { exact: part.text, prefix: text.slice(Math.max(0, part.start - 32), part.start), suffix: text.slice(part.end, part.end + 32) },
      normalizedQuote: normalize(part.text).replace(/\s+/g, " ").trim(),
      sourceDocumentSha256: this.document?.sha256 || null
    };
  }

  async canonicalAnchorFor(displayAnchor) {
    if (this.document?.kind === "raw") return displayAnchor;
    const transcriptId = this.document?.transcriptVersionId || this.workspace?.activeTranscriptId;
    if (!transcriptId) return null;
    let raw = this.documents.get(transcriptId);
    if (!raw) {
      try {
        const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/transcript-versions`);
        raw = (result.items || []).find(item => String(item.id) === String(transcriptId));
        if (raw) {
          raw = { ...raw, kind: "raw", blocks: normalizeBlocks(raw) };
          this.documents.set(transcriptId, raw);
        }
      } catch { return null; }
    }
    const exact = displayAnchor?.quote?.exact || "";
    if (!exact || !raw?.blocks?.length) return null;
    const matches = [];
    for (const block of raw.blocks) {
      let start = block.text.indexOf(exact);
      while (start >= 0) {
        matches.push({ block, start });
        start = block.text.indexOf(exact, start + Math.max(1, exact.length));
      }
    }
    if (matches.length !== 1) return null;
    const [{ block, start }] = matches;
    return {
      schema: 1,
      blockId: block.id,
      position: { start, end: start + exact.length, unit: "utf16" },
      quote: { exact, prefix: block.text.slice(Math.max(0, start - 32), start), suffix: block.text.slice(start + exact.length, start + exact.length + 32) },
      normalizedQuote: normalize(exact).replace(/\s+/g, " ").trim(),
      sourceDocumentSha256: raw.sha256 || null
    };
  }

  async addAnnotation(kind, color = null, comment = "") {
    if (!this.selection || !this.noteId) return this.showSheet(`<div class="tw-sheet-message"><strong>请先保存这条灵感</strong><p>保存后即可让标注在刷新和其他设备上保留。</p></div>`);
    if ((kind === "highlight" || kind === "underline") && await this.toggleExistingMark(kind, color)) { this.hideSelectionTools(true); return []; }
    const groupId = uid("annotation-group");
    const sourceTranscriptVersionId = this.document.transcriptVersionId || this.document.id;
    const prepared = this.selection.parts.map(part => {
      const displayAnchor = this.createAnchor(part);
      const optimistic = {
        id: uid("annotation-local"), groupId, anchorScope: this.document.kind === "raw" ? "canonical" : "version_bound",
        sourceTranscriptVersionId, canonicalAnchor: this.document.kind === "raw" ? displayAnchor : null,
        displayReadingDocumentId: this.document.kind === "reading" ? this.document.id : null,
        displayAnchor: this.document.kind === "reading" ? displayAnchor : null,
        kind, color, comment, status: "active", revision: 0, optimistic: true
      };
      return { displayAnchor, optimistic };
    });
    this.annotations.push(...prepared.map(item => item.optimistic));
    this.refreshAnnotationBlocks(prepared.map(item => item.optimistic));
    this.renderAnnotations();
    this.hideSelectionTools(true);
    const added = [];
    for (const item of prepared) {
      const canonicalAnchor = await this.canonicalAnchorFor(item.displayAnchor);
      const scope = canonicalAnchor ? "canonical" : "version_bound";
      const payload = {
        groupId, anchorScope: scope, kind, color, comment,
        sourceTranscriptVersionId,
        canonicalAnchor,
        displayReadingDocumentId: this.document.kind === "reading" ? this.document.id : null,
        displayAnchor: this.document.kind === "reading" ? item.displayAnchor : null
      };
      try {
        const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations`, { method: "POST", headers: { "Idempotency-Key": uid("annotation") }, body: JSON.stringify(payload) });
        const saved = result.annotation || result.item || result;
        Object.keys(item.optimistic).forEach(key => delete item.optimistic[key]);
        Object.assign(item.optimistic, saved);
        added.push(item.optimistic);
      } catch (error) {
        this.annotations = this.annotations.filter(annotation => annotation !== item.optimistic);
        this.refreshAnnotationBlocks([item.optimistic]);
        this.toastError(error);
      }
    }
    if (added.length) {
      this.annotationUndo.push({ type: "add", items: added }); this.annotationRedo = [];
      this.refreshAnnotationBlocks(added); this.renderAnnotations(); this.announce("标注已保存");
    }
    else this.renderAnnotations();
    return added;
  }

  async toggleExistingMark(kind, color) {
    const matches = this.selection.parts.map(part => this.annotations.find(item => {
      const anchor = this.currentAnchor(item); const position = anchor?.position || anchor;
      return item.kind === kind && (anchor?.blockId || position?.blockId) === part.block.dataset.blockId && Number(position?.start) === part.start && Number(position?.end) === part.end;
    }));
    if (matches.some(item => !item)) return false;
    if (kind === "highlight" && matches.some(item => item.color !== color)) {
      for (const item of matches) {
        try {
          const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ baseRevision: item.revision, color }) });
          Object.assign(item, result.annotation || result.item || result);
        } catch (error) { this.toastError(error); return true; }
      }
      this.refreshAnnotationBlocks(matches); this.renderAnnotations(); this.announce(`已改为${COLOR_LABELS[color]}高亮`); return true;
    }
    for (const item of matches) await this.deleteAnnotation(item.id, false);
    this.announce(kind === "highlight" ? "已取消高亮" : "已取消下划线");
    return true;
  }

  async deleteAnnotation(id, record = true) {
    const item = this.annotations.find(annotation => String(annotation.id) === String(id));
    if (!item) return;
    try {
      await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ baseRevision: item.revision }) });
      this.annotations = this.annotations.filter(annotation => String(annotation.id) !== String(id));
      if (record) { this.annotationUndo.push({ type: "delete", items: [item] }); this.annotationRedo = []; }
      this.refreshAnnotationBlocks([item]); this.renderAnnotations(); this.announce("标注已删除");
    } catch (error) { this.toastError(error); }
  }

  async deleteCurrentVersion() {
    if (!this.noteId || !this.document?.id || String(this.document.id).startsWith("legacy-")) return;
    const version = this.versions.find(item => String(item.id) === String(this.document.id));
    if (!version) return;
    const label = version.label || (version.kind === "raw" ? "当前原始转写版本" : "当前AI阅读版本");
    if (!window.confirm(`删除“${label}”？这个版本上的标注也会一起删除。`)) return;
    const endpoint = version.kind === "raw"
      ? `api/notes/${encodeURIComponent(this.noteId)}/transcript-versions/${encodeURIComponent(version.id)}`
      : `api/notes/${encodeURIComponent(this.noteId)}/documents/${encodeURIComponent(version.id)}`;
    try {
      await this.api(endpoint, { method: "DELETE" });
      this.documents.delete(version.id);
      await this.load({ noteId: this.noteId, legacy: this.legacy });
      this.announce("版本已删除，相关标注也已清理");
    } catch (error) {
      this.toastError(error);
    }
  }

  async editComment(id) {
    const item = this.annotations.find(annotation => String(annotation.id) === String(id));
    if (!item) return;
    this.showCommentSheet(item.comment || "", async comment => {
      try {
        const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ baseRevision: item.revision, comment }) });
        Object.assign(item, result.annotation || result.item || result); this.refreshAnnotationBlocks([item]); this.renderAnnotations(); this.announce("批注已保存");
      } catch (error) { this.toastError(error); }
    });
  }

  async reanchor(id) {
    const item = this.annotations.find(annotation => String(annotation.id) === String(id));
    if (!item) return;
    this.pendingReanchor = item;
    const transcriptId = item.sourceTranscriptVersionId || this.document?.transcriptVersionId || this.workspace?.activeTranscriptId;
    const rawVersion = this.versions.find(version => version.kind === "raw" && (!transcriptId || String(version.id) === String(transcriptId))) || this.versions.find(version => version.kind === "raw");
    if (rawVersion && this.document?.kind !== "raw") {
      this.root.querySelector('[data-role="version"]').value = rawVersion.id;
      await this.selectDocument(rawVersion.id);
    }
    this.closeSheet();
    this.root.querySelector('[data-role="reanchor-banner"]').hidden = false;
    this.root.querySelector('[data-role="document"]').scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async confirmReanchor() {
    if (!this.pendingReanchor || !this.selection?.parts?.length) return this.announce("请先在正文中选择对应文字", true);
    const anchor = this.createAnchor(this.selection.parts[0]);
    try {
      const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations/${encodeURIComponent(this.pendingReanchor.id)}/reanchor`, { method: "POST", body: JSON.stringify({ baseRevision: this.pendingReanchor.revision, documentId: this.document.id, anchor, canonicalAnchor: anchor }) });
      const updated = result.annotation || result.item || result;
      Object.assign(this.pendingReanchor, updated);
      if (!this.annotations.some(item => String(item.id) === String(updated.id))) this.annotations.push(updated);
      this.pendingReanchor = null; this.root.querySelector('[data-role="reanchor-banner"]').hidden = true; this.refreshAnnotationBlocks([updated]); this.renderAnnotations(); this.announce("已重新定位");
    } catch (error) { this.toastError(error); }
  }

  async loadPersonal() {
    if (this.personalLoaded) return;
    if (this.noteId) {
      try { const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/personal-document`); this.personal = result.document || result.personalDocument || result; }
      catch (error) { if (error.status !== 404 && error.status !== 501) this.toastError(error); }
    }
    const pending = await this.readOutbox();
    if (pending?.payload?.content) {
      this.personal = { ...this.personal, content: pending.payload.content, revision: pending.payload.baseRevision ?? this.personal.revision };
      this.setSyncStatus(navigator.onLine ? "待同步" : "离线待同步", "offline");
    }
    try { await this.createEditor(); }
    catch (error) {
      this.root.querySelector('[data-role="personal-editor"]').innerHTML = '<div class="tw-editor-error"><strong>编辑器加载失败</strong><p>网络恢复后可重新加载，原有加工稿不会丢失。</p><button type="button" data-action="retry-editor">重新加载</button></div>';
      this.toastError(error);
    }
    this.personalLoaded = true;
    if (pending && navigator.onLine) setTimeout(() => this.flushOutbox(), 0);
  }

  async createEditor() {
    const [{ Editor }, { default: StarterKit }, { default: Underline }, { default: Highlight }, { default: Link }] = await Promise.all([
      import("@tiptap/core"), import("@tiptap/starter-kit"), import("@tiptap/extension-underline"), import("@tiptap/extension-highlight"), import("@tiptap/extension-link")
    ]);
    this.editor?.destroy();
    const content = this.personal.contentJson || this.personal.content_json || this.personal.content || { type: "doc", content: [] };
    this.editor = new Editor({
      element: this.root.querySelector('[data-role="personal-editor"]'), content,
      extensions: [StarterKit.configure({ heading: { levels: [2, 3] } }), Underline, Highlight.configure({ multicolor: false }), Link.configure({ openOnClick: false, protocols: ["http", "https"] })],
      editorProps: { attributes: { class: "tw-prosemirror", spellcheck: "true", "aria-label": "我的加工稿正文" } },
      onUpdate: () => { this.root.querySelector('[data-role="personal-empty"]').hidden = true; this.personalDirty = true; this.exitPayload = null; this.editSessionStartedAt ||= Date.now(); this.setSyncStatus("保存中…", "saving"); this.savePersonalDebounced(); }
    });
    this.root.querySelector('[data-role="personal-empty"]').hidden = !this.editor.isEmpty;
  }

  async savePersonal(force = false, options = {}) {
    if (!this.editor || !this.noteId || (!force && !this.editor.isEditable)) return;
    const fiveMinutes = 5 * 60 * 1000;
    const timedSnapshot = this.editSessionStartedAt && Date.now() - this.editSessionStartedAt >= fiveMinutes;
    const payload = options.payload || { content: this.editor.getJSON(), baseRevision: this.personal.revision || 0, clientMutationId: uid("personal"), createRevision: Boolean(options.createRevision || timedSnapshot), reason: options.reason || (timedSnapshot ? "five-minute" : "autosave") };
    if (!navigator.onLine) { await this.queueOutbox(payload); return this.setSyncStatus("离线待同步", "offline"); }
    this.setSyncStatus("保存中…", "saving");
    try {
      const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/personal-document`, { method: "PUT", body: JSON.stringify(payload) });
      this.personal = result.document || result.personalDocument || result;
      this.personalDirty = false;
      if (payload.createRevision) this.editSessionStartedAt = null;
      this.setSyncStatus("已保存", "saved"); await this.clearOutbox(payload.clientMutationId);
    } catch (error) {
      if (error.status === 409 || error.code === "REVISION_CONFLICT") return this.showConflict(error, payload);
      await this.queueOutbox(payload); this.setSyncStatus("保存失败 · 将自动重试", "error");
    }
  }

  async flushPersonal(createRevision = false, reason = "leave") {
    if (!this.editor) return;
    const pending = this.savePersonalDebounced.flush();
    if (pending) await pending;
    if (createRevision) await this.snapshotPersonal(reason);
  }

  savePersonalForExit(reason) {
    if (!this.editor || !this.noteId || !this.personalLoaded) return;
    this.savePersonalDebounced.cancel();
    const content = this.editor.getJSON();
    let queuedPayload = null;
    try {
      const queued = JSON.parse(localStorage.getItem(`inspiration-outbox:${this.noteId}`));
      if (queued?.payload && JSON.stringify(queued.payload.content) === JSON.stringify(content)) queuedPayload = queued.payload;
    } catch {}
    const payload = this.exitPayload || queuedPayload || { content, baseRevision: this.personal.revision || 0, clientMutationId: uid("personal-exit"), createRevision: true, reason };
    this.exitPayload = payload;
    this.queueOutbox(payload);
    fetch(`api/notes/${encodeURIComponent(this.noteId)}/personal-document`, { method: "PUT", headers: { "content-type": "application/json" }, credentials: "same-origin", keepalive: true, body: JSON.stringify(payload) }).then(async response => {
      if (!response.ok) return;
      const result = await response.json();
      this.personal = result.document || result;
      this.personalDirty = false;
      this.editSessionStartedAt = null;
      await this.clearOutbox(payload.clientMutationId);
      if (this.exitPayload?.clientMutationId === payload.clientMutationId) this.exitPayload = null;
    }).catch(() => {});
  }

  async snapshotPersonal(reason = "manual") {
    if (!this.noteId || !this.personal?.updatedAt) return null;
    try {
      const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/personal-document/revisions`, { method: "POST", body: JSON.stringify({ reason }) });
      if (reason === "manual") this.announce(result.snapshot?.created ? "已保存新版本" : "内容未变化，无需重复保存");
      return result.snapshot;
    } catch (error) { if (reason === "manual") this.toastError(error); return null; }
  }
  setSyncStatus(text, state = "") { const node = this.root.querySelector('[data-role="sync-status"]'); node.textContent = text; node.dataset.state = state; }

  showConflict(error, localPayload) {
    this.conflict = { localPayload, server: error.current || error.details?.resource || error.details?.current || error.serverResource || null };
    this.root.querySelector('[data-role="conflict"]').hidden = false;
    this.setSyncStatus("版本冲突", "conflict");
  }

  async resolveConflict(useLocal) {
    const dialog = this.root.querySelector('[data-role="conflict"]');
    if (!this.conflict) return dialog.hidden = true;
    if (!useLocal) {
      const server = this.conflict.server;
      if (server?.contentJson || server?.content_json || server?.content) { this.personal = server; this.editor.commands.setContent(server.contentJson || server.content_json || server.content); }
      else { this.personalLoaded = false; await this.loadPersonal(); }
      this.setSyncStatus("已载入服务器版本", "saved");
    } else {
      const revision = this.conflict.server?.revision ?? this.conflict.localPayload.baseRevision;
      this.personal.revision = revision;
      await this.savePersonal(true);
    }
    this.conflict = null; dialog.hidden = true;
  }

  openOutbox() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("inspiration-workspace", 1);
      request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async queueOutbox(payload) {
    const item = { id: `${this.noteId}:personal`, noteId: this.noteId, payload, updatedAt: Date.now() };
    try { localStorage.setItem(`inspiration-outbox:${this.noteId}`, JSON.stringify(item)); } catch {}
    try { const db = await this.openOutbox(); const tx = db.transaction("outbox", "readwrite"); tx.objectStore("outbox").put(item); } catch {}
  }
  async readOutbox() {
    try { const local = JSON.parse(localStorage.getItem(`inspiration-outbox:${this.noteId}`)); if (local) return local; } catch {}
    try { const db = await this.openOutbox(); return await new Promise(resolve => { const request = db.transaction("outbox", "readonly").objectStore("outbox").get(`${this.noteId}:personal`); request.onsuccess = () => resolve(request.result || null); request.onerror = () => resolve(null); }); } catch { return null; }
  }
  async clearOutbox() { try { localStorage.removeItem(`inspiration-outbox:${this.noteId}`); } catch {} try { const db = await this.openOutbox(); const tx = db.transaction("outbox", "readwrite"); tx.objectStore("outbox").delete(`${this.noteId}:personal`); } catch {} }
  async flushOutbox() { const item = await this.readOutbox(); if (!item || !this.editor) return; this.personal.revision = item.payload.baseRevision; await this.savePersonal(true, { payload: item.payload }); }

  insertExcerpt() {
    if (!this.selection?.text) return;
    const text = this.selection.text;
    const anchor = this.createAnchor(this.selection.parts[0]);
    this.setMode("personal").then(() => {
      const title = this.workspace?.inspiration?.title || this.legacy.title || "原视频";
      const url = this.workspace?.inspiration?.url || this.legacy.url || "";
      const source = { type: "text", text: `来源：${title}` };
      if (url) source.marks = [{ type: "link", attrs: { href: url, target: "_blank", rel: "noopener noreferrer", class: null } }];
      this.editor.chain().focus().insertContent([{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, { type: "paragraph", content: [source] }]).run();
      this.announce("已摘到加工稿");
    });
  }

  async createActionItem() {
    if (!this.selection?.text || !this.noteId) return;
    const title = compact(this.selection.text, 80);
    try { const annotations = await this.addAnnotation("highlight", "action"); await this.api(`api/notes/${encodeURIComponent(this.noteId)}/action-items`, { method: "POST", body: JSON.stringify({ title, note: "", sourceAnnotationId: annotations?.[0]?.id || null }) }); this.announce("已加入待实践"); }
    catch (error) { this.toastError(error); }
  }

  async selectionAi(type) {
    if (!this.selection?.text || !this.noteId) return;
    const captured = { ...this.selection, parts: this.selection.parts.map(part => ({ ...part, anchor: this.createAnchor(part) })) };
    this.showSheet(`<div class="tw-ai-result"><strong>AI 正在处理选中的内容…</strong><p>结果会保存为这句话的批注。</p></div>`);
    try {
      const operation = { explain: "explain", counterexample: "counterexample", case: "cases", action_steps: "steps" }[type] || type;
      const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/selection-ai`, { method: "POST", headers: { "Idempotency-Key": uid("selection-ai") }, body: JSON.stringify({ provider: this.getProvider(), operation, documentId: this.document.id, anchor: captured.parts[0].anchor, selectedText: captured.text, context: this.selectionContext(captured), groupId: uid("selection-ai-group") }) });
      const annotation = result.result?.annotation || result.annotation || result.item;
      if (annotation) this.annotations.push(annotation);
      this.refreshAnnotationBlocks(annotation ? [annotation] : []); this.renderAnnotations();
      this.showSheet(`<div class="tw-ai-result"><strong>${escapeHtml({ explain: "AI 解释", counterexample: "AI 反例", case: "补充案例", action_steps: "行动步骤" }[type] || "AI 批注")}</strong><div class="tw-markdown">${safeMarkdown(result.result?.content || result.markdown || annotation?.comment || result.content || "")}</div></div>`);
    } catch (error) { this.showSheet(`<div class="tw-ai-result tw-ai-error"><strong>生成失败 · HTTP ${escapeHtml(error.status || "未知")} · ${escapeHtml(error.code || "HTTP_ERROR")}</strong><p>${escapeHtml(error.message)}</p>${error.details ? `<code>${escapeHtml(error.details)}</code>` : ""}<button class="primary" data-retry-ai="${escapeHtml(type)}">重试</button></div>`); }
  }

  selectionContext(selection) {
    const blocks = this.document?.blocks || [];
    const first = blocks.findIndex(item => item.id === selection.parts[0].block.dataset.blockId);
    return blocks.slice(Math.max(0, first - 1), first + selection.parts.length + 1).map(item => item.text).join("\n");
  }

  async export(mode) {
    if (!this.noteId) return;
    try {
      const response = await fetch(`api/notes/${encodeURIComponent(this.noteId)}/export?mode=${encodeURIComponent(mode)}`, { credentials: "same-origin" });
      if (!response.ok) throw Object.assign(new Error(`导出失败 (${response.status})`), { status: response.status });
      const type = response.headers.get("content-type") || "";
      const payload = type.includes("json") ? await response.json() : null;
      const text = payload ? payload.export?.content ?? payload.content : await response.text();
      if (typeof text !== "string") throw new Error("导出内容为空");
      await navigator.clipboard.writeText(text); this.announce("内容已复制");
    } catch (error) { this.toastError(error); }
    this.root.querySelector('[data-role="export-menu"]').hidden = true;
  }

  async setMode(mode) {
    this.mode = mode;
    this.root.querySelectorAll("[data-mode]").forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle("is-active", active); button.setAttribute("aria-selected", String(active)); });
    this.root.querySelector('[data-pane="source"]').hidden = mode !== "source";
    this.root.querySelector('[data-pane="personal"]').hidden = mode !== "personal";
    this.root.querySelector('[data-role="version"]').closest("label").hidden = mode !== "source";
    this.updateVersionDeleteButton();
    if (mode === "personal") await this.loadPersonal(); else this.flushPersonal();
    return this;
  }

  showCommentSheet(value = "", onSave) {
    this.commentSave = onSave;
    this.showSheet(`<form class="tw-comment-form" data-role="comment-form"><label>写下你的批注<textarea maxlength="4000" rows="5" placeholder="这句话让我想到……">${escapeHtml(value)}</textarea></label><div><button type="button" data-action="close-sheet">取消</button><button class="primary" type="submit">保存批注</button></div></form>`);
    const form = this.root.querySelector('[data-role="comment-form"]');
    form.onsubmit = event => { event.preventDefault(); const comment = form.querySelector("textarea").value.trim(); if (!comment) return; this.commentSave?.(comment); this.closeSheet(); };
    setTimeout(() => form.querySelector("textarea").focus(), 20);
  }

  showSheet(html) { const sheet = this.root.querySelector('[data-role="sheet"]'); sheet.querySelector('[data-role="sheet-content"]').innerHTML = html; sheet.hidden = false; }
  closeSheet() { this.root.querySelector('[data-role="sheet"]').hidden = true; }

  showAnnotationDetails(ids) {
    const items = String(ids || "").split(",").map(id => this.annotations.find(item => String(item.id) === id)).filter(Boolean);
    if (!items.length) return;
    this.showSheet(`<div class="tw-annotation-details"><strong>这句话的标注</strong>${items.map(item => `<article><span>${escapeHtml(item.kind === "ai_note" ? "AI 批注" : item.kind === "comment" ? "我的批注" : item.kind === "underline" ? "下划线" : COLOR_LABELS[item.color] || "高亮")}</span>${item.comment ? `<p>${escapeHtml(item.comment)}</p>` : ""}<div>${item.comment ? `<button data-edit-comment="${escapeHtml(item.id)}">编辑</button>` : ""}<button data-delete-annotation="${escapeHtml(item.id)}">删除</button></div></article>`).join("")}</div>`);
  }

  jumpToAnnotation(id) {
    this.ensureAnnotationRendered(id);
    this.activateAnnotation(id);
    const item = this.annotations.find(annotation => String(annotation.id) === String(id));
    const anchor = this.currentAnchor(item || {}); const blockId = anchor?.blockId || anchor?.position?.blockId;
    const block = [...this.root.querySelectorAll("[data-block-id]")].find(node => node.dataset.blockId === blockId);
    if (block) { block.scrollIntoView({ behavior: "smooth", block: "center" }); block.classList.remove("tw-pulse"); requestAnimationFrame(() => { block.classList.add("tw-pulse"); this.scheduleConnectors(); }); block.focus({ preventScroll: true }); }
  }

  async annotationHistory(direction) {
    const source = direction === "undo" ? this.annotationUndo : this.annotationRedo;
    const target = direction === "undo" ? this.annotationRedo : this.annotationUndo;
    const command = source.pop(); if (!command) return;
    if (command.type === "add") {
      for (const item of command.items) await this.deleteAnnotation(item.id, false);
      target.push({ type: "delete", items: command.items });
    } else if (command.type === "delete") {
      const restored = [];
      for (const item of command.items) {
        try {
          const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/annotations`, { method: "POST", headers: { "Idempotency-Key": uid("annotation-restore") }, body: JSON.stringify({ groupId: item.groupId, anchorScope: item.anchorScope, sourceTranscriptVersionId: item.sourceTranscriptVersionId, canonicalAnchor: item.canonicalAnchor, displayReadingDocumentId: item.displayReadingDocumentId, displayAnchor: item.displayAnchor, kind: item.kind, color: item.color, comment: item.comment }) });
          restored.push(result.annotation || result.item || result);
        } catch (error) { this.toastError(error); break; }
      }
      this.annotations.push(...restored); this.refreshAnnotationBlocks(restored); this.renderAnnotations(); target.push({ type: "add", items: restored });
    }
  }

  onKeydown(event) {
    if (event.key === "Escape") { this.hideSelectionTools(); this.closeSheet(); return; }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && activeWorkspace !== this) return;
    if (mod && event.shiftKey && event.key.toLowerCase() === "h") { event.preventDefault(); this.addAnnotation("highlight", "key"); }
    if (mod && event.altKey && event.key.toLowerCase() === "m") { event.preventDefault(); this.showCommentSheet("", comment => this.addAnnotation("comment", null, comment)); }
    if (mod && event.key.toLowerCase() === "z" && this.mode === "source") { event.preventDefault(); this.annotationHistory(event.shiftKey ? "redo" : "undo"); }
  }

  async onClick(event) {
    const marked = event.target.closest("[data-annotation-ids]");
    if (marked && this.root.contains(marked)) { this.showAnnotationDetails(marked.dataset.annotationIds); return; }
    const button = event.target.closest("button");
    if (!button || !this.root.contains(button)) return;
    if (button.dataset.mode) return this.setMode(button.dataset.mode);
    if (button.dataset.filter) { this.filter = button.dataset.filter; this.annotationRenderLimit = 36; this.annotationWindowStart = 0; this.root.querySelectorAll("[data-filter]").forEach(item => item.classList.toggle("is-active", item === button)); this.renderAnnotations(); return; }
    if (button.dataset.jumpAnnotation) return this.jumpToAnnotation(button.dataset.jumpAnnotation);
    if (button.dataset.deleteAnnotation) return this.deleteAnnotation(button.dataset.deleteAnnotation);
    if (button.dataset.editComment) return this.editComment(button.dataset.editComment);
    if (button.dataset.reanchor) return this.reanchor(button.dataset.reanchor);
    if (button.dataset.retryAi) return this.selectionAi(button.dataset.retryAi);
    if (button.dataset.ai) return this.selectionAi(button.dataset.ai);
    if (button.dataset.export) return this.export(button.dataset.export);
    if (button.dataset.editor) return this.editorCommand(button.dataset.editor);
    switch (button.dataset.action) {
      case "highlight": {
        if (matchMedia("(pointer: coarse)").matches) {
          this.showSheet(`<div class="tw-mobile-colors" role="group" aria-label="选择高亮颜色"><strong>选择高亮颜色</strong><div>${Object.entries(COLOR_LABELS).map(([color, label]) => `<button type="button" data-color="${color}"><span class="tw-swatch tw-swatch-${color}"></span><span>${label}</span></button>`).join("")}</div></div>`);
        } else {
          const colors = this.root.querySelector(".tw-colors"); colors.hidden = !colors.hidden;
        }
        break;
      }
      case "underline": await this.addAnnotation("underline"); break;
      case "comment": this.showCommentSheet("", comment => this.addAnnotation("comment", null, comment)); break;
      case "more": {
        if (matchMedia("(pointer: coarse)").matches) this.showSheet(`<div class="tw-mobile-more"><button data-action="copy-selection">复制</button><button data-action="excerpt">摘到加工稿</button><button data-action="action-item">转为待实践</button><button data-ai="explain">AI 解释</button><button data-ai="counterexample">AI 反例</button><button data-ai="case">AI 补充案例</button><button data-ai="action_steps">AI 行动步骤</button></div>`);
        else { const menu = this.root.querySelector('[data-role="more-menu"]'); menu.hidden = !menu.hidden; }
        break;
      }
      case "copy-selection": await navigator.clipboard.writeText(this.selection?.text || ""); this.announce("选中内容已复制"); break;
      case "excerpt": this.closeSheet(); this.insertExcerpt(); break;
      case "action-item": this.closeSheet(); await this.createActionItem(); break;
      case "toggle-export": { const menu = this.root.querySelector('[data-role="export-menu"]'); menu.hidden = !menu.hidden; button.setAttribute("aria-expanded", String(!menu.hidden)); break; }
      case "toggle-index": { const rail = button.closest(".tw-annotation-rail"); rail.classList.toggle("is-collapsed"); button.setAttribute("aria-expanded", String(!rail.classList.contains("is-collapsed"))); break; }
      case "load-more-annotations": this.annotationRenderLimit += this.annotationBatchSize; this.renderAnnotations(); break;
      case "load-previous-annotations": this.annotationWindowStart = Math.max(0, this.annotationWindowStart - this.annotationBatchSize); this.renderAnnotations(); break;
      case "delete-version": await this.deleteCurrentVersion(); break;
      case "close-sheet": this.closeSheet(); break;
      case "confirm-reanchor": await this.confirmReanchor(); break;
      case "cancel-reanchor": this.pendingReanchor = null; this.root.querySelector('[data-role="reanchor-banner"]').hidden = true; break;
      case "blank-personal": this.root.querySelector('[data-role="personal-empty"]').hidden = true; this.editor?.commands.focus(); break;
      case "draft-from-highlights": this.createDraftFromHighlights(); break;
      case "use-server": await this.resolveConflict(false); break;
      case "use-local": await this.resolveConflict(true); break;
      case "personal-snapshot": await this.flushPersonal(); await this.snapshotPersonal("manual"); break;
      case "personal-history": await this.showPersonalHistory(); break;
      case "retry-editor": this.personalLoaded = false; await this.loadPersonal(); break;
    }
    if (button.dataset.color) {
      this.closeSheet();
      await this.addAnnotation("highlight", button.dataset.color);
    }
  }

  editorCommand(command) {
    if (!this.editor) return;
    const chain = this.editor.chain().focus();
    ({ undo: () => chain.undo(), redo: () => chain.redo(), bold: () => chain.toggleBold(), italic: () => chain.toggleItalic(), underline: () => chain.toggleUnderline(), highlight: () => chain.toggleHighlight(), heading: () => chain.toggleHeading({ level: 2 }), bullet: () => chain.toggleBulletList(), quote: () => chain.toggleBlockquote(), clear: () => chain.unsetAllMarks().clearNodes() }[command]?.()).run();
  }

  createDraftFromHighlights() {
    const highlights = this.annotations.filter(item => item.kind === "highlight");
    const content = highlights.map(item => ({ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: annotationAnchor(item)?.quote?.exact || item.excerpt || "" }] }] }));
    if (!content.length) return this.announce("还没有高亮内容", true);
    this.editor.commands.setContent({ type: "doc", content }); this.root.querySelector('[data-role="personal-empty"]').hidden = true; this.editor.commands.focus("end");
  }

  async showPersonalHistory() {
    if (!this.noteId) return;
    try {
      const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/personal-document/revisions`);
      const items = result.items || result.revisions || [];
      this.showSheet(`<div class="tw-revisions"><strong>加工稿版本记录</strong>${items.length ? items.map(item => `<article><div><b>版本 ${item.revision}</b><span>${new Date(item.createdAt).toLocaleString("zh-CN")}</span></div><button data-restore-revision="${item.revision}">恢复此版本</button></article>`).join("") : "<p>编辑满一段时间或离开页面后，会在这里保留版本。</p>"}</div>`);
      this.root.querySelectorAll("[data-restore-revision]").forEach(button => button.onclick = () => this.restoreRevision(button.dataset.restoreRevision));
    } catch (error) { this.toastError(error); }
  }

  async restoreRevision(revision) {
    try { const result = await this.api(`api/notes/${encodeURIComponent(this.noteId)}/personal-document/revisions/${encodeURIComponent(revision)}/restore`, { method: "POST", body: JSON.stringify({ baseRevision: this.personal.revision }) }); this.personal = result.document || result; this.editor.commands.setContent(this.personal.contentJson || this.personal.content_json || this.personal.content); this.closeSheet(); this.announce("已恢复为新版本"); }
    catch (error) { this.toastError(error); }
  }

  announce(text, error = false) { this.setSyncStatus(text, error ? "error" : "saved"); }
  toastError(error) { this.announce(`${error.message || "操作失败"}${error.code ? ` · ${error.code}` : ""}`, true); }

  destroy({ persist = true } = {}) {
    if (persist) this.savePersonalForExit("destroy");
    this.savePersonalDebounced.cancel(); this.editor?.destroy();
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("scroll", this.onScroll, { capture: true });
    document.removeEventListener("keydown", this.onKeydownEvent);
    window.removeEventListener("resize", this.onResize); cancelAnimationFrame(this.connectorFrame); this.annotationObserver?.disconnect();
    if (activeWorkspace === this) activeWorkspace = null;
    window.removeEventListener("online", this.onOnline); window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility); window.removeEventListener("pagehide", this.onPageHide);
  }
}

export default TranscriptWorkspace;
