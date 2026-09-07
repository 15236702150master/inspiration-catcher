import TranscriptWorkspace from "./src/workspace.js";
import "./src/workspace.css";

const $ = selector => document.querySelector(selector);
let video = null;
let provider = "deepseek";
let transcript = "";
let formattedTranscript = "";
let formatRequestSeq = 0;
let noteView = "all";
let markPending = false;
let selectedTags = [];
let libraries = [];
let selectedLibraryId = "";
let libraryFilterId = "all";
let existingTags = [];
let loadedNotes = [];
let loadedAnalyses = [];
let currentNoteId = null;
let tagCatalog = { groups: [] };
let authMode = "login";
let openedNote = null;
let quickWorkspace = null;
let noteWorkspace = null;
let feishuStatus = { configured: false, connection: null, sync: { pending: 0, processing: 0, failed: 0 }, bindings: [], unavailable: false };
let feishuSpaces = [];
let feishuSpacesLoaded = false;
let feishuSpacesLoading = false;
let feishuPollTimer = null;
let feishuReturnFocus = null;
let feishuFormDraft = null;
let feishuComposing = false;
const tagName = tag => typeof tag === "string" ? tag : tag.name;
const ANALYSIS_TYPE_ORDER = { video: 0, cases: 1 };
const sortAnalyses = (items = []) => items
  .map((item, index) => ({ item, index }))
  .sort((left, right) => (ANALYSIS_TYPE_ORDER[left.item.type] ?? 99) - (ANALYSIS_TYPE_ORDER[right.item.type] ?? 99) || left.index - right.index)
  .map(({ item }) => item);

function isArticleOrDocumentSource(value = {}) {
  const platform = String(value.platform || value.kind || "").toLowerCase();
  const url = String(value.url || value.sourceUrl || value.webpageUrl || "").toLowerCase();
  return /wechat_article|article|uploaded_|document|pdf|docx|word/.test(platform) || /^upload:\/\//.test(url) || /mp\.weixin\.qq\.com\/s\//.test(url);
}
function isRestorableTranscription(value = {}) {
  const hasTranscriptWork = Boolean(value.transcriptionJobId || value.transcription_job_id || value.transcript || value.formattedTranscript || value.formatted_transcript);
  return hasTranscriptWork && !isArticleOrDocumentSource(value);
}
function resetQuickCaptureEntry() {
  if ($("#url")) $("#url").value = "";
  if ($("#articleUrl")) $("#articleUrl").value = "";
  if ($("#note")) $("#note").value = "";
  if ($("#documentFileName")) $("#documentFileName").textContent = "";
  if ($("#recoveryBox")) { $("#recoveryBox").hidden = true; $("#recoveryBox").innerHTML = ""; }
}

async function api(path, options = {}) {
  path = path.replace(/^\//, "");
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  } catch (error) {
    throw new Error("无法连接灵感捕手服务。请使用“打开线上版.bat”，不要直接双击 index.html；本地版请先运行“启动本地版.bat”。");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) { showAuth(); throw Object.assign(new Error("请先登录"), { code: "AUTH_REQUIRED", status: 401 }); }
    throw Object.assign(new Error(payload.error?.message || `请求失败 (${response.status})`), { code: payload.error?.code || "HTTP_ERROR", status: response.status, details: payload.error?.details || "" });
  }
  return payload;
}

function showAuth(mode = authMode) { authMode = mode; $("#authScreen").hidden = false; $("#authIntro").textContent = mode === "login" ? "登录后继续记录和整理你的灵感" : "注册一个账号，开始保存你的灵感"; $("#authSubmit").textContent = mode === "login" ? "登录" : "注册"; $("#authSwitchText").textContent = mode === "login" ? "还没有账号？" : "已有账号？"; $("#authSwitch").textContent = mode === "login" ? "注册" : "登录"; $("#authPassword").autocomplete = mode === "login" ? "current-password" : "new-password"; }
async function loadWorkspace() {
  await Promise.all([loadHealth(), loadTagCatalog(), loadLibraries(), loadFeishuStatus({ silent: true })]);
  await loadNotes();
  await loadJobs();
  await loadAnalyses();
}
async function initAuth() { try { const response = await fetch("api/auth/me", { credentials: "same-origin" }); const result = await response.json(); if (!result.authenticated) return showAuth(); $("#authScreen").hidden = true; await loadWorkspace(); await handleFeishuOAuthReturn(); await handleFeishuSetupShortcut(); } catch { showAuth(); } }

function busy(button, active, text) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = active;
  button.textContent = active ? text : button.dataset.label;
}

function message(text, error = false) {
  $("#message").textContent = text;
  $("#message").classList.toggle("error", error);
}

async function loadHealth() {
  try {
    const { capabilities } = await api("api/health");
    const configured = Object.values(capabilities.providers).filter(Boolean).length;
    const total = Object.keys(capabilities.providers).length;
    $("#health").textContent = `服务正常 · ${configured}/${total} AI 已配置`;
  } catch { $("#health").textContent = "服务连接失败"; $("#health").style.color = "#d65757"; }
}

const FEISHU_REQUIRED_ENV = ["INTEGRATION_ENCRYPTION_KEY"];
const feishuCallbackFallback = () => `${location.origin}/api/integrations/feishu/oauth/callback`;

function feishuConnectionState() {
  if (feishuStatus.unavailable || !feishuStatus.configured) return "unconfigured";
  if (feishuStatus.status === "app_missing" || feishuStatus.appConfigured === false) return "app_missing";
  if (!feishuStatus.connection) return "disconnected";
  const state = String(feishuStatus.connection.status || "connected").toLowerCase();
  if (["reauthorize", "permission_error", "auth_required", "unauthorized"].includes(state)) return "reauthorize";
  if (state === "paused") return "paused";
  return "connected";
}

function feishuBindingFor(noteOrId) {
  const note = typeof noteOrId === "object" ? noteOrId : loadedNotes.find(item => String(item.id) === String(noteOrId));
  const id = typeof noteOrId === "object" ? noteOrId.id : noteOrId;
  const direct = note?.feishuSync || note?.feishu || note?.integrations?.feishu || null;
  const stored = (feishuStatus.bindings || []).find(item => String(item.inspirationId ?? item.inspiration_id) === String(id));
  if (!direct && !stored && !note?.feishuDocumentUrl && !note?.feishuSyncStatus) return null;
  return {
    ...(direct || {}),
    ...(stored || {}),
    inspirationId: stored?.inspirationId ?? stored?.inspiration_id ?? direct?.inspirationId ?? direct?.inspiration_id ?? id,
    syncStatus: stored?.syncStatus ?? stored?.sync_status ?? stored?.status ?? direct?.syncStatus ?? direct?.sync_status ?? direct?.status ?? note?.feishuSyncStatus ?? "pending",
    documentUrl: stored?.documentUrl ?? stored?.document_url ?? direct?.documentUrl ?? direct?.document_url ?? note?.feishuDocumentUrl ?? "",
    lastSyncedAt: stored?.lastSyncedAt ?? stored?.last_synced_at ?? stored?.syncedAt ?? direct?.lastSyncedAt ?? direct?.last_synced_at ?? direct?.syncedAt ?? ""
  };
}

function normalizedFeishuSyncState(binding) {
  if (!binding) return "";
  const raw = String(binding.syncStatus || binding.status || "pending").toLowerCase();
  if (["synced", "success", "succeeded", "completed", "complete"].includes(raw)) return "synced";
  if (["syncing", "processing", "running", "leased"].includes(raw)) return "syncing";
  if (["failed", "error", "permission_error"].includes(raw)) return "failed";
  if (["reauthorize", "auth_required", "unauthorized"].includes(raw)) return "reauthorize";
  if (raw === "paused") return "paused";
  if (["disconnected", "not_connected"].includes(raw)) return "disconnected";
  return "pending";
}

function feishuSyncLabel(binding) {
  const state = normalizedFeishuSyncState(binding);
  if (state === "synced") {
    const value = binding.lastSyncedAt;
    if (value) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return `已同步 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    }
    return "已同步";
  }
  return { syncing: "同步中", failed: "同步失败", reauthorize: "需重新授权", paused: "已暂停", disconnected: "已停止同步", pending: "待同步" }[state] || "待同步";
}

function effectiveFeishuBinding(binding, inspirationId) {
  const connectionState = feishuConnectionState();
  const effective = binding ? { ...binding } : { inspirationId, syncStatus: "pending" };
  if (connectionState === "reauthorize") effective.syncStatus = "reauthorize";
  else if (connectionState === "paused") effective.syncStatus = "paused";
  else if (connectionState === "disconnected" && binding) effective.syncStatus = "disconnected";
  return effective;
}

function feishuSyncChip(note) {
  const binding = feishuBindingFor(note);
  if (!binding) return "";
  const effective = effectiveFeishuBinding(binding, note.id);
  const state = normalizedFeishuSyncState(effective);
  const label = feishuSyncLabel(effective);
  return `<button class="feishu-sync-chip" data-state="${state}" data-feishu-note="${escapeHtml(String(note.id))}" type="button" title="${escapeHtml(label)}"><span>${escapeHtml(label)}</span></button>`;
}

function renderNoteFeishu(note = openedNote) {
  const root = $("#noteFeishu");
  if (!root || !note) return;
  const binding = feishuBindingFor(note);
  const connectionState = feishuConnectionState();
  if (!binding && !["connected", "paused", "reauthorize"].includes(connectionState)) { root.innerHTML = ""; return; }
  const effective = effectiveFeishuBinding(binding, note.id);
  const state = normalizedFeishuSyncState(effective);
  const documentUrl = effective.documentUrl || "";
  const errorCode = effective.lastErrorCode || effective.last_error_code || effective.error?.code || "";
  const errorMessage = effective.lastErrorMessage || effective.last_error_message || effective.error?.message || "";
  const errorDetails = state === "failed" && (errorCode || errorMessage)
    ? `<span class="feishu-note-error" role="status">${escapeHtml([errorCode, errorMessage].filter(Boolean).join(" · "))}</span>`
    : "";
  const archiveAction = connectionState === "connected" && binding && note.status !== "feishu_archiving"
    ? `<button class="secondary" data-note-feishu-action="archive" type="button">保存到飞书并清理本地</button>`
    : note.status === "feishu_archiving" ? `<span class="hint">飞书保存成功后将清理本地正文和图片</span>` : "";
  root.innerHTML = `<span class="feishu-sync-chip" data-state="${state}"><span>${escapeHtml(feishuSyncLabel(effective))}</span></span>${errorDetails}${documentUrl ? `<button class="secondary" data-note-feishu-action="open" type="button">打开飞书</button>` : ""}${state === "failed" ? `<button class="secondary" data-note-feishu-action="retry" type="button">立即重试</button>` : ["reauthorize", "disconnected"].includes(state) ? `<button class="secondary" data-note-feishu-action="settings" type="button">${state === "reauthorize" ? "重新连接" : "连接设置"}</button>` : !binding && connectionState === "connected" ? `<button class="secondary" data-note-feishu-action="sync" type="button">保存到飞书</button>` : ""}${archiveAction}`;
}

function captureFeishuFormDraft() {
  const space = $("#feishuSpace");
  if (!space) return;
  feishuFormDraft = {
    spaceId: space.value,
    parentNode: $("#feishuParentNode")?.value || "",
    syncPolicy: document.querySelector('input[name="feishuPolicy"]:checked')?.value || "new_only",
  };
}

function feishuFormHasFocus() {
  const active = document.activeElement;
  return Boolean(active && $("#feishuContent")?.contains(active) && active.matches("input,select,textarea"));
}

async function loadFeishuStatus({ silent = false } = {}) {
  try {
    const result = await api("api/integrations/feishu/status");
    feishuStatus = {
      ...result,
      configured: Boolean(result.configured),
      connection: result.connection || null,
      sync: { pending: 0, processing: 0, failed: 0, ...(result.sync || {}) },
      bindings: result.bindings || [],
      unavailable: false
    };
  } catch (error) {
    feishuStatus = {
      configured: false,
      connection: null,
      callbackUrl: feishuCallbackFallback(),
      requiredEnv: FEISHU_REQUIRED_ENV,
      sync: { pending: 0, processing: 0, failed: 0 },
      bindings: [],
      unavailable: error.status === 404,
      error
    };
    if (!silent && error.status !== 404) setFeishuMessage(error.message, true);
  }
  renderNotes();
  if (openedNote) renderNoteFeishu(openedNote);
  if (!$("#feishuModal")?.hidden && !feishuComposing && !feishuFormHasFocus()) renderFeishuPanel();
  return feishuStatus;
}

function defaultLibrary() {
  return libraries.find(item => item.isDefault) || libraries.find(item => item.name === "待分类") || libraries[0] || null;
}

function noteLibraryId(note = {}) {
  return String(note.libraryId || note.library_id || note.library?.id || defaultLibrary()?.id || "");
}

function libraryName(id) {
  return libraries.find(item => String(item.id) === String(id))?.name || "待分类";
}

function libraryOptions(selected = "") {
  return libraries.map(item => `<option value="${escapeHtml(String(item.id))}" ${String(item.id) === String(selected) ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
}

async function loadLibraries() {
  try {
    const result = await api("api/libraries");
    libraries = result.items || [];
    if (!selectedLibraryId || !libraries.some(item => String(item.id) === String(selectedLibraryId))) selectedLibraryId = String(defaultLibrary()?.id || "");
    if (libraryFilterId !== "all" && !libraries.some(item => String(item.id) === String(libraryFilterId))) libraryFilterId = "all";
    renderLibraries();
  } catch (error) {
    libraries = [];
    if (error.status !== 404) message(`灵感库读取失败：${error.message}`, true);
  }
}

function renderLibraries() {
  const defaultItem = defaultLibrary();
  const captureSelect = $("#captureLibrarySelect");
  if (captureSelect) {
    captureSelect.innerHTML = libraryOptions(selectedLibraryId);
    captureSelect.value = selectedLibraryId || String(defaultItem?.id || "");
  }
  const filter = $("#libraryFilter");
  if (filter) {
    filter.innerHTML = `<option value="all">全部灵感库</option>${libraryOptions(libraryFilterId)}`;
    filter.value = libraryFilterId;
  }
  const list = $("#libraryList");
  if (list) list.innerHTML = `<div class="library-row ${libraryFilterId === "all" ? "is-active" : ""}"><button class="library-filter-button" data-library-filter="all" type="button"><span>全部灵感</span><b>${loadedNotes.length}</b></button></div>${libraries.map(item => `<div class="library-row ${String(libraryFilterId) === String(item.id) ? "is-active" : ""}"><button class="library-filter-button" data-library-filter="${escapeHtml(String(item.id))}" type="button"><span>${escapeHtml(item.name)}</span><b>${Number(item.noteCount) || 0}</b></button><button class="library-icon-button" data-library-rename="${escapeHtml(String(item.id))}" type="button" title="重命名 ${escapeHtml(item.name)}" aria-label="重命名 ${escapeHtml(item.name)}">✎</button>${item.isDefault ? "" : `<button class="library-icon-button is-danger" data-library-delete="${escapeHtml(String(item.id))}" type="button" title="删除 ${escapeHtml(item.name)}" aria-label="删除 ${escapeHtml(item.name)}">×</button>`}</div>`).join("")}`;
  const currentLabel = $("#captureLibraryCurrent");
  if (currentLabel) currentLabel.textContent = libraryName(selectedLibraryId);
  const archiveButton = $("#archiveLibrary");
  if (archiveButton) {
    const current = libraries.find(item => String(item.id) === String(libraryFilterId));
    archiveButton.disabled = !current || feishuConnectionState() !== "connected" || Number(current.noteCount || 0) === 0;
    archiveButton.title = current ? `保存“${current.name}”到飞书，成功后清理本地正文和图片` : "先选择一个灵感库";
  }
}

async function createLibrary(name, { select = false } = {}) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const result = await api("api/libraries", { method: "POST", body: JSON.stringify({ name: clean }) });
  await loadLibraries();
  const created = result.item || result.library || libraries.find(item => item.name === clean);
  if (select && created?.id) { selectedLibraryId = String(created.id); renderLibraries(); }
  return created;
}

async function moveNoteToLibrary(noteId, libraryId) {
  await api(`api/notes/${encodeURIComponent(noteId)}/move-library`, { method: "POST", body: JSON.stringify({ libraryId }) });
  await Promise.all([loadLibraries(), loadNotes()]);
  if (openedNote && String(openedNote.id) === String(noteId)) {
    openedNote = loadedNotes.find(item => String(item.id) === String(noteId)) || openedNote;
    renderNoteLibrary(openedNote);
  }
}

function renderNoteLibrary(note = openedNote) {
  if (!note) return;
  const select = $("#noteLibrarySelect");
  if (!select) return;
  const id = noteLibraryId(note);
  select.innerHTML = libraryOptions(id);
  select.value = id;
}

async function loadNotes() {
  const { items } = await api("api/notes");
  loadedNotes = items;
  renderTags(); renderSuggestions(existingTags);
  renderLibraries();
  renderNotes();
}

function renderNotes() {
  const filtered = loadedNotes.filter(item => !["feishu_archived", "feishu_archiving"].includes(item.status) && (noteView !== "pending" || item.status === "pending") && (libraryFilterId === "all" || noteLibraryId(item) === String(libraryFilterId)));
  $("#count").textContent = `${filtered.length} 条记录`;
  $("#history").innerHTML = filtered.length ? filtered.map(item => { const state = item.status === "feishu_archiving" ? "飞书归档中 · " : item.status === "pending" ? "待实践 · " : item.status === "draft" ? (item.transcriptionStatus === "completed" ? "待补充感想 · " : "转写中 · ") : ""; const itemLibraryId = noteLibraryId(item); return `<article class="mini" data-open-note="${item.id}" tabindex="0" role="button" aria-label="打开笔记：${escapeHtml(item.title)}" style="${item.thumbnail ? `background-image:linear-gradient(180deg,#ffffffdd,#ffffffee),url(${escapeHtml(item.thumbnail)});background-size:cover;background-position:center` : ""}"><button class="delete" data-delete="${item.id}" title="删除">×</button><small class="mini-meta"><span>${state}${new Date(item.createdAt).toLocaleString("zh-CN")}</span>${feishuSyncChip(item)}</small><div class="mini-library-mark"><span>灵感库</span><b>${escapeHtml(libraryName(itemLibraryId))}</b></div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.note || "转写完成后可继续补充感想")}</p><div class="mini-tags">${(item.tags || []).map(tag => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join("")}</div><label class="mini-library-move" aria-label="移动灵感库"><span>移动到</span><select data-move-note-library="${escapeHtml(String(item.id))}">${libraryOptions(itemLibraryId)}</select></label></article>`; }).join("") : `<div class="empty">${libraryFilterId !== "all" ? `“${escapeHtml(libraryName(libraryFilterId))}”中还没有${noteView === "pending" ? "待实践的" : ""}灵感。` : noteView === "pending" ? "还没有标记为待实践的灵感。" : "还没有记录，粘贴一个视频链接开始吧。"}</div>`;
}

function openNote(id) {
  const item = loadedNotes.find(note => note.id === id);
  if (!item) return;
  openedNote = item;
  $("#noteTitle").textContent = item.title;
  $("#noteCover").style.backgroundImage = item.thumbnail ? `url(${JSON.stringify(item.thumbnail).slice(1, -1)})` : "linear-gradient(135deg,#332f2a,#655d52)";
  $("#noteMeta").textContent = `${item.status === "pending" ? "待实践 · " : ""}${libraryName(noteLibraryId(item))} · ${new Date(item.createdAt).toLocaleString("zh-CN")}`;
  renderNoteLibrary(item);
  renderNoteFeishu(item);
  $("#noteTags").innerHTML = (item.tags || []).map(tag => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join("");
  $("#noteBody").textContent = item.note || "暂无感想";
  const related = sortAnalyses(item.analyses || loadedAnalyses.filter(analysis => analysis.inspirationId === item.id || (!analysis.inspirationId && analysis.sourceUrl && item.url && analysis.sourceUrl === item.url)));
  $("#noteAnalyses").innerHTML = related.length ? related.map(analysis => `<article class="note-analysis"><div class="note-analysis-meta">${analysis.type === "cases" ? "类似案例研究" : "视频内容拆解"} · ${escapeHtml(analysis.provider)} / ${escapeHtml(analysis.model)}</div><div class="markdown">${markdown(analysis.markdown)}</div></article>`).join("") : '<div class="note-empty-related">还没有保存的视频拆解或类似案例研究。</div>';
  $("#noteTranscript").hidden = !(item.formattedTranscript || item.transcript || item.activeTranscriptId || item.active_transcript_id);
  noteWorkspace.load({ noteId: item.id, legacy: { transcript: item.transcript, formattedTranscript: item.formattedTranscript, title: item.title, note: item.note } });
  $("#noteSource").href = item.url || "#";
  $("#noteSource").hidden = !item.url;
  $("#noteModal").hidden = false;
}

async function loadTagCatalog() { const result = await api("api/tags"); tagCatalog = { groups: result.groups || [] }; existingTags = tagCatalog.groups.flatMap(group => (group.tags || []).map(tag => ({ ...(typeof tag === "string" ? { name: tag } : tag), group: group.name, groupId: group.id }))); renderSuggestions(existingTags); renderTagManager(); }
function renderTags() { $("#selectedTags").innerHTML = selectedTags.map(tag => { const name = tagName(tag); return `<span class="tag-chip">#${escapeHtml(name)}<button type="button" data-remove-tag="${escapeHtml(name)}">×</button></span>`; }).join(""); }
function renderSuggestions(tags = existingTags) { const query = $("#tagSearch")?.value.trim().toLowerCase() || ""; $("#tagSuggestions").innerHTML = tags.filter(tag => { const name = tagName(tag); return !selectedTags.some(item => tagName(item) === name) && (!query || `${name} ${tag.group || ""}`.toLowerCase().includes(query)); }).map(tag => `<button type="button" data-add-suggested="${escapeHtml(tagName(tag))}" title="${escapeHtml(`${tag.group || "未分组"} · ${tag.reason || "已有标签"}`)}">+ #${escapeHtml(tagName(tag))}<small>${escapeHtml(tag.group || "未分组")}</small></button>`).join(""); }
function addTag(tag) { const clean = String(tag || "").replace(/^#/, "").trim(); if (clean && !selectedTags.some(item => tagName(item) === clean)) selectedTags.push(clean); renderTags(); renderSuggestions(); }

function renderTagManager() { const query = $("#tagManagerSearch")?.value.trim().toLowerCase() || ""; const groupOptions = tagCatalog.groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join(""); if ($("#tagGroups")) $("#tagGroups").innerHTML = tagCatalog.groups.map(group => { const tags = (group.tags || []).filter(tag => !query || `${tagName(tag)} ${group.name}`.toLowerCase().includes(query)); return `<details class="tag-group-details"><summary><span>${escapeHtml(group.name)}</span><small>${tags.length} 个标签</small></summary><div class="tag-manager-chips">${tags.map(tag => `<span class="tag-manager-chip">#${escapeHtml(tagName(tag))}<select class="tag-move-select" data-move-tag="${escapeHtml(tag.id || "")}" aria-label="移动标签"><option value="">移动到…</option>${tagCatalog.groups.filter(target => target.id !== group.id).map(target => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}</option>`).join("")}</select><button data-delete-tag="${escapeHtml(tag.id || "")}" title="删除">×</button></span>`).join("") || `<span class="hint">暂无匹配标签</span>`}</div></details>`; }).join(""); [$("#newTagGroup"), $("#tagGroupSelect")].filter(Boolean).forEach(select => select.innerHTML = groupOptions); }

async function loadJobs() {
  const { jobs } = await api("api/jobs");
  resetQuickCaptureEntry();
  const restorableDrafts = loadedNotes.filter(item => item.status === "draft" && isRestorableTranscription(item));
  const draft = restorableDrafts[0];
  const active = jobs.find(job => ["preparing", "downloading", "queued", "transcribing", "running"].includes(job.status));
  const completed = jobs.find(job => job.status === "completed" && job.transcript);
  if (draft) {
    const relatedJob = jobs.find(job => job.inspirationId === draft.id);
    restoreDraftContext({ ...draft, inspirationId: draft.id });
    showTranscript(draft.transcript || relatedJob?.transcript || "", draft.formattedTranscript || "");
    $("#recoveryBox").hidden = false;
    if (relatedJob && ["preparing", "downloading", "queued", "transcribing", "running"].includes(relatedJob.status)) { updateProgress(relatedJob); $("#recoveryBox").innerHTML = `<span>已恢复正在转写的灵感：${escapeHtml(draft.title)} · ${relatedJob.progress || 0}%</span>`; pollJob(relatedJob.id); }
    else $("#recoveryBox").innerHTML = `<span>已恢复上次转写完成但未处理的灵感：${escapeHtml(draft.title)}</span>`;
  }
  else if (active) { restoreDraftContext(active); updateProgress(active); $("#recoveryBox").hidden = false; $("#recoveryBox").innerHTML = `<span>上次转写仍在处理中：${escapeHtml(active.stage || "处理中")} · ${active.progress || 0}%</span>`; pollJob(active.id); }
  else if (completed) {
    const note = loadedNotes.find(item => item.id === completed.inspirationId);
    const isDraft = note && ["draft", "processing", "transcribing"].includes(note.status) && isRestorableTranscription(note);
    if (isDraft) { restoreDraftContext({ ...completed, ...note, inspirationId: note.id }); showTranscript(note.transcript || completed.transcript, note.formattedTranscript || completed.formattedTranscript || ""); }
    $("#recoveryBox").hidden = false;
    $("#recoveryBox").innerHTML = `<span>${isDraft ? "已恢复上次转写完成但未处理的灵感" : "发现一条已完成的转写"}：${new Date(completed.completedAt).toLocaleString("zh-CN")}：</span><button class="secondary" data-recover="${completed.id}">恢复到当前页面</button>`;
  }
}

function restoreDraftContext(source = {}) {
  const note = loadedNotes.find(item => item.id === (source.inspirationId || source.id));
  const value = note || source;
  currentNoteId = source.inspirationId || note?.id || currentNoteId;
  const url = value.url || value.sourceUrl;
  if (url) $("#url").value = url;
  if (url && /mp\.weixin\.qq\.com|article|document/i.test(`${value.platform || ""} ${url}`)) $("#articleUrl").value = url;
  video = { ...(video || {}), title: value.title || value.videoTitle || video?.title, thumbnail: value.thumbnail || video?.thumbnail, platform: value.platform || video?.platform || "视频" };
  if (video.title) $("#videoTitle").textContent = video.title;
  if (video.thumbnail) $("#preview").style.backgroundImage = `linear-gradient(180deg,transparent,#15102baa),url(${JSON.stringify(video.thumbnail).slice(1, -1)})`;
  if (video.platform) $("#source").textContent = video.platform;
  if (value.note) $("#note").value = value.note;
  if (Array.isArray(value.tags)) { selectedTags = value.tags; renderTags(); }
  if (value.libraryId || value.library_id || value.library?.id) { selectedLibraryId = noteLibraryId(value); renderLibraries(); }
}

function inlineMarkdown(value) {
  return escapeHtml(value).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>').replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

function formatTranscriptHtml(value = "") {
  const clean = String(value).replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  if (!clean) return "";
  const chunks = clean.split(/(?<=[。！？；])\s*/).reduce((list, sentence) => { if (!sentence) return list; const current = list[list.length - 1] || ""; if ((current + sentence).length > 115) list.push(sentence); else list[list.length - 1] = current + sentence; return list; }, []);
  return chunks.map((chunk, index) => { const highlighted = escapeHtml(chunk).replace(/(关键|核心|首先|其次|最后|因此|但是|不要|建议|方法|问题|本质)/g, "<mark>$1</mark>"); return `<p><span class="transcript-index">${String(index + 1).padStart(2, "0")}</span>${highlighted}</p>`; }).join("");
}
function showTranscript(value = "", formatted = "") { transcript = value; formattedTranscript = formatted; quickWorkspace?.setLegacy({ noteId: currentNoteId, transcript: value, formattedTranscript: formatted, title: video?.title, note: $("#note")?.value || "" }); $("#transcriptState").textContent = formatted ? "AI 排版完成" : value ? "原始转写 · 正在排版" : "等待转写"; $("#retryFormat").hidden = !value; }
async function formatTranscriptWithAi(force = false) { if (!transcript || (formattedTranscript && !force)) return; const requestSeq = ++formatRequestSeq; $("#retryFormat").hidden = true; $("#transcriptState").textContent = `正在用 ${provider} 排版…`; try { const result = await api("api/transcripts/format", { method: "POST", body: JSON.stringify({ provider, transcript, inspirationId: currentNoteId }) }); if (requestSeq !== formatRequestSeq) return; formattedTranscript = result.markdown; await quickWorkspace?.load({ noteId: currentNoteId, legacy: { transcript, formattedTranscript, title: video?.title, note: $("#note")?.value || "" } }); $("#transcriptState").textContent = `AI 排版完成 · ${result.model}`; } catch (error) { if (requestSeq !== formatRequestSeq) return; if (formattedTranscript && !force) return; $("#transcriptState").textContent = `排版失败 · HTTP ${error.status || "未知"} · ${error.code || "HTTP_ERROR"} · 已保留上一阅读版本`; message(`${error.message}${error.details ? ` · ${error.details}` : ""}`, true); quickWorkspace?.setLegacy({ noteId: currentNoteId, transcript, formattedTranscript, title: video?.title, note: $("#note")?.value || "" }); $("#retryFormat").hidden = false; } }

function markdown(value = "") {
  const lines = value.replace(/\r/g, "").split("\n");
  let html = "", list = "";
  const close = () => { if (list) { html += `</${list}>`; list = ""; } };
  for (const line of lines) {
    if (/^###\s+/.test(line)) { close(); html += `<h3>${inlineMarkdown(line.replace(/^###\s+/, ""))}</h3>`; }
    else if (/^##\s+/.test(line)) { close(); html += `<h2>${inlineMarkdown(line.replace(/^##\s+/, ""))}</h2>`; }
    else if (/^#\s+/.test(line)) { close(); html += `<h1>${inlineMarkdown(line.replace(/^#\s+/, ""))}</h1>`; }
    else if (/^[-*]\s+/.test(line)) { if (list !== "ul") { close(); list = "ul"; html += "<ul>"; } html += `<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`; }
    else if (/^\d+\.\s+/.test(line)) { if (list !== "ol") { close(); list = "ol"; html += "<ol>"; } html += `<li>${inlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`; }
    else if (line.trim()) { close(); html += `<p>${inlineMarkdown(line)}</p>`; }
    else close();
  }
  close(); return html;
}

async function loadAnalyses() {
  if (!currentNoteId) { loadedAnalyses = []; renderCurrentAnalyses(); return; }
  const { items } = await api(`api/analyses?inspirationId=${encodeURIComponent(currentNoteId)}`);
  loadedAnalyses = items;
  renderCurrentAnalyses();
}

function renderCurrentAnalyses() {
  const sourceUrl = currentSourceUrl();
  const items = sortAnalyses(loadedAnalyses.filter(item => currentNoteId ? item.inspirationId === currentNoteId || (!item.inspirationId && sourceUrl && item.sourceUrl === sourceUrl) : sourceUrl && item.sourceUrl === sourceUrl));
  const renderColumn = (type, title, description) => {
    const matching = items.filter(item => item.type === type);
    const cards = matching.map(item => `<article class="card reading"><div class="reading-head"><div><div class="section-title">${escapeHtml(item.title)}</div><div class="reading-meta">${escapeHtml(item.provider)} / ${escapeHtml(item.model)} · ${new Date(item.createdAt).toLocaleString("zh-CN")}</div></div><button class="delete" data-delete-analysis="${item.id}">删除</button></div><div class="markdown">${markdown(item.markdown)}</div></article>`).join("");
    return `<section class="analysis-column" aria-label="${escapeHtml(title)}"><header class="analysis-column-head"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></header>${cards || '<div class="empty">还没有生成内容</div>'}</section>`;
  };
  $("#analysisHistory").innerHTML = `${renderColumn("video", "视频内容拆解", "核心机制、方法与可执行步骤")}<div class="analysis-divider" aria-hidden="true"></div>${renderColumn("cases", "类似案例研究", "可迁移的案例、做法与参照")}`;
}

function escapeHtml(value = "") { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function currentSourceUrl() {
  const articleUrl = $("#articleUrl")?.value.trim() || "";
  const videoUrl = $("#url")?.value.trim() || "";
  const platform = String(video?.platform || "").toLowerCase();
  if (articleUrl && (!videoUrl || /article|document|pdf|word/.test(platform))) return articleUrl;
  return videoUrl || articleUrl;
}

function setFeishuMessage(text = "", error = false) {
  const root = $("#feishuMessage");
  if (!root) return;
  root.textContent = text;
  root.classList.toggle("error", error);
}

function feishuCallbackMarkup() {
  const callbackUrl = feishuStatus.callbackUrl || feishuCallbackFallback();
  return `<div class="feishu-band"><div class="feishu-band-title">授权回调地址</div><div class="feishu-callback"><code title="${escapeHtml(callbackUrl)}">${escapeHtml(callbackUrl)}</code><button class="secondary" data-feishu-action="copy-callback" type="button">复制</button><a class="secondary" href="/feishu-setup.html" target="_blank" rel="noreferrer">接入教程</a></div></div>`;
}

function feishuStateBadge(state) {
  const labels = { unconfigured: "服务器未配置", app_missing: "待填写应用", disconnected: "未连接", connected: "已连接", paused: "已暂停", reauthorize: "需重新授权" };
  return `<span class="feishu-state-badge" data-state="${state}">${labels[state] || "未连接"}</span>`;
}

function feishuHeadTools(state) {
  return `<div class="feishu-head-tools">${feishuStateBadge(state)}<a class="secondary feishu-tutorial-button" href="/feishu-setup.html" target="_blank" rel="noreferrer">\u914d\u7f6e\u6559\u7a0b</a></div>`;
}

function feishuRemoteUrl() {
  const connection = feishuStatus.connection || {};
  const binding = (feishuStatus.bindings || []).find(item => item.documentUrl || item.document_url);
  return connection.spaceUrl || connection.wikiUrl || connection.documentUrl || binding?.documentUrl || binding?.document_url || "https://www.feishu.cn/drive/home/";
}

function renderFeishuPanel() {
  const root = $("#feishuContent");
  if (!root) return;
  captureFeishuFormDraft();
  const state = feishuConnectionState();
  const connection = feishuStatus.connection || {};
  const sync = feishuStatus.sync || {};

  if (state === "unconfigured") {
    const required = feishuStatus.requiredEnv?.length ? feishuStatus.requiredEnv : FEISHU_REQUIRED_ENV;
    root.innerHTML = `<div class="feishu-state-head"><div><h3>${feishuStatus.unavailable ? "当前服务器尚未启用同步模块" : "服务器还差一步配置"}</h3><p>${feishuStatus.unavailable ? "现有记录和转写不受影响，部署同步模块后即可连接。" : "管理员需要先配置加密密钥，之后用户才能填写自己的飞书应用 ID/Key。"}</p></div>${feishuHeadTools("unconfigured")}</div>${feishuCallbackMarkup()}<div class="feishu-band"><div class="feishu-band-title">服务器配置项</div><div class="hint">这里只需要管理员配置加密密钥；每个用户的 App ID / App Secret 在网页里单独填写。</div><div class="feishu-env-list">${required.map(name => `<code>${escapeHtml(name)}</code>`).join("")}</div></div>`;
    return;
  }

  if (state === "app_missing") {
    root.innerHTML = `<div class="feishu-state-head"><div><h3>填写你的飞书应用 ID / Key</h3><p>每个用户使用自己的飞书自建应用。先在飞书开放平台开通权限并发布，再把 App ID 和 App Secret 填到这里。</p></div>${feishuHeadTools("app_missing")}</div>${feishuCallbackMarkup()}<div class="feishu-band"><div class="feishu-band-title">你的飞书应用</div><div class="feishu-field-grid"><div class="feishu-field"><label for="feishuAppId">App ID</label><input id="feishuAppId" autocomplete="off" placeholder="例如 cli_xxxxxxxxxxxxxxxx"><small>飞书开放平台 → 应用详情 → 凭证与基础信息</small></div><div class="feishu-field"><label for="feishuAppSecret">App Secret / Key</label><input id="feishuAppSecret" type="password" autocomplete="off" placeholder="粘贴你的 App Secret"><small>只会加密保存在本站，用于你自己的飞书授权</small></div></div><div class="feishu-actions"><button class="primary" data-feishu-action="save-app-connect" type="button">保存并连接飞书</button><a class="secondary" href="/feishu-setup.html" target="_blank" rel="noreferrer">查看配置教程</a></div></div>`;
    return;
  }

  if (state === "disconnected") {
    root.innerHTML = `<div class="feishu-state-head"><div><h3>连接你的飞书</h3><p>当前应用：${escapeHtml(feishuStatus.appId || "已保存")}。授权完成后选择知识空间，后续保存会由服务器自动归档。</p></div>${feishuHeadTools("disconnected")}</div>${feishuCallbackMarkup()}<div class="feishu-actions"><button class="primary" data-feishu-action="connect" type="button">连接飞书</button><button class="secondary" data-feishu-action="edit-app" type="button">更换 App ID / Key</button></div>`;
    return;
  }

  if (state === "reauthorize") {
    const details = connection.lastError?.message || connection.error?.message || connection.lastError || "飞书授权或目标空间权限已失效。";
    root.innerHTML = `<div class="feishu-state-head"><div><h3>需要重新连接飞书</h3><p>${escapeHtml(connection.userName || "当前飞书账号")}</p></div>${feishuHeadTools("reauthorize")}</div><div class="feishu-error">${escapeHtml(String(details))}</div>${feishuCallbackMarkup()}<div class="feishu-actions"><button class="primary" data-feishu-action="connect" type="button">重新连接</button><button class="secondary" data-feishu-action="open" type="button">打开飞书</button><button class="danger" data-feishu-action="unlink" type="button">解除绑定</button></div>`;
    return;
  }

  const currentSpaceId = feishuFormDraft?.spaceId ?? connection.spaceId ?? "";
  const currentInList = feishuSpaces.some(item => String(item.spaceId ?? item.space_id ?? item.id) === String(currentSpaceId));
  const spaceOptions = `${currentSpaceId && !currentInList ? `<option value="${escapeHtml(currentSpaceId)}">${escapeHtml(connection.spaceName || "当前知识空间")}</option>` : ""}${feishuSpaces.map(item => { const id = item.spaceId ?? item.space_id ?? item.id ?? item.token; return `<option value="${escapeHtml(String(id))}" ${String(id) === String(currentSpaceId) ? "selected" : ""}>${escapeHtml(item.name || item.title || "未命名空间")}</option>`; }).join("")}`;
  const spacePlaceholder = feishuSpacesLoading ? "正在读取知识空间…" : feishuSpacesLoaded && !spaceOptions ? "没有可编辑的知识空间" : "选择知识空间";
  const policy = feishuFormDraft?.syncPolicy ?? connection.syncPolicy ?? connection.sync_policy ?? "new_only";
  const parentNodeValue = feishuFormDraft?.parentNode ?? connection.parentNodeToken ?? connection.parent_node_token ?? "";
  const failedCount = Number(sync.failed) || 0;
  const failedBinding = (feishuStatus.bindings || []).find(item => normalizedFeishuSyncState(item) === "failed");
  const lastError = sync.lastError || connection.lastError || (connection.lastErrorCode || connection.lastErrorMessage ? { code: connection.lastErrorCode, message: connection.lastErrorMessage } : null) || (failedBinding ? { code: failedBinding.lastErrorCode || failedBinding.last_error_code, message: failedBinding.lastErrorMessage || failedBinding.last_error_message } : null);
  const lastSynced = sync.lastSyncedAt ? new Date(sync.lastSyncedAt) : null;
  root.innerHTML = `
    <div class="feishu-state-head"><div><h3>${escapeHtml(connection.userName || "飞书已连接")}</h3><p>${lastSynced && !Number.isNaN(lastSynced.getTime()) ? `最近同步 ${lastSynced.toLocaleString("zh-CN")}` : "等待第一条灵感进入飞书"}</p></div>${feishuHeadTools(state)}</div>
    <div class="feishu-metrics"><div class="feishu-metric"><b>${Number(sync.pending) || 0}</b><span>待同步</span></div><div class="feishu-metric"><b>${Number(sync.processing) || 0}</b><span>同步中</span></div><div class="feishu-metric"><b>${failedCount}</b><span>失败</span></div></div>
    ${lastError ? `<div class="feishu-error">${escapeHtml(String(lastError.code || "SYNC_ERROR"))} · ${escapeHtml(String(lastError.message || lastError))}</div>` : ""}
    <div class="feishu-band">
      <div class="feishu-band-title">归档位置</div>
      <div class="feishu-field-grid">
        <div class="feishu-field"><label for="feishuSpace">知识空间（飞书知识库）</label><select id="feishuSpace" ${feishuSpacesLoading ? "disabled" : ""}><option value="">${spacePlaceholder}</option>${spaceOptions}</select><small>它是一个独立知识库，不是普通文件夹；需要当前账号拥有编辑权限</small></div>
        <div class="feishu-field"><label for="feishuParentNode">指定知识库页面（可选）</label><input id="feishuParentNode" inputmode="url" value="${escapeHtml(parentNodeValue)}" placeholder="粘贴知识库页面链接，不用填写名称"><small>不清楚就留空，灵感会保存到所选知识空间首页</small></div>
      </div>
      ${feishuSpacesLoaded && !spaceOptions ? `<div class="feishu-empty-space"><b>还没有可用的知识库</b><span>请在飞书「文档 → 知识库」中新建一个，例如“我的灵感库”，然后回来刷新空间。</span><a href="https://www.feishu.cn/drive/home/" target="_blank" rel="noreferrer">打开飞书文档</a></div>` : ""}
    </div>
    <div class="feishu-band feishu-archive-plan"><div class="feishu-band-title">系统会这样整理</div><div><b>灵感索引</b><span>一张多维表格，用灵感库、标签、状态和时间快速筛选</span></div><div><b>灵感库目录</b><span>本站每个灵感库对应一个飞书子目录，移动笔记时同步移动原文档</span></div><div><b>每条灵感</b><span>一篇独立文档，保存视频、感想、转写、标注、拆解与案例</span></div></div>
    <div class="feishu-band"><div class="feishu-band-title">同步范围</div><div class="feishu-policy"><label><input type="radio" name="feishuPolicy" value="new_only" ${policy !== "all" ? "checked" : ""}><b>只同步新记录</b><span>从连接完成后开始自动归档</span></label><label><input type="radio" name="feishuPolicy" value="all" ${policy === "all" ? "checked" : ""}><b>同步已有记录</b><span>保存设置后将历史灵感加入队列</span></label></div></div>
    <div class="feishu-actions"><button class="primary" data-feishu-action="save" type="button">保存设置</button><button class="secondary" data-feishu-action="refresh-spaces" type="button">刷新空间</button>${failedCount ? `<button class="secondary" data-feishu-action="retry-failed" type="button">立即重试</button>` : ""}<button class="secondary" data-feishu-action="${state === "paused" ? "resume" : "pause"}" type="button">${state === "paused" ? "恢复同步" : "暂停同步"}</button><button class="secondary" data-feishu-action="open" type="button">打开飞书</button><button class="danger" data-feishu-action="unlink" type="button">解除绑定</button></div>`;
}

async function loadFeishuSpaces({ force = false } = {}) {
  if (feishuSpacesLoading || (feishuSpacesLoaded && !force)) return;
  feishuSpacesLoading = true;
  renderFeishuPanel();
  try {
    let pageToken = "";
    let hasMore = true;
    let pages = 0;
    const items = [];
    while (hasMore && pages < 10) {
      const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
      const result = await api(`api/integrations/feishu/spaces${query}`);
      items.push(...(result.items || result.spaces || []));
      pageToken = result.pageToken || result.page_token || "";
      hasMore = Boolean(result.hasMore || result.has_more) && Boolean(pageToken);
      pages += 1;
    }
    feishuSpaces = items;
    feishuSpacesLoaded = true;
  } catch (error) {
    setFeishuMessage(`${error.code || "FEISHU_SPACES_ERROR"} · ${error.message}`, true);
  } finally {
    feishuSpacesLoading = false;
    renderFeishuPanel();
  }
}

async function openFeishuPanel() {
  feishuReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  feishuFormDraft = null;
  feishuComposing = false;
  $("#feishuModal").hidden = false;
  $("#feishuContent").innerHTML = '<div class="empty">正在读取飞书连接…</div>';
  setFeishuMessage("");
  await loadFeishuStatus({ silent: true });
  if (["connected", "paused"].includes(feishuConnectionState())) await loadFeishuSpaces();
  $("#closeFeishu")?.focus();
  clearInterval(feishuPollTimer);
  feishuPollTimer = setInterval(() => {
    if (!document.hidden && !$("#feishuModal")?.hidden) loadFeishuStatus({ silent: true });
  }, 5000);
}

function closeFeishuPanel() {
  $("#feishuModal").hidden = true;
  clearInterval(feishuPollTimer);
  feishuPollTimer = null;
  feishuReturnFocus?.focus();
  feishuReturnFocus = null;
  feishuFormDraft = null;
  feishuComposing = false;
}

function extractFeishuNodeToken(value = "") {
  const clean = String(value).trim();
  if (!clean) return "";
  try {
    const url = new URL(clean);
    const fromQuery = url.searchParams.get("node_token") || url.searchParams.get("token");
    const fromPath = url.pathname.match(/\/(?:wiki|docx|folder)\/([A-Za-z0-9_-]+)/)?.[1];
    return fromQuery || fromPath || clean;
  } catch { return clean; }
}

async function startFeishuOAuth(button) {
  busy(button, true, "正在前往飞书…");
  try {
    await Promise.all([quickWorkspace?.flushPersonal(true, "feishu-oauth"), noteWorkspace?.flushPersonal(true, "feishu-oauth")]);
    const { authorizationUrl } = await api("api/integrations/feishu/oauth/start", { method: "POST", body: JSON.stringify({ returnTo: `${location.origin}${location.pathname}` }) });
    if (!authorizationUrl) throw new Error("服务器没有返回飞书授权地址");
    location.assign(authorizationUrl);
  } catch (error) {
    setFeishuMessage(`${error.code || "FEISHU_OAUTH_ERROR"} · ${error.message}`, true);
    busy(button, false);
  }
}

async function saveFeishuAppCredentials(button, { connect = false } = {}) {
  const appId = $("#feishuAppId")?.value.trim() || "";
  const appSecret = $("#feishuAppSecret")?.value.trim() || "";
  busy(button, true, connect ? "正在保存…" : "正在保存…");
  try {
    await api("api/integrations/feishu/app-credentials", { method: "POST", body: JSON.stringify({ appId, appSecret }) });
    await loadFeishuStatus({ silent: true });
    setFeishuMessage("App ID / Key 已保存");
    if (connect) await startFeishuOAuth(button);
  } catch (error) {
    setFeishuMessage(`${error.code || "FEISHU_APP_SAVE_ERROR"} · ${error.message}`, true);
    busy(button, false);
  }
}

async function saveFeishuConfiguration(button) {
  const spaceId = $("#feishuSpace")?.value || "";
  const syncPolicy = document.querySelector('input[name="feishuPolicy"]:checked')?.value || "new_only";
  if (!spaceId) return setFeishuMessage("请选择一个可编辑的知识空间", true);
  busy(button, true, syncPolicy === "all" ? "正在加入同步队列…" : "正在保存…");
  try {
    await api("api/integrations/feishu/configure", { method: "POST", body: JSON.stringify({ spaceId, parentNodeToken: extractFeishuNodeToken($("#feishuParentNode")?.value), syncPolicy }) });
    feishuFormDraft = null;
    let queued = 0;
    if (syncPolicy === "all") {
      const result = await api("api/integrations/feishu/sync-existing", { method: "POST", body: "{}" });
      queued = Number(result.queued) || 0;
    }
    await loadFeishuStatus({ silent: true });
    setFeishuMessage(syncPolicy === "all" ? `设置已保存，${queued} 条已有记录已加入同步队列` : "设置已保存，新记录会自动同步");
  } catch (error) { setFeishuMessage(`${error.code || "FEISHU_CONFIG_ERROR"} · ${error.message}`, true); }
  finally { busy(button, false); }
}

async function setFeishuPaused(button, paused) {
  busy(button, true, paused ? "正在暂停…" : "正在恢复…");
  try {
    await api("api/integrations/feishu/pause", { method: "POST", body: JSON.stringify({ paused }) });
    await loadFeishuStatus({ silent: true });
    setFeishuMessage(paused ? "同步已暂停，本站保存不受影响" : "同步已恢复");
  } catch (error) { setFeishuMessage(`${error.code || "FEISHU_PAUSE_ERROR"} · ${error.message}`, true); }
  finally { busy(button, false); }
}

async function retryFailedFeishu(button) {
  busy(button, true, "正在重试…");
  try {
    let failed = (feishuStatus.bindings || []).filter(item => normalizedFeishuSyncState(item) === "failed");
    if (!failed.length) { await loadFeishuStatus({ silent: true }); failed = (feishuStatus.bindings || []).filter(item => normalizedFeishuSyncState(item) === "failed"); }
    if (!failed.length) throw Object.assign(new Error("暂未取得失败记录详情，后台仍会按计划自动重试"), { code: "SYNC_DETAILS_PENDING" });
    const results = await Promise.allSettled(failed.map(item => api(`api/integrations/feishu/retry/${encodeURIComponent(item.inspirationId ?? item.inspiration_id)}`, { method: "POST", body: "{}" })));
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
    await loadFeishuStatus({ silent: true });
    setFeishuMessage(`${failed.length} 条失败记录已重新加入队列`);
  } catch (error) { setFeishuMessage(`${error.code || "FEISHU_RETRY_ERROR"} · ${error.message}`, true); }
  finally { busy(button, false); }
}

async function unlinkFeishu(button) {
  if (!confirm("解除绑定后，飞书中的文档会保留，本站将删除授权并停止同步。确定继续吗？")) return;
  busy(button, true, "正在解除…");
  try {
    await api("api/integrations/feishu/connection", { method: "DELETE" });
    feishuSpaces = []; feishuSpacesLoaded = false;
    await loadFeishuStatus({ silent: true });
    setFeishuMessage("已解除绑定，飞书中的文档仍然保留");
  } catch (error) { setFeishuMessage(`${error.code || "FEISHU_UNLINK_ERROR"} · ${error.message}`, true); }
  finally { busy(button, false); }
}

function setLocalFeishuBinding(inspirationId, values) {
  const bindings = feishuStatus.bindings || (feishuStatus.bindings = []);
  const index = bindings.findIndex(item => String(item.inspirationId ?? item.inspiration_id) === String(inspirationId));
  if (index >= 0) bindings[index] = { ...bindings[index], ...values };
  else bindings.push({ inspirationId, ...values });
  renderNotes();
  if (openedNote && String(openedNote.id) === String(inspirationId)) renderNoteFeishu(openedNote);
}

async function queueFeishuNote(inspirationId, retry = false) {
  const note = loadedNotes.find(item => String(item.id) === String(inspirationId));
  const previousStatus = note?.status;
  if (note) note.status = "feishu_archiving";
  setLocalFeishuBinding(inspirationId, { syncStatus: "pending" });
  renderNotes();
  if (openedNote && String(openedNote.id) === String(inspirationId)) renderNoteFeishu(openedNote);
  try {
    await api(`api/integrations/feishu/archive/${encodeURIComponent(inspirationId)}`, { method: "POST", body: "{}" });
    setFeishuMessage(retry ? "已重新加入飞书保存队列，成功后会从我的灵感中移除" : "已加入飞书保存队列，成功后会从我的灵感中移除");
    for (const delay of [700, 2500, 6500]) setTimeout(() => Promise.all([loadFeishuStatus({ silent: true }), loadLibraries(), loadNotes()]), delay);
  } catch (error) {
    if (note && note.status === "feishu_archiving") note.status = previousStatus || "captured";
    setLocalFeishuBinding(inspirationId, { syncStatus: "failed", error: { code: error.code, message: error.message } });
    renderNotes();
    await openFeishuPanel();
    setFeishuMessage(`${error.code || "FEISHU_SYNC_ERROR"} · ${error.message}`, true);
  }
}
async function archiveFeishuNote(inspirationId) {
  const note = loadedNotes.find(item => String(item.id) === String(inspirationId));
  const previousStatus = note?.status;
  if (note) note.status = "feishu_archiving";
  setLocalFeishuBinding(inspirationId, { syncStatus: "pending" });
  renderNotes();
  if (openedNote && String(openedNote.id) === String(inspirationId)) renderNoteFeishu(openedNote);
  try {
    await api(`api/integrations/feishu/archive/${encodeURIComponent(inspirationId)}`, { method: "POST", body: "{}" });
    setFeishuMessage("已加入飞书保存队列，成功后会清理网站本地正文和图片");
    for (const delay of [700, 2500, 6500]) setTimeout(() => Promise.all([loadFeishuStatus({ silent: true }), loadLibraries(), loadNotes()]), delay);
  } catch (error) {
    if (note && note.status === "feishu_archiving") note.status = previousStatus || "captured";
    setLocalFeishuBinding(inspirationId, { syncStatus: "failed", error: { code: error.code, message: error.message } });
    await openFeishuPanel();
    setFeishuMessage(`${error.code || "FEISHU_ARCHIVE_ERROR"} · ${error.message}`, true);
  }
}
async function archiveFeishuLibrary(libraryId) {
  const current = libraries.find(item => String(item.id) === String(libraryId));
  if (!current) return;
  const button = $("#archiveLibrary");
  const previousStatuses = new Map(loadedNotes
    .filter(item => noteLibraryId(item) === String(libraryId))
    .map(item => [String(item.id), item.status]));
  busy(button, true, "归档中…");
  try {
    const result = await api(`api/integrations/feishu/archive-library/${encodeURIComponent(libraryId)}`, { method: "POST", body: "{}" });
    loadedNotes.filter(item => noteLibraryId(item) === String(libraryId)).forEach(item => { item.status = "feishu_archiving"; });
    renderNotes();
    setFeishuMessage(`“${current.name}”已加入飞书归档队列：${Number(result.queued) || 0}/${Number(result.total) || 0}`);
    message(`已开始保存“${current.name}”到飞书，成功后会清理本地正文和图片`);
    for (const delay of [700, 2500, 6500]) setTimeout(() => Promise.all([loadFeishuStatus({ silent: true }), loadLibraries(), loadNotes()]), delay);
  } catch (error) {
    loadedNotes.forEach(item => {
      const previous = previousStatuses.get(String(item.id));
      if (previous && item.status === "feishu_archiving") item.status = previous;
    });
    renderNotes();
    await openFeishuPanel();
    setFeishuMessage(`${error.code || "FEISHU_LIBRARY_ARCHIVE_ERROR"} · ${error.message}`, true);
    message(error.message, true);
  } finally {
    busy(button, false);
  }
}

async function handleFeishuOAuthReturn() {
  const url = new URL(location.href);
  const outcome = url.searchParams.get("feishu");
  if (!outcome) return;
  const code = url.searchParams.get("code") || url.searchParams.get("error_code") || "";
  const details = url.searchParams.get("message") || url.searchParams.get("error") || "";
  url.searchParams.delete("feishu");
  url.searchParams.delete("code");
  url.searchParams.delete("error_code");
  url.searchParams.delete("message");
  url.searchParams.delete("error");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  await openFeishuPanel();
  if (["connected", "success"].includes(outcome)) setFeishuMessage("飞书已连接，请选择灵感的归档位置");
  else setFeishuMessage(`${code || "FEISHU_OAUTH_ERROR"}${details ? ` · ${details}` : " · 飞书授权没有完成"}`, true);
}

async function handleFeishuSetupShortcut() {
  const url = new URL(location.href);
  const shortcut = url.searchParams.get("connectFeishu") || url.searchParams.get("feishuSetup");
  if (!shortcut) return;
  url.searchParams.delete("connectFeishu");
  url.searchParams.delete("feishuSetup");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  await openFeishuPanel();
  const state = feishuConnectionState();
  if (state === "disconnected") setFeishuMessage("点击“连接飞书”即可一键授权，后面只需要选择知识空间");
  else if (state === "connected") setFeishuMessage("飞书已连接，只需要确认知识空间后保存设置");
}

$("#inspect").onclick = async () => {
  const button = $("#inspect"); busy(button, true, "解析中…"); message("");
  try {
    const result = await api("api/video/inspect", { method: "POST", body: JSON.stringify({ url: $("#url").value.trim() }) });
    video = result.video;
    currentNoteId = result.inspirationId || result.inspiration?.id || null;
    $("#videoTitle").textContent = video.title;
    $("#source").textContent = `${video.platform}${video.author ? ` · ${video.author}` : ""}${video.message ? ` · ${video.message}` : ""}`;
    $("#duration").textContent = video.duration ? `时长 ${Math.floor(video.duration / 60)}:${String(video.duration % 60).padStart(2, "0")}` : "";
    if (video.thumbnail) $("#preview").style.backgroundImage = `linear-gradient(180deg,transparent,#15102baa),url(${JSON.stringify(video.thumbnail).slice(1,-1)})`;
    message(video.status === "ready" ? "✓ 视频信息与封面已读取" : video.message, video.status !== "ready");
    renderCurrentAnalyses();
    if (video.status === "ready") await startTranscription();
  } catch (error) { message(error.message, true); }
  finally { busy(button, false); }
};

$("#inspectArticle").onclick = async () => {
  const button = $("#inspectArticle"); busy(button, true, "提取中…"); message("");
  try {
    $("#transcribeProgress").hidden = true;
    const articleInput = $("#articleUrl").value.trim() || $("#url").value.trim();
    const result = await api("api/articles/inspect", { method: "POST", body: JSON.stringify({ url: articleInput }) });
    const article = result.article;
    video = {
      title: article.title,
      thumbnail: article.cover || "",
      platform: article.platform || "article",
      author: article.author || "",
      webpageUrl: article.url,
      duration: 0,
    };
    currentNoteId = result.inspirationId || result.inspiration?.id || null;
    $("#articleUrl").value = article.url || articleInput;
    $("#url").value = article.url || articleInput;
    $("#videoTitle").textContent = article.title;
    $("#source").textContent = `${article.platform === "wechat_article" ? "微信公众号文章" : "文章"}${article.author ? ` · ${article.author}` : ""}${article.imageCount ? ` · ${article.imageCount} 张图片` : ""}`;
    $("#duration").textContent = `${article.plainText.length} 字正文`;
    if (article.cover) $("#preview").style.backgroundImage = `linear-gradient(180deg,transparent,#15102baa),url(${JSON.stringify(article.cover).slice(1,-1)})`;
    showTranscript(article.markdown || article.plainText, article.markdown);
    $("#transcriptState").textContent = "文章正文已提取";
    await quickWorkspace?.load({ noteId: currentNoteId, legacy: { transcript, formattedTranscript, title: article.title, note: $("#note")?.value || "" } });
    renderCurrentAnalyses();
    message(`✓ 文章已提取，可直接阅读标注${article.imageCount ? `，包含 ${article.imageCount} 张图片链接` : ""}`);
  } catch (error) { message(error.message, true); }
  finally { busy(button, false); }
};

$("#uploadDocument").onclick = () => $("#documentFile").click();
$("#documentFile").onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  $("#documentFileName").textContent = file.name;
  const button = $("#uploadDocument"); busy(button, true, "解析中…"); message("");
  try {
    $("#transcribeProgress").hidden = true;
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch("api/documents/inspect", { method: "POST", credentials: "same-origin", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showAuth();
      throw Object.assign(new Error(payload.error?.message || `上传解析失败 (${response.status})`), { code: payload.error?.code || "HTTP_ERROR", status: response.status });
    }
    const documentItem = payload.document;
    video = {
      title: documentItem.title,
      thumbnail: "",
      platform: documentItem.platform || documentItem.kind || "document",
      author: "",
      webpageUrl: payload.inspiration?.url || "",
      duration: 0,
    };
    currentNoteId = payload.inspirationId || payload.inspiration?.id || null;
    $("#url").value = video.webpageUrl || "";
    $("#articleUrl").value = "";
    $("#videoTitle").textContent = documentItem.title;
    $("#source").textContent = `${documentItem.kind === "pdf" ? "PDF" : "Word 文档"} · ${documentItem.filename || file.name}`;
    $("#duration").textContent = documentItem.pageCount ? `${documentItem.pageCount} 页 · ${documentItem.plainText.length} 字正文` : `${documentItem.plainText.length} 字正文`;
    $("#preview").style.backgroundImage = "";
    showTranscript(documentItem.markdown || documentItem.plainText, documentItem.markdown);
    $("#transcriptState").textContent = `${documentItem.kind === "pdf" ? "PDF" : "Word"} 正文已提取`;
    await quickWorkspace?.load({ noteId: currentNoteId, legacy: { transcript, formattedTranscript, title: documentItem.title, note: $("#note")?.value || "" } });
    renderCurrentAnalyses();
    message(`✓ ${documentItem.kind === "pdf" ? "PDF" : "Word"} 已解析，可直接阅读标注`);
  } catch (error) { message(error.message, true); }
  finally {
    busy(button, false);
    event.target.value = "";
  }
};

async function saveCurrentInspiration() {
  const buttons = [$("#save"), $("#quickSave")].filter(Boolean);
  buttons.forEach(button => busy(button, true, button === $("#quickSave") ? "…" : "保存中…"));
  try {
    const { item } = await api("api/notes", { method: "POST", body: JSON.stringify({ inspirationId: currentNoteId, url: currentSourceUrl(), title: video?.title, thumbnail: video?.thumbnail, platform: video?.platform, status: markPending ? "pending" : "captured", libraryId: selectedLibraryId || defaultLibrary()?.id || null, tags: selectedTags, transcript, formattedTranscript, note: $("#note").value }) });
    currentNoteId = item.id; markPending = item.status === "pending"; message("✓ 已保存到我的灵感，可继续生成拆解和案例"); await Promise.all([loadLibraries(), loadNotes(), loadAnalyses()]);
  } catch (error) { message(error.message, true); }
  finally { buttons.forEach(button => busy(button, false)); }
}
$("#save").onclick = () => saveCurrentInspiration($("#save"));

async function startTranscription() {
  const button = $("#inspect"); busy(button, true, "正在提交转写…");
  try { const { job } = await api("api/video/transcribe", { method: "POST", body: JSON.stringify({ url: $("#url").value.trim(), inspirationId: currentNoteId }) }); currentNoteId = job.inspirationId || currentNoteId; updateProgress(job); message("转写任务已提交，完成后会自动填入内容"); pollJob(job.id); }
  catch (error) { message(error.message, true); }
  finally { busy(button, false); }
}

function updateProgress(job) {
  const value = Math.max(0, Math.min(100, Number(job.progress) || 0));
  $("#transcribeProgress").hidden = false;
  $("#progressStage").textContent = job.stage || "正在处理";
  $("#progressPercent").textContent = `${value}%`;
  $("#progressFill").style.width = `${value}%`;
}

async function pollJob(id) {
  try {
    const { job } = await api(`api/jobs/${id}`);
    if (job.inspirationId !== currentNoteId) return;
    updateProgress(job);
    if (job.status === "completed") { showTranscript(job.transcript); await formatTranscriptWithAi(); message("✓ Whisper medium 转写完成，已自动排版"); return; }
    if (job.status === "failed") { message(`转写失败：${job.error}`, true); return; }
    message(`${job.stage || "正在转写"} · 约 ${job.progress || 0}%`);
    setTimeout(() => pollJob(id), 3000);
  } catch (error) { message(error.message, true); }
}

document.querySelectorAll("[data-provider]").forEach(button => button.onclick = () => { document.querySelectorAll("[data-provider]").forEach(item => item.classList.remove("on")); button.classList.add("on"); provider = button.dataset.provider; $("#quickProviderSelect").value = provider; });
$("#quickProviderSelect").onchange = event => { provider = event.target.value; document.querySelectorAll("[data-provider]").forEach(item => item.classList.toggle("on", item.dataset.provider === provider)); if (transcript) $("#transcriptState").textContent = `已切换到 ${provider}，点击重新排版`; $("#retryFormat").hidden = !transcript; };
function setCaptureDrawer(id, open) {
  const drawer = $(`#${id}`);
  const button = $(`[aria-controls="${id}"]`);
  drawer.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", String(open));
  if (open) setTimeout(() => drawer.querySelector("textarea,input,select")?.focus(), 180);
}
function closeCaptureDrawers() { setCaptureDrawer("noteComposer", false); setCaptureDrawer("tagComposer", false); setCaptureDrawer("libraryComposer", false); }
$("#toggleNoteComposer").onclick = () => setCaptureDrawer("noteComposer", !$("#noteComposer").classList.contains("is-open"));
$("#toggleTagComposer").onclick = () => setCaptureDrawer("tagComposer", !$("#tagComposer").classList.contains("is-open"));
$("#toggleLibraryComposer").onclick = () => setCaptureDrawer("libraryComposer", !$("#libraryComposer").classList.contains("is-open"));
$("#quickSave").onclick = () => saveCurrentInspiration($("#quickSave"));
$("#captureLibrarySelect").onchange = event => { selectedLibraryId = event.target.value; renderLibraries(); };
$("#createCaptureLibrary").onclick = async () => { const input = $("#captureLibraryName"); try { const created = await createLibrary(input.value, { select: true }); if (created) { input.value = ""; message(`已创建并选择“${created.name}”`); } } catch (error) { message(error.message, true); } };
$("#captureLibraryName").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("#createCaptureLibrary").click(); } };
$("#articleUrl").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("#inspectArticle").click(); } };
$("#pendingToggle").onclick = () => { markPending = !markPending; $("#pendingToggle").textContent = markPending ? "已标记待实践" : "标记待实践"; $("#pendingToggle").classList.toggle("on", markPending); };
$("#addTag").onclick = async () => { const name = $("#tagInput").value.trim(); if (!name) return; const known = existingTags.some(tag => tagName(tag) === name); try { if (!known && $("#tagGroupSelect")?.value) await api("api/tags", { method: "POST", body: JSON.stringify({ name, groupId: $("#tagGroupSelect").value }) }); addTag(name); $("#tagInput").value = ""; if (!known) await loadTagCatalog(); } catch (error) { message(error.message, true); } };
$("#tagInput").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("#addTag").click(); } };
$("#tagSearch").oninput = () => renderSuggestions();
$("#selectedTags").onclick = event => { const tag = event.target.dataset.removeTag; if (!tag) return; selectedTags = selectedTags.filter(item => tagName(item) !== tag); renderTags(); renderSuggestions(existingTags); };
$("#tagSuggestions").onclick = event => { const button = event.target.closest("[data-add-suggested]"); const tag = button?.dataset.addSuggested; if (tag) addTag(tag); };
$("#recommendTags").onclick = async () => { const button = $("#recommendTags"); busy(button, true, "推荐中…"); try { const result = await api("api/tags/recommend", { method: "POST", body: JSON.stringify({ provider, inspirationId: currentNoteId, title: video?.title, transcript, note: $("#note").value }) }); const candidates = [...(result.existing || []), ...(result.tags || [])].filter((tag, index, all) => all.findIndex(item => tagName(item) === tagName(tag)) === index).slice(0, 10); renderSuggestions(candidates); message("AI 已优先匹配已有标签，点击后才会加入"); } catch (error) { message(error.message, true); } finally { busy(button, false); } };

if ($("#tagManagerSearch")) $("#tagManagerSearch").oninput = renderTagManager;
if ($("#createTagGroup")) $("#createTagGroup").onclick = async () => { const input = $("#newGroupName"); const name = input.value.trim(); if (!name) return; try { await api("api/tags/groups", { method: "POST", body: JSON.stringify({ name }) }); input.value = ""; await loadTagCatalog(); message("已创建标签分组"); } catch (error) { message(error.message, true); } };
if ($("#createManagedTag")) $("#createManagedTag").onclick = async () => { const input = $("#newManagedTag"); const name = input.value.trim(); if (!name) return; try { await api("api/tags", { method: "POST", body: JSON.stringify({ name, groupId: $("#newTagGroup").value }) }); input.value = ""; await loadTagCatalog(); message("已添加标签"); } catch (error) { message(error.message, true); } };
if ($("#tagGroups")) $("#tagGroups").onclick = async event => { const id = event.target.dataset.deleteTag; if (!id) return; if (!confirm("确定删除这个标签吗？已有笔记中的文字标签会保留。")) return; await api(`api/tags/${id}`, { method: "DELETE" }); await loadTagCatalog(); };
if ($("#tagGroups")) $("#tagGroups").onchange = async event => { const select = event.target.closest("[data-move-tag]"); if (!select || !select.value) return; try { await api(`api/tags/${select.dataset.moveTag}/move`, { method: "POST", body: JSON.stringify({ groupId: select.value }) }); await loadTagCatalog(); message("标签已移动到新分组"); } catch (error) { message(error.message, true); select.value = ""; } };

$("#libraryFilter").onchange = event => { libraryFilterId = event.target.value; renderLibraries(); renderNotes(); };
$("#archiveLibrary").onclick = async () => {
  if (libraryFilterId === "all") { message("请先选择一个具体灵感库再归档", true); return; }
  await archiveFeishuLibrary(libraryFilterId);
};
$("#createLibrary").onclick = async () => { const input = $("#newLibraryName"); try { const created = await createLibrary(input.value); if (created) { input.value = ""; message(`已创建灵感库“${created.name}”`); } } catch (error) { message(error.message, true); } };
$("#newLibraryName").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("#createLibrary").click(); } };
$("#libraryList").onclick = async event => {
  const filterButton = event.target.closest("[data-library-filter]");
  if (filterButton) { libraryFilterId = filterButton.dataset.libraryFilter; renderLibraries(); renderNotes(); return; }
  const renameButton = event.target.closest("[data-library-rename]");
  if (renameButton) {
    const item = libraries.find(value => String(value.id) === String(renameButton.dataset.libraryRename));
    const name = prompt("重命名灵感库", item?.name || "");
    if (!name || name.trim() === item?.name) return;
    try { await api(`api/libraries/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }); await Promise.all([loadLibraries(), loadNotes()]); message("灵感库已重命名"); } catch (error) { message(error.message, true); }
    return;
  }
  const deleteButton = event.target.closest("[data-library-delete]");
  if (deleteButton) {
    const item = libraries.find(value => String(value.id) === String(deleteButton.dataset.libraryDelete));
    if (!item || !confirm(`删除灵感库“${item.name}”吗？\n\n库内笔记不会删除，将统一移入“待分类”。`)) return;
    try { await api(`api/libraries/${encodeURIComponent(item.id)}`, { method: "DELETE" }); if (String(libraryFilterId) === String(item.id)) libraryFilterId = "all"; if (String(selectedLibraryId) === String(item.id)) selectedLibraryId = ""; await Promise.all([loadLibraries(), loadNotes()]); message("灵感库已删除，原有笔记已移入“待分类”"); } catch (error) { message(error.message, true); }
  }
};

document.querySelectorAll("[data-nav]").forEach(button => button.onclick = () => {
  document.querySelectorAll("[data-nav]").forEach(item => item.classList.remove("active"));
  button.classList.add("active");
  const view = button.hasAttribute("data-pending") ? "pending" : button.dataset.nav === "aiWorkbench" ? "ai" : button.dataset.nav === "tagManager" ? "tags" : button.dataset.nav === "historySection" ? "inspirations" : "quick";
  document.body.dataset.view = view; noteView = view === "pending" ? "pending" : "all"; loadNotes(); window.scrollTo({ top: 0, behavior: "smooth" });
});

async function generateAnalysis(type, button) {
  busy(button, true, "生成中…");
  try {
    if (!currentNoteId) throw new Error("请先解析或打开一条灵感");
    const { analysis } = await api("api/insights/analyze", { method: "POST", body: JSON.stringify({ type, provider, inspirationId: currentNoteId, title: video?.title, url: currentSourceUrl(), transcript, note: $("#note").value, query: $("#query").value }) });
    $("#analysis").innerHTML = `<div class="message">✓ 已生成并保存正文：${escapeHtml(analysis.title)}</div>`;
    await Promise.all([loadAnalyses(), loadNotes()]); $("#analysisHistory").scrollIntoView({ behavior: "smooth" });
  } catch (error) { $("#analysis").innerHTML = `<div class="message error">${escapeHtml(error.message)}</div>`; }
  finally { busy(button, false); }
}

$("#analyze").onclick = () => generateAnalysis("video", $("#analyze"));
$("#research").onclick = () => generateAnalysis("cases", $("#research"));

$("#search").onclick = async () => {
  const button = $("#search"); busy(button, true, "搜索中…");
  try { const { items } = await api(`api/search?q=${encodeURIComponent($("#query").value.trim())}`); $("#results").innerHTML = items.map(item => `<div class="result"><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a><p>${escapeHtml(item.snippet)}</p></div>`).join("") || '<div class="empty">没有找到相关结果</div>'; }
  catch (error) { $("#results").innerHTML = `<div class="message error">${escapeHtml(error.message)}</div>`; }
  finally { busy(button, false); }
};

$("#history").onclick = async event => {
  if (event.target.closest("[data-move-note-library]")) { event.stopPropagation(); return; }
  const syncButton = event.target.closest("[data-feishu-note]");
  if (syncButton) {
    event.stopPropagation();
    const binding = feishuBindingFor(syncButton.dataset.feishuNote);
    const state = normalizedFeishuSyncState(binding);
    if (state === "synced" && binding?.documentUrl) window.open(binding.documentUrl, "_blank", "noopener");
    else if (state === "failed" && feishuConnectionState() === "connected") await queueFeishuNote(syncButton.dataset.feishuNote, true);
    else await openFeishuPanel();
    return;
  }
  const deleteId = event.target.dataset.delete;
  if (deleteId) { await api(`api/notes/${deleteId}`, { method: "DELETE" }); await loadNotes(); return; }
  const card = event.target.closest("[data-open-note]");
  if (card) openNote(card.dataset.openNote);
};
$("#history").onchange = async event => { const select = event.target.closest("[data-move-note-library]"); if (!select) return; event.stopPropagation(); select.disabled = true; try { await moveNoteToLibrary(select.dataset.moveNoteLibrary, select.value); message(`已移动到“${libraryName(select.value)}”`); } catch (error) { message(error.message, true); select.disabled = false; } };
$("#history").onkeydown = event => { if ((event.key === "Enter" || event.key === " ") && event.target.dataset.openNote) { event.preventDefault(); openNote(event.target.dataset.openNote); } };
$("#closeNote").onclick = () => $("#noteModal").hidden = true;
$("#continueInAi").onclick = async () => { if (!openedNote) return; currentNoteId = openedNote.id; restoreDraftContext({ ...openedNote, inspirationId: openedNote.id }); showTranscript(openedNote.transcript || "", openedNote.formattedTranscript || ""); $("#noteModal").hidden = true; const nav = document.querySelector('[data-nav="aiWorkbench"]'); nav?.click(); await loadAnalyses(); };
$("#copyNote").onclick = async () => { if (!openedNote) return; const related = sortAnalyses(openedNote.analyses || loadedAnalyses.filter(analysis => analysis.inspirationId === openedNote.id || (!analysis.inspirationId && analysis.sourceUrl && openedNote.url && analysis.sourceUrl === openedNote.url))); const content = [`# ${openedNote.title || "灵感笔记"}`, openedNote.note ? `\n## 我的感想\n${openedNote.note}` : "", openedNote.transcript ? `\n## 视频转写\n${openedNote.transcript}` : "", ...related.map(item => `\n## ${item.type === "cases" ? "类似案例" : "视频拆解"}\n${item.markdown || ""}`)].filter(Boolean).join("\n"); try { await navigator.clipboard.writeText(content); message("笔记内容已复制"); } catch { message("复制失败，请检查浏览器剪贴板权限", true); } };
$("#moveNoteLibrary").onclick = async () => { if (!openedNote) return; const button = $("#moveNoteLibrary"); busy(button, true, "移动中…"); try { const libraryId = $("#noteLibrarySelect").value; await moveNoteToLibrary(openedNote.id, libraryId); $("#noteMeta").textContent = `${openedNote.status === "pending" ? "待实践 · " : ""}${libraryName(libraryId)} · ${new Date(openedNote.createdAt).toLocaleString("zh-CN")}`; message(`已移动到“${libraryName(libraryId)}”`); } catch (error) { message(error.message, true); } finally { busy(button, false); } };
$("#noteModal").onclick = event => { if (event.target === $("#noteModal")) $("#noteModal").hidden = true; };
$("#noteFeishu").onclick = async event => {
  const button = event.target.closest("[data-note-feishu-action]");
  if (!button || !openedNote) return;
  const binding = feishuBindingFor(openedNote);
  if (button.dataset.noteFeishuAction === "open" && binding?.documentUrl) window.open(binding.documentUrl, "_blank", "noopener");
  else if (button.dataset.noteFeishuAction === "retry") await queueFeishuNote(openedNote.id, true);
  else if (button.dataset.noteFeishuAction === "sync") await queueFeishuNote(openedNote.id, false);
  else if (button.dataset.noteFeishuAction === "archive") await archiveFeishuNote(openedNote.id);
  else if (button.dataset.noteFeishuAction === "settings") await openFeishuPanel();
};
$("#recoveryBox").onclick = async event => { const id = event.target.dataset.recover; if (!id) return; const { job } = await api(`api/jobs/${id}`); currentNoteId = job.inspirationId || currentNoteId; restoreDraftContext(job); const note = loadedNotes.find(item => item.id === currentNoteId); showTranscript(note?.transcript || job.transcript || "", note?.formattedTranscript || ""); renderCurrentAnalyses(); await formatTranscriptWithAi(); $("#recoveryBox").hidden = true; message("✓ 已恢复上次灵感的标题、封面和转写"); };
$("#retryFormat").onclick = () => formatTranscriptWithAi(true);
$("#analysisHistory").onclick = async event => { const id = event.target.dataset.deleteAnalysis; if (!id) return; await api(`api/analyses/${id}`, { method: "DELETE" }); await Promise.all([loadAnalyses(), loadNotes()]); };

const providerLabels = { deepseek: "DeepSeek", openai: "OpenAI", claude: "Claude", grok: "Grok" };
function modelSelect(value, current) { return (value.models || []).map(model => `<option value="${escapeHtml(model.id)}" ${model.id === current ? "selected" : ""}>${escapeHtml(model.id)}</option>`).join("") + `<option value="__custom" ${value.models.some(model => model.id === current) ? "" : "selected"}>自定义模型…</option>`; }
function effortSelect(value, modelId, current) { const model = value.models.find(item => item.id === modelId); const options = model?.effort || []; return options.length ? `<select data-field="reasoningEffort">${options.map(option => `<option value="${option}" ${current === option ? "selected" : ""}>${option === "none" ? "无" : option === "minimal" ? "最低" : option === "low" ? "低" : option === "medium" ? "中等" : option === "high" ? "高" : option === "xhigh" ? "极高" : option === "max" ? "最大" : "超高"}</option>`).join("")}</select>` : `<span class="hint">无思考强度映射</span>`; }
async function openConfig() {
  const { providers } = await api("api/settings/providers");
  $("#configGrid").innerHTML = Object.entries(providers).map(([name, value]) => { const active = value.profiles.find(profile => profile.id === value.activeProfileId) || value; return `<div class="config-row" data-config="${name}"><div class="config-provider"><b>${providerLabels[name]}</b><select data-profile-select>${value.profiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === value.activeProfileId ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}</select><button class="secondary" data-new-profile type="button">新增</button><button class="secondary" data-delete-profile type="button" ${value.profiles.length <= 1 ? "disabled" : ""}>删除</button><button class="secondary" data-refresh-models type="button">刷新模型</button></div><input data-field="profileName" value="${escapeHtml(active.name)}" placeholder="配置名称"><input data-field="baseUrl" value="${escapeHtml(active.baseUrl)}" placeholder="API URL"><select data-field="model" data-model-select>${modelSelect(value, active.model)}</select><input data-field="customModel" value="${value.models.some(model => model.id === active.model) ? "" : escapeHtml(active.model)}" placeholder="自定义模型" ${value.models.some(model => model.id === active.model) ? "hidden" : ""}><span class="effort-slot">${effortSelect(value, active.model, active.reasoningEffort)}</span><select data-field="protocol"><option value="openai" ${active.protocol === "openai" ? "selected" : ""}>OpenAI compatible</option><option value="anthropic" ${active.protocol === "anthropic" ? "selected" : ""}>Anthropic</option></select><input data-field="apiKey" type="password" placeholder="${active.configured ? active.apiKeyMasked + "（留空不变）" : "API Key"}"></div>`; }).join("");
  document.querySelectorAll("[data-model-select]").forEach(select => select.onchange = () => { const row = select.closest("[data-config]"); const value = providers[row.dataset.config]; const custom = row.querySelector('[data-field="customModel"]'); custom.hidden = select.value !== "__custom"; row.querySelector(".effort-slot").innerHTML = effortSelect(value, select.value, "medium"); });
  document.querySelectorAll("[data-profile-select]").forEach(select => select.onchange = async () => { await api(`api/settings/providers/${select.closest("[data-config]").dataset.config}/active`, { method: "PUT", body: JSON.stringify({ profileId: select.value }) }); await openConfig(); });
  document.querySelectorAll("[data-new-profile]").forEach(button => button.onclick = async () => { const row = button.closest("[data-config]"); const name = prompt("新配置名称", "第三方中转"); if (!name) return; await api(`api/settings/providers/${row.dataset.config}/profiles`, { method: "POST", body: JSON.stringify({ name }) }); await openConfig(); });
  document.querySelectorAll("[data-delete-profile]").forEach(button => button.onclick = async () => { const row = button.closest("[data-config]"); const id = row.querySelector("[data-profile-select]").value; if (!confirm("删除当前配置？")) return; await api(`api/settings/providers/${row.dataset.config}/profiles/${id}`, { method: "DELETE" }); await openConfig(); });
  document.querySelectorAll("[data-refresh-models]").forEach(button => button.onclick = async () => { const row = button.closest("[data-config]"); busy(button, true, "读取中…"); try { const result = await api(`api/settings/providers/${row.dataset.config}/models`); const value = providers[row.dataset.config]; value.models = result.models; row.querySelector('[data-field="model"]').innerHTML = modelSelect(value, row.querySelector('[data-field="model"]').value); message(`已从当前服务读取 ${result.models.length} 个模型`); } catch (error) { message(error.message, true); } finally { busy(button, false); } });
  $("#configModal").hidden = false;
}
$("#openConfig").onclick = openConfig;
$("#openConfigTop").onclick = openConfig;
$("#closeConfig").onclick = $("#cancelConfig").onclick = () => $("#configModal").hidden = true;
$("#saveConfig").onclick = async () => {
  const button = $("#saveConfig"); busy(button, true, "保存中…");
  try {
    for (const row of document.querySelectorAll("[data-config]")) { const config = Object.fromEntries([...row.querySelectorAll("[data-field]")].map(field => [field.dataset.field, field.value])); if (config.model === "__custom") config.model = config.customModel; delete config.customModel; const token = $("#adminToken").value; await api(`api/settings/providers/${row.dataset.config}`, { method: "PUT", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(config) }); }
    $("#configMessage").textContent = "✓ 配置已保存"; await loadHealth(); setTimeout(() => $("#configModal").hidden = true, 700);
  } catch (error) { $("#configMessage").textContent = error.message; $("#configMessage").classList.add("error"); }
  finally { busy(button, false); }
};
$("#openFeishu").onclick = openFeishuPanel;
$("#closeFeishu").onclick = $("#finishFeishu").onclick = closeFeishuPanel;
$("#feishuModal").onclick = event => { if (event.target === $("#feishuModal")) closeFeishuPanel(); };
$("#feishuContent").onclick = async event => {
  const button = event.target.closest("[data-feishu-action]");
  if (!button) return;
  const action = button.dataset.feishuAction;
  if (action === "copy-callback") {
    try { await navigator.clipboard.writeText(feishuStatus.callbackUrl || feishuCallbackFallback()); setFeishuMessage("回调地址已复制"); }
    catch { setFeishuMessage("复制失败，请检查浏览器剪贴板权限", true); }
  }
  else if (action === "connect") await startFeishuOAuth(button);
  else if (action === "save-app-connect") await saveFeishuAppCredentials(button, { connect: true });
  else if (action === "edit-app") { feishuStatus.appConfigured = false; feishuStatus.status = "app_missing"; renderFeishuPanel(); setFeishuMessage("填写新的 App ID / Key 后，会要求重新连接飞书"); }
  else if (action === "save") await saveFeishuConfiguration(button);
  else if (action === "refresh-spaces") await loadFeishuSpaces({ force: true });
  else if (action === "retry-failed") await retryFailedFeishu(button);
  else if (action === "pause") await setFeishuPaused(button, true);
  else if (action === "resume") await setFeishuPaused(button, false);
  else if (action === "unlink") await unlinkFeishu(button);
  else if (action === "open") window.open(feishuRemoteUrl(), "_blank", "noopener");
};
$("#feishuContent").addEventListener("compositionstart", () => { feishuComposing = true; });
$("#feishuContent").addEventListener("compositionend", () => { feishuComposing = false; captureFeishuFormDraft(); });
document.addEventListener("keydown", event => { if (event.ctrlKey && event.key === "Enter") $("#save").click(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("#feishuModal")?.hidden) closeFeishuPanel(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && $("#authScreen")?.hidden) loadFeishuStatus({ silent: true });
});

quickWorkspace = new TranscriptWorkspace($("#workspaceHost"), { api, context: "quick", getProvider: () => provider });
noteWorkspace = new TranscriptWorkspace($("#noteWorkspaceHost"), { api, context: "note", getProvider: () => provider });
document.body.dataset.view = "quick";
$("#authSwitch").onclick = () => showAuth(authMode === "login" ? "register" : "login");
$("#logout").onclick = async () => {
  await Promise.all([quickWorkspace?.flushPersonal(true, "logout"), noteWorkspace?.flushPersonal(true, "logout")]);
  quickWorkspace?.destroy({ persist: false });
  noteWorkspace?.destroy({ persist: false });
  await fetch("api/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.reload();
};
$("#authForm").onsubmit = async event => { event.preventDefault(); const button = $("#authSubmit"); const error = $("#authError"); error.textContent = ""; busy(button, true, authMode === "login" ? "登录中…" : "注册中…"); try { const result = await fetch(`api/auth/${authMode}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("#authEmail").value, password: $("#authPassword").value }) }); const payload = await result.json().catch(() => ({})); if (!result.ok) throw new Error(payload.error?.message || "操作失败"); $("#authScreen").hidden = true; await loadWorkspace(); await handleFeishuSetupShortcut(); } catch (e) { error.textContent = e.message; } finally { busy(button, false); } };
initAuth();
