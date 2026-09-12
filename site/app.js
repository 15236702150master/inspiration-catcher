const DEFAULT_URL = "https://example.com/short-video/idea";
const DEFAULT_TITLE = "粘贴链接，自动读取封面和标题";
const PARSED_TITLE = "先给结论，再用一个细节证明它";

const demoUrl = document.querySelector("#demo-url");
const inspectButton = document.querySelector("#inspect-demo");
const titleCard = document.querySelector("#demo-title-card");
const sourceCard = document.querySelector("#demo-source");
const note = document.querySelector("#demo-note");
const message = document.querySelector("#demo-message");
const results = document.querySelector("#demo-results");
const labEmpty = document.querySelector("#lab-empty");
const libraryEmpty = document.querySelector("#library-empty");
const libraryCard = document.querySelector("#library-card");
const libraryCardTitle = document.querySelector("#library-card-title");
const libraryCardNote = document.querySelector("#library-card-note");
const libraryCardUrl = document.querySelector("#library-card-url");
const railItems = [...document.querySelectorAll(".rail-item")];
const viewPanels = [...document.querySelectorAll("[data-view-panel]")];
const resultTabs = [...document.querySelectorAll(".result-tab")];

let parsed = false;
let savedExample = null;

function setMessage(text, state = "success") {
  message.textContent = text;
  if (text) message.dataset.state = state;
  else delete message.dataset.state;
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function selectResult(name, shouldFocus = false) {
  resultTabs.forEach((tab) => {
    const active = tab.dataset.result === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
    if (active && shouldFocus) tab.focus();
  });
  document.querySelector("#breakdown-panel").hidden = name !== "breakdown";
  document.querySelector("#cases-panel").hidden = name !== "cases";
}

function setDemoView(view) {
  const target = viewPanels.find((panel) => panel.dataset.viewPanel === view);
  if (!target) return;
  railItems.forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  viewPanels.forEach((panel) => { panel.hidden = panel !== target; });
  if (view === "lab") {
    const hasResults = parsed || Boolean(savedExample);
    labEmpty.hidden = hasResults;
    results.hidden = !hasResults;
  }
}

function inspectExample({ focusOnError = true } = {}) {
  const url = validUrl(demoUrl.value.trim());
  if (!url) {
    parsed = false;
    results.hidden = true;
    labEmpty.hidden = false;
    demoUrl.setAttribute("aria-invalid", "true");
    setMessage("请输入有效的 http(s) 链接", "error");
    if (focusOnError) demoUrl.focus();
    return false;
  }
  parsed = true;
  demoUrl.removeAttribute("aria-invalid");
  titleCard.textContent = PARSED_TITLE;
  sourceCard.textContent = "示例解析完成 · 00:42 · 创作者方法论";
  results.hidden = false;
  labEmpty.hidden = true;
  setMessage("已生成静态示例结果");
  setDemoView("capture");
  return true;
}

function renderLibrary() {
  const hasSaved = Boolean(savedExample);
  libraryEmpty.hidden = hasSaved;
  libraryCard.hidden = !hasSaved;
  if (!hasSaved) return;
  libraryCardTitle.textContent = savedExample.title;
  libraryCardNote.textContent = savedExample.note;
  libraryCardUrl.textContent = savedExample.url;
}

function saveExample() {
  const currentUrl = validUrl(demoUrl.value.trim());
  if (!currentUrl) {
    inspectExample();
    return;
  }
  if (!parsed && !inspectExample()) return;
  const noteText = note.value.trim();
  if (!noteText) {
    setMessage("先写一句感想，再保存示例", "error");
    note.focus();
    return;
  }
  savedExample = {
    title: titleCard.textContent,
    note: noteText,
    url: currentUrl.hostname + (currentUrl.pathname === "/" ? "" : currentUrl.pathname),
  };
  renderLibrary();
  setDemoView("library");
  setMessage("已保存到示例灵感库（刷新后重置）");
}

function resetDemo() {
  parsed = false;
  savedExample = null;
  demoUrl.value = DEFAULT_URL;
  demoUrl.removeAttribute("aria-invalid");
  titleCard.textContent = DEFAULT_TITLE;
  sourceCard.textContent = "等待解析";
  note.value = "";
  results.hidden = true;
  labEmpty.hidden = false;
  renderLibrary();
  selectResult("breakdown");
  setDemoView("capture");
  setMessage("");
  demoUrl.focus();
}

inspectButton.addEventListener("click", () => inspectExample());
demoUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    inspectExample();
  }
});
demoUrl.addEventListener("input", () => {
  parsed = false;
  results.hidden = true;
  labEmpty.hidden = false;
  if (demoUrl.getAttribute("aria-invalid") === "true") {
    demoUrl.removeAttribute("aria-invalid");
    if (message.dataset.state === "error") setMessage("");
  }
});
document.querySelector("#fill-note").addEventListener("click", () => {
  note.value = "把结论提前，再用一个可验证的细节让观众留下来。";
  note.focus();
});
document.querySelector("#save-demo").addEventListener("click", saveExample);
document.querySelector("#reset-demo").addEventListener("click", resetDemo);

resultTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectResult(tab.dataset.result));
  tab.addEventListener("keydown", (event) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectResult(resultTabs[event.key === "Home" ? 0 : resultTabs.length - 1].dataset.result, true);
    } else if (direction) {
      event.preventDefault();
      const next = (index + direction + resultTabs.length) % resultTabs.length;
      selectResult(resultTabs[next].dataset.result, true);
    }
  });
});

railItems.forEach((item) => item.addEventListener("click", () => setDemoView(item.dataset.view)));
document.querySelectorAll("[data-switch-view]").forEach((item) => item.addEventListener("click", () => setDemoView(item.dataset.switchView)));

renderLibrary();
