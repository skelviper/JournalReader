# Journal Reader

<p align="center">
  <img src="apps/desktop/build/icon.png" alt="Journal Reader logo" width="120" />
</p>

Journal Reader 是一款面向生命科学科研阅读的桌面 PDF 阅读器（macOS / Windows），重点解决“看文献时边读边标注、快速定位图表和参考文献”的效率问题。

## 核心功能

- PDF 阅读：流畅缩放、滚动阅读、页码定位。
- 标注系统：高亮、文本注释、便签注释。
- 直写保存：标注可保存回原 PDF，首次保存自动创建 `.bak` 备份。
- 图表弹窗：在正文中选中并右键打开 `Figure/Table/Supplementary`，弹出对应图窗与 caption。
- 参考文献查看：可解析并查看文内 reference 对应条目。
- 手动校正：自动识别不准确时，支持手动绑定并复用。（TODO）

## 使用方式

1. 打开应用后，通过菜单 `File > Open` 选择 PDF（也支持拖拽文件到窗口）。
2. 用工具栏切换 `Pointer / Highlight / Text / Sticky` 进行阅读与标注。
3. 在正文里选中文字后右键，可执行高亮、搜索、翻译、打开图表/参考文献等操作。
4. 点击保存按钮，将当前标注写入 PDF。

## 适用范围

- 对英文科研论文（含文本层 PDF）支持最好。
- 当前不包含 OCR 扫描版识别能力。
- 某些复杂排版论文中，图表与 reference 识别可能需要手动校正。
