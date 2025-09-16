# Streaming Complete Notifier

## 项目简介
用于监测 Gemini、ChatGPT 与 AI Studio 的生成请求，当检测到生成结束时弹出桌面通知并播放提示音，可快速跳转回对应页面。

## 功能亮点
- 实时捕捉 Gemini、ChatGPT 与 AI Studio 的回答完成事件，并推送原生系统通知
- 新增 0~150% 的音量滑块，100% 为基准音量，150% 自动归一至 0 dB 峰值，确保放大不失真
- 支持在设置页即时试听，并在不同上下文下保持一致的音量体验

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

## 目录结构
```
streaming-complete-notifier/
├── src/
│   └── javascript/   # 扩展主体代码
└── design/           # 设计素材或原型
```

## 许可协议
MIT
