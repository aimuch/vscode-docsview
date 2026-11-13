# DocsView

在 VS Code 里直接预览常见文档，表格类文件可以就地编辑。**不依赖任何其他插件**：所有解析与渲染库都打包在插件内，离线可用，不从网络加载任何资源。

Preview common document formats inside VS Code and edit spreadsheets in place. **No other extensions required** — every parser and renderer is bundled, and nothing is loaded from the network. [English](#english) below.

## 支持的格式

| 格式 | 扩展名 | 打开方式 | 能力 |
| --- | --- | --- | --- |
| Markdown | `.md` `.markdown` | 标题栏预览按钮 | GitHub 风格渲染、代码高亮、Mermaid、KaTeX 公式、任务列表、脚注、目录、实时刷新、与编辑器滚动同步 |
| CSV / TSV | `.csv` `.tsv` | 标题栏预览按钮 | 表格视图，改单元格、增删行列；撤销/保存/编码由 VS Code 原生处理 |
| Excel | `.xlsx` `.xlsm` | 单击即预览 | 样式、合并单元格、冻结窗格、多工作表；可编辑单元格并保存 |
| Excel（旧版等） | `.xls` `.ods` | 单击即预览 | 只读 |
| Word | `.docx` | 单击即预览 | 页面版式、表格、图片、页眉页脚 |
| Word（旧版） | `.doc` | 单击即预览 | **仅文字**，无版式 |
| PDF | `.pdf` | 单击即预览 | 翻页、缩放、适应宽度、搜索、文字选择 |
| PowerPoint | `.pptx` | 单击即预览 | 幻灯片列表、缩放（近似效果） |

Markdown 与 CSV 默认仍以文本打开，和 VS Code 自带预览的习惯一致：点编辑器右上角的预览图标，或在命令面板运行 **DocsView：在侧边打开预览**。想让 CSV 默认用表格打开，可在设置里加：

```json
"workbench.editorAssociations": { "*.csv": "docsview.csv" }
```

任何文件都可以通过右键 → **打开方式…** 在 DocsView 与文本编辑器之间切换。

## 工具栏与外观

每个预览顶部是同一套工具栏：左边是当前格式的导航和视图切换，右边是对所有格式通用的外观设置。

| 格式 | 侧栏导航 | 视图切换 |
| --- | --- | --- |
| Markdown | 标题目录（可筛选、可折叠，随滚动高亮当前章节） | 预览 / 分栏（文本编辑器在旁边）/ 源码 |
| CSV / TSV | — | 表格 / 文本 |
| Excel | 底部工作表标签 | 样式 / 纯数据 |
| Word (.docx) | 由文档标题生成的目录 | 页面 / 连续 |
| PDF | 书签目录 / 页面缩略图 | 连续 / 单页 |
| PPT | 幻灯片列表 | 列表 / 单页 |

- **预览主题**：跟随编辑器、GitHub、纸张、学术，作用于 Markdown 正文；每个主题都有亮、暗两套配色。
- **明暗**：跟随编辑器 / 亮色 / 暗色。Word、PDF、PPT 的页面默认保持原稿白底，可在外观菜单里开启“暗色下页面反色”。
- **界面语言**：跟随 VS Code / 简体中文 / English。

- **高亮行列**（工具栏上的十字格图标）：CSV / Excel 中选中单元格时，整行和整列加浅色底（选中区域时覆盖其所有行列）；Markdown 表格中鼠标悬停时高亮所在行列。

这些选项保存在 VS Code 设置里，改动后所有已打开的 DocsView 预览立即同步。

Markdown / CSV 的文本编辑器右上角有两个 DocsView 图标：**打开预览**（在当前位置切到预览，预览已打开时直接切过去）和**在侧边打开预览**（分栏）。在预览里点“源码”后，用“打开预览”即可切回。

## 表格操作

- 方向键 / Tab / Enter 移动，Shift 扩选，`Ctrl/Cmd+A` 全选
- 双击、`Enter`、`F2` 或直接打字进入编辑；`Enter` 确认，`Esc` 取消，`Alt+Enter` 单元格内换行
- `Delete` 清空选区；`Ctrl/Cmd+C` / `X` / `V` 与 Excel 等互相复制粘贴
- 拖动列标题右边缘调整列宽
- 以 `=` 开头输入公式，以 `'` 开头强制按文本保存

### 关于 xlsx 编辑

保存时只改写被编辑单元格所在工作表的 XML，文件里其余部分（样式、图表、透视表、宏、图片）逐字节保留，不会因为在这里改了一个数而丢东西。相应的限制：

- 只能改单元格的值，不能增删行列或改样式
- 不计算公式。依赖被修改单元格的公式在这里显示旧值，文件已标记为"打开时重新计算"，用 Excel/WPS 打开即更新
- 共享公式、数组公式的主单元格为只读

## 设置

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `docsview.markdown.scrollSync` | `true` | Markdown 编辑器与预览同步滚动 |
| `docsview.csv.delimiter` | `auto` | CSV 分隔符；`auto` 按内容自动识别（逗号、分号、Tab、竖线） |
| `docsview.appearance.theme` | `editor` | 预览主题：`editor` / `github` / `paper` / `academic` |
| `docsview.appearance.colorScheme` | `auto` | 明暗：`auto`（跟随编辑器）/ `light` / `dark` |
| `docsview.appearance.invertPages` | `false` | 暗色下把 PDF、Word、PPT 页面反色显示 |
| `docsview.language` | `auto` | 界面语言：`auto` / `zh-cn` / `en` |
| `docsview.highlightRowColumn` | `true` | 高亮选中（表格）或悬停（Markdown 表格）单元格所在的行和列 |

## 已知限制

- `.doc` 只能提取文字；`.pptx` 的动画、部分复杂版式与图表还原有限
- `.docx` 按文件里记录的分页符分页；没有分页信息的文档（多为程序生成）会显示为一张连续的长页
- 超过约 40 MB 的 CSV 不提供表格视图
- 加密（带密码）的 Office 文件无法打开

## 开发

```bash
npm install
npm run samples     # 生成 samples/ 下的样例文件
npm run build       # 构建到 dist/
npm test            # 单元测试（vitest）
npm run dev         # 浏览器调试壳：http://localhost:5177/
npm run smoke       # 在本机 VS Code（临时配置）里逐格式打开样例
npm run package     # 生成 .vsix
```

在 VS Code 里按 `F5` 可启动扩展开发宿主并打开 `samples/`。

结构：`src/extension.ts` 注册各 Custom Editor；`src/host/` 是扩展宿主侧逻辑（CSV 解析、xlsx 读取与补丁写回、Markdown 渲染都是不依赖 `vscode` 的纯模块，可单测）；`src/webview/` 是各格式的界面，`src/webview/grid/` 为 CSV 与 Excel 共用的虚拟滚动表格。

第三方库及许可证见随插件一起发布的 `THIRD_PARTY_NOTICES.md`。

---

## English

| Format | Extensions | Opens | Features |
| --- | --- | --- | --- |
| Markdown | `.md` `.markdown` | preview button in the editor title | GitHub-style rendering, syntax highlighting, Mermaid, KaTeX, task lists, footnotes, outline, live refresh, scroll sync |
| CSV / TSV | `.csv` `.tsv` | preview button in the editor title | table view; edit cells, insert/delete rows and columns; undo/save/encoding handled by VS Code |
| Excel | `.xlsx` `.xlsm` | on click | styles, merged cells, frozen panes, multiple sheets; cell editing with save |
| Excel (legacy) | `.xls` `.ods` | on click | read-only |
| Word | `.docx` | on click | paged layout, tables, images, headers/footers |
| Word (legacy) | `.doc` | on click | **text only** |
| PDF | `.pdf` | on click | paging, zoom, fit width, search, text selection |
| PowerPoint | `.pptx` | on click | slide list, zoom (approximate rendering) |

Markdown and CSV keep opening as text; use the preview icon in the editor title or **DocsView: Open Preview to the Side**. Use **Reopen Editor With…** to switch any file between DocsView and the text editor.

**Toolbar and appearance:** every viewer shares one toolbar. On the left: a navigation sidebar (Markdown and Word headings with filter and collapse, PDF bookmarks or page thumbnails, PPT slide list) and a view switch (Markdown preview / split / source, CSV table / text, Excel styled / plain, Word pages / continuous, PDF continuous / single page, PPT list / single slide). On the right: preview theme (Editor, GitHub, Paper, Academic, each with light and dark palettes), light / dark / follow editor, optional inverted pages in dark mode, and the interface language (follow VS Code, 简体中文, English). A crosshair button highlights the row and column of the selected cell (CSV, Excel) or the hovered cell (Markdown tables). Markdown and CSV text editors get two DocsView title-bar buttons: open the preview in place, or to the side. Settings: `docsview.appearance.theme`, `docsview.appearance.colorScheme`, `docsview.appearance.invertPages`, `docsview.highlightRowColumn`, `docsview.language`.

**Editing xlsx:** saving rewrites only the worksheet XML of edited cells; every other part of the file (styles, charts, pivot tables, macros, images) is preserved byte-for-byte. In exchange, only cell values can be changed (no row/column insertion), formulas are not recalculated here (the workbook is flagged to recalculate when opened in Excel), and master cells of shared/array formulas are read-only.

**Limitations:** `.doc` shows extracted text only; `.docx` pages follow the page breaks stored in the file (documents without them render as one continuous page); `.pptx` rendering is approximate; CSV files over ~40 MB have no table view; password-protected Office files cannot be opened.
