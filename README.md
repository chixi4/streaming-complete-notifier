# Streaming Complete Notifier

## 项目简介
用于监测 Gemini、ChatGPT 与 AI Studio 的生成请求，当检测到生成结束时弹出桌面通知并播放提示音，可快速跳转回对应页面。

## 环境准备
- 任意支持 Chrome 扩展开发的操作系统（Windows / macOS / Linux）
- Google Chrome 或 Microsoft Edge 浏览器（建议 116+）
- 本地文件系统权限（无需 Docker 或容器环境）

## 本地调试步骤
1. 克隆或下载本仓库：`git clone https://github.com/chixi4/streaming-complete-notifier.git`。
2. 打开浏览器 `chrome://extensions`（Edge 为 `edge://extensions`），开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择仓库中的 `src/javascript` 目录。
4. 在目标 AI 页面触发生成流程，确认通知与跳转逻辑工作正常。

## 发布打包
1. 将 `src/javascript` 目录下的文件打包为 zip（保持目录结构）。
2. 按 Chrome Web Store 或 Edge Add-ons 的要求上传该压缩包完成发布。

## Git 提交流程
1. 查看修改：`git status`。
2. 纳入版本控制：`git add .`（或按需挑选文件）。
3. 编写提交信息：`git commit -m "Remove Docker setup"`。
4. 推送到 GitHub：`git push origin <分支名>`。

## 目录结构
```
streaming-complete-notifier/
├── src/
│   └── javascript/   # 扩展主体代码
└── design/           # 设计素材或原型
```

## 许可协议
依据仓库实际选择的协议（如未指定，可在此处补充）。
