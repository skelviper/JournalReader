# Journal Reader（Electron）

面向 macOS 的桌面论文 PDF 阅读器，支持标注、笔记、文中引用点击后弹出图窗等能力。

Author: skelviper with help from Codex.

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

5. 运行样本 PDF 计数回归（layout-first）

```bash
npm run test:example-pdfs
```

可通过环境变量指定样本目录：

```bash
EXAMPLE_PDFS_DIR=/your/path/to/pdfs npm run test:example-pdfs
```

文件名约定（用于断言期望值）：

- `4main47ref.pdf` -> 期望 `main=4, ref=47`
- `5main64ref10ext.pdf` -> 期望 `main=5, ref=64, ext=10`
- `7main17sup_refwithname.pdf` -> 期望 `main=7, sup=17`

说明：

- `main/ext` 使用 caption 的基标签去重计数（忽略子图字母如 `1a/1b`）。
- `sup` 优先用非 table 的 supplementary figure 引用做连续序列计数（`1..N`），并与 caption 结果取更稳定值。
- `ref` 使用参考文献索引的稠密前缀推断并过滤尾部离群值（例如正文误检到的 `316/400`）。

## 打包与发布（macOS）

1. 本地打包（默认产出 `zip`，最稳）

```bash
npm run dist:mac
```

2. 需要 `dmg` 时单独生成（可选）

```bash
npm run dist:mac:dmg
```

3. 仅打包当前架构（可选）

```bash
npm run dist:mac:arm64
npm run dist:mac:x64
```

4. 仅生成未封装目录（调试安装包内容）

```bash
npm run pack:mac
```

产物目录：

- `apps/desktop/release/`

常见产物示例：

- `Journal Reader-0.1.0-arm64.zip`
- `Journal Reader-0.1.0-arm64.dmg`（可选）

## 说明

- 当前版本默认输入为可提取文本层的 PDF（不包含 OCR 流程）。
- 注释默认写回原 PDF 路径，备份文件为 `<原文件>.bak`。
- 当前 `dist:mac` 默认不做代码签名和 notarization，适合本地测试与内部分发。
- 若要对外正式 release（避免“无法验证开发者”提示），需要后续配置 Apple Developer 证书与 notarization。

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
