# Journal Reader（Electron）

面向 macOS 的桌面论文 PDF 阅读器，支持标注、笔记、文中引用点击后弹出图窗等能力。

## 当前已实现

- `Electron + React + TypeScript` monorepo 架构。
- 使用 `pdfjs-dist` 做 PDF 解析与文本层读取。
- 注释数据支持写回 PDF（`pdf-lib`），并在首次保存时自动生成 `.bak` 备份。
- 引用与 caption 解析支持：
  - `Figure/Fig.`
  - `Table`
  - `Supplementary Figure/Fig./Table`
- 自动映射失败时可手动绑定。
- 已实现 IPC 接口：
  - `doc.open`
  - `doc.parse`
  - `citation.resolve`
  - `figure.getTarget`
  - `annotation.create/update/delete`
  - `annotation.saveToPdf`
  - `mapping.bindManually`

## 目录结构

- `apps/desktop`
  - Electron 主进程 / preload / renderer。
- `packages/types`
  - 共享类型定义。
- `packages/storage`
  - 本地存储层（历史实现与仓储逻辑）。
- `packages/parser`
  - citation / caption 解析与自动映射。
- `packages/pdf-core`
  - PDF 元数据、文本提取、注释写回。
- `packages/ui`
  - 阅读器 UI、标注工具、弹窗交互。

## 本地开发

1. 安装依赖

```bash
npm install
```

2. 启动开发模式

```bash
npm run start
```

该命令会自动执行：
1. Electron 原生模块重建（`better-sqlite3`）  
2. workspace 包编译  
3. Electron + Vite 联合启动

3. 构建全部包

```bash
npm run build
```

4. 运行测试

```bash
npm test
```

## 说明

- 当前版本默认输入为可提取文本层的 PDF（不包含 OCR 流程）。
- 注释默认写回原 PDF 路径，备份文件为 `<原文件>.bak`。

## 已知问题 / 待办

- caption 在双栏（2-column）论文中，个别文献仍可能出现左右栏文本串读（例如左栏子图描述和右栏子图描述被拼到同一阅读顺序）。后续会继续优化列检测与跨栏重排逻辑。

## 排障

### Dock 有图标但无窗口 / 启动阶段 Promise 报错

可执行：

```bash
npm run rebuild:native
npm run start
```

常见原因：

- `better-sqlite3` 是原生模块，需要和本机 Electron ABI 匹配后才能正常加载。
