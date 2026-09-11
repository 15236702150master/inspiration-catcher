const demoUrl = document.querySelector("#demo-url");
const inspectButton = document.querySelector("#inspect-demo");
const titleCard = document.querySelector("#demo-title-card");
const sourceCard = document.querySelector("#demo-source");
const note = document.querySelector("#demo-note");
const message = document.querySelector("#demo-message");
const results = document.querySelector("#demo-results");

function inspectExample() {
  const hasInput = demoUrl.value.trim().length > 0;
  titleCard.textContent = hasInput ? "先给结论，再用一个细节证明它" : "粘贴链接，自动读取封面和标题";
  sourceCard.textContent = hasInput ? "示例解析完成 · 00:42 · 创作者方法论" : "等待解析";
  results.hidden = !hasInput;
  message.textContent = hasInput ? "已生成静态示例结果" : "";
}

inspectButton.addEventListener("click", inspectExample);
document.querySelector("#fill-note").addEventListener("click", () => {
  note.value = "把结论提前，再用一个可验证的细节让观众留下来。";
  note.focus();
});
document.querySelector("#save-demo").addEventListener("click", () => {
  message.textContent = "示例已放入灵感库（页面刷新后重置）";
  results.hidden = false;
});

document.querySelectorAll(".result-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const selected = tab.dataset.result;
    document.querySelectorAll(".result-tab").forEach((item) => {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
    document.querySelector("#breakdown-panel").hidden = selected !== "breakdown";
    document.querySelector("#cases-panel").hidden = selected !== "cases";
  });
});

document.querySelectorAll(".rail-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".rail-item").forEach((entry) => entry.classList.remove("active"));
    item.classList.add("active");
    const view = item.dataset.view;
    if (view === "lab") {
      results.hidden = false;
      document.querySelector('[data-result="breakdown"]').click();
      message.textContent = "AI 实验室示例已打开";
    } else if (view === "library") {
      message.textContent = "灵感库示例已打开";
    } else {
      message.textContent = "快速记录示例已打开";
    }
  });
});
