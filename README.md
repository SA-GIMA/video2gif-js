# 视频转 GIF 工具 (Video to GIF Tool) - Desktop Edition

**开发者：商建航**

## 简介

这是一个基于 Electron 的桌面端视频转 GIF 工具。它由原 Python 版本重构而来，采用了 Node.js (Express + Electron) 架构，保留了原版简约直观的 UI 界面和强大的并行转换逻辑。

本版本特别优化了 Windows 端的便携性，支持将 `ffmpeg` 核心组件封装进 `.exe` 程序中，实现真正的一键运行。

## 功能特性

- **一键转换**：支持多种视频格式（MP4, AVI, MOV, MKV, WebM, FLV, WMV）。
- **参数自定义**：可调帧率 (FPS)、输出宽度、起始时间、持续时长和循环次数。
- **高质量/快速模式**：支持 ffmpeg 双 pass 调色板技术，确保 GIF 色彩还原度。
- **并行处理**：支持最多同时转换 3 个视频文件。
- **本地化运行**：不依赖外部网络，文件处理均在本地完成。

## 环境要求

- **开发环境**: Node.js v14+
- **运行环境**: Windows 7+ / macOS

## 快速启动 (开发模式)

1. 安装依赖：
   ```bash
   npm install
   ```
2. 启动应用：
   ```bash
   npm start
   ```

## 打包指南 (Windows .exe)

如果你希望生成一个包含 `ffmpeg` 的独立可执行程序，请按照以下步骤操作：

1. **准备二进制文件**：
   - 在项目根目录下创建 `bin/win/` 文件夹。
   - 下载 Windows 版的 [ffmpeg.exe](https://www.gyan.dev/ffmpeg/builds/) 和 `ffprobe.exe`。
   - 将这两个文件放入 `bin/win/` 目录中。

2. **执行打包指令**：
   ```bash
   npm run dist
   ```
   打包完成后，在 `dist/` 目录下会生成安装包和绿色版程序。

## 项目结构

```
video2gif-js/
├── main.js           # Electron 主进程
├── server.js         # 后端服务逻辑 (含 FFmpeg 路径自动识别)
├── public/           # 前端界面资源
├── bin/              # (可选) 存放平台相关的 ffmpeg 二进制文件
├── package.json      # 项目配置与打包设定
└── README.md         # 项目文档
```

## 技术细节

- **后端**: Express.js
- **外壳**: Electron
- **核心**: FFmpeg
- **进度追踪**: Server-Sent Events (SSE)

## 注意事项

- 程序启动时会自动清理 `uploads/` 和 `output/` 文件夹下的旧文件。
- 打包时 `extraResources` 配置会确保 `bin/` 目录下的内容被正确拷贝至安装包的资源文件夹中。
