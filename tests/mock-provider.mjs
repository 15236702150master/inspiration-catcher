import { createServer } from "node:http";

createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "# 一句话结论\n先记录，再拆解。\n## 方法骨架\n- **快速捕捉**：链接与想法同时保存 → 降低遗忘。\n## 30 分钟内的下一步\n完成一张可执行卡片。" } }] }));
  });
}).listen(4280, "127.0.0.1");
