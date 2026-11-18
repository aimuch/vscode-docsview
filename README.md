# DocsView

在 VS Code 里直接预览常见文档，表格类文件可以就地编辑。**不依赖任何其他插件**：所有解析与渲染库都打包在插件内，离线可用，不从网络加载任何资源。

Preview common document formats inside VS Code and edit spreadsheets in place. **No other extensions required** — every parser and renderer is bundled, and nothing is loaded from the network. [English](#english) below.

## 支持的格式

| 格式 | 扩展名 | 打开方式 | 能力 |
| --- | --- | --- | --- |
| Markdown | `.md` `.markdown` | 标题栏预览按钮 | GitHub 风格渲染、YAML Frontmatter 属性卡片、GitHub Alerts、可勾选任务列表、Mermaid 全屏交互灯箱、`.pdf#page=N` / `.pptx#slide=N` 深链接跳转、`F5` 幻灯片演示模式、`Ctrl/Cmd+V` 粘贴图片自动落盘 `assets/`、悬停本地图片一键打开像素/BBox 检查器 |
| CSV / TSV / JSONL | `.csv` `.tsv` `.jsonl` `.ndjson` | 标题栏预览按钮 | 表格 / 分栏 / 文本三态视图、**JSONL 单条记录详情抽屉（完整嵌套 JSON 检视与写回）**、CSV/Excel ↔ JSONL 互转、多选唯一值筛选与数值比较筛选、`Ctrl/Cmd+H` 查找替换、数据条/色阶、日期与公式拖拽自动填充、复制为 Markdown / JSON、冻结与增删行列 |
| Excel | `.xlsx` `.xlsm` | 单击即预览 | 样式、合并单元格、多选值筛选与数值筛选、`Ctrl/Cmd+H` 查找替换（自动保护公式）、数据条/色阶条件格式、拖拽序列/日期/公式自动填充、复制为 Markdown / JSON、转为 CSV/TSV/JSONL、`fx` 公式栏与实时计算、多工作表编辑 |
| Excel（旧版等） | `.xls` `.ods` | 单击即预览 | 只读（支持多选筛选、条件格式、选区统计、复制为 Markdown / JSON 及另存为 `.xlsx` / `.jsonl`） |
| Word | `.docx` | 单击即预览 | 页面版式、**一键导出整篇 Markdown（`.md`）**、`Ctrl/Cmd+F` 全文搜索、中英文字体映射、双击段落就地修改文字、标准 OOXML 批注及导出批注清单 |
| Word（旧版） | `.doc` | 单击即预览 | **仅文字**，支持缩放、`Ctrl/Cmd+F` 全文搜索、**导出 `.md`**、字数段落统计与调用本地 Office/WPS 打开 |
| PDF | `.pdf` | 单击即预览 | 翻页、页面重组（`90°` 旋转写回保存、删除页、缩略图重排、提取页码范围、合并 PDF）、跨行多段精准划词高亮（`QuadPoints` `/Highlight`）与摘录批注、旋转页自适应 ISO 32000 框选/图钉批注、导出批注 Markdown |
| PowerPoint | `.pptx` | 单击即预览 | 原生画幅比例、**一键导出整份幻灯片 + 备注为 Markdown（`.md`）**、演讲者备注栏与 `F5` 全屏放映提词器浮窗 + 激光笔、全文搜索、双击文本框改字、标准幻灯片批注 |
| 图片编辑与视觉标注 | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` `.svg` `.ico` `.avif` | 单击即预览（`.svg` 支持分栏源码实时同步） | 15×11 放大镜取色（RGB/HEX/HSL、最近色板）、**EXIF / PNG DPI / AI Prompt 元数据检视**、**`[` / `]` 同目录数据集上下张翻图与自动加载同名 YOLO/COCO 标注**、视觉对比 Diff、涂鸦与马赛克画笔、旋转/翻转/缩放/裁剪及格式互转 |
| EPUB 电子书 | `.epub` | 单击即预览 | 纯离线解析 EPUB 2/3 目录、跨章超链接与内嵌图片，共享编辑器/GitHub/纸张/学术主题、自适应页宽、**导出整书 Markdown（`.md`）**、缩放与全文搜索 |
| 压缩包检视 | `.zip` `.vsix` `.whl` `.jar` `.apk` `.nupkg` `.tar` `.tar.gz` `.tgz` | 单击即预览 | 免解压秒读目录树（含 GNU LongLink / PAX 长路径与防炸弹保护）、分栏直接预览内部代码/文本/SVG/图片、**双击免弹窗直开**、一键整包安全解压 |

Markdown 与 CSV 默认仍以文本打开，和 VS Code 自带预览的习惯一致：点编辑器右上角的预览图标，或在命令面板运行 **DocsView：在侧边打开预览**。想让 CSV 默认用表格打开，可在设置里加：

```json
"workbench.editorAssociations": { "*.csv": "docsview.csv" }
```

任何文件都可以通过右键 → **打开方式…** 在 DocsView 与文本编辑器之间切换。

## 工具栏与设置抽屉

每个预览顶部共享一套精简工具栏：左侧默认放置当前格式的导航与常用工具，最右侧是 **设置按钮（齿轮图标）**，点击从右侧滑出设置抽屉。

| 格式 | 侧栏导航 | 视图切换 |
| --- | --- | --- |
| Markdown | 标题目录（可筛选、可折叠，随滚动高亮当前章节） | 预览 / 分栏（文本编辑器在旁边）/ 源码 |
| CSV / TSV | — | 表格 / 分栏 / 文本 |
| Excel | 底部工作表标签 | 样式 / 纯数据 |
| Word (.docx) | 目录 / 批注列表 | 页面 / 连续 |
| PDF | 书签目录 / 页面缩略图 / 批注列表 | 连续 / 单页 |
| PPT | 幻灯片列表 / 批注列表 | 列表 / 单页 |

在右侧 **设置抽屉** 中集中管理：
- **当前文档**：导出 HTML / PDF、表格格式互转、版本历史、设为默认打开方式、从右到左（RTL）等。
- **预览主题**：跟随编辑器、GitHub、纸张、学术，作用于 Markdown 正文；每个主题都有亮、暗两套配色。
- **明暗与反色**：跟随编辑器 / 亮色 / 暗色；暗色下可开启 PDF、Word、PPT 页面反色。
- **界面语言**：跟随 VS Code / 简体中文 / English。
- **顶栏布局（显示与排序）**：自由选择哪些工具或快捷项（如主题、明暗、语言、导出、历史等）固定在顶部工具栏中，支持在**顶栏左侧 / 右侧**之间移动、拖拽或上下调整排列顺序，也可一键恢复默认。

- **高亮行列**（工具栏上的十字格图标）：CSV / Excel 中选中单元格时，整行和整列加浅色底（选中区域时覆盖其所有行列）；Markdown 表格中鼠标悬停时高亮所在行列。

这些选项保存在 VS Code 设置里，改动后所有已打开的 DocsView 预览立即同步。

Markdown / CSV 的文本编辑器右上角有两个 DocsView 图标：**打开预览**（在当前位置切到预览，预览已打开时直接切过去）和**在侧边打开预览**（分栏）。在预览里点“源码”后，用“打开预览”即可切回。

## 常用操作

**Markdown 预览**
- **查找**：工具栏的查找框（`Ctrl/Cmd+F`），`Enter` / `Shift+Enter` 在匹配处之间跳转。
- **编辑模式**（铅笔图标）：双击任意段落、标题、列表、表格或代码块，就地修改它的 Markdown 原文，`Ctrl/Cmd+Enter` 保存、`Esc` 取消。改动写回文件，可以用 VS Code 的撤销还原；如果编辑期间文件被别处改动，这次修改不会写入。
- **导出**（更多 → 导出 HTML / 导出 PDF）：导出的 HTML 是单个文件，自带样式、公式字体、图表和本地图片。“导出 PDF”会在浏览器中打开并弹出打印对话框，选“存储为 PDF”即可。

**CSV / Excel 表格**
- **排序与筛选**：鼠标移到列标题上，点右侧的小箭头，可升序/降序排列，或筛选“包含”某段文字的行（多列条件同时生效）。数字按数值排序，空单元格始终排在最后。首行（或 Excel 冻结的表头行）不参与排序。排序和筛选只改变显示，不改动文件；行号仍显示原始行号，此时编辑的单元格会写回正确的原始行。排序或筛选期间不能增删行列，点工具栏提示里的“清除”即可恢复。
- **锁定编辑**（锁形图标）：打开后单元格不能修改，防止误改；设置项为 `docsview.table.lockEditing`。
- **格式转换**（更多 → 转换为 …）：CSV、TSV、XLSX 之间互转；Excel 转 CSV/TSV 时转换当前工作表，使用显示出来的值；.xls / .ods 可另存为 .xlsx。

**所有可编辑的格式**
- **设为默认打开方式**（更多菜单）：让 .md / .csv / .tsv 文件双击就用 DocsView 打开，再点一次取消。
- **版本历史**（更多 → 版本历史，或命令“DocsView：查看版本历史”）：Markdown、CSV、xlsx 每次保存前都会自动保留一份旧版本（每个文件最多 30 份），可以与当前文件对比、打开查看或恢复。恢复前会先把当前内容也存为一个版本。
- **从右到左（RTL）**（更多菜单）：Markdown 整页按从右到左排版；表格中单元格文字从右到左显示，列顺序不变。

## 表格操作

- 方向键 / Tab / Enter 移动，Shift 扩选，`Ctrl/Cmd+A` 全选
- 双击、`Enter`、`F2` 或直接打字进入编辑；`Enter` 确认，`Esc` 取消，`Alt+Enter` 单元格内换行
- `Delete` 清空选区；`Ctrl/Cmd+C` / `X` / `V` 与 Excel 等互相复制粘贴
- 拖动列标题右边缘调整列宽
- 以 `=` 开头输入公式，以 `'` 开头强制按文本保存

### 关于 xlsx 编辑与公式计算

保存时采用 OOXML 局部补丁：只改写受影响的工作表与工作簿关系，文件里其余未触碰的部分（样式、图表、透视表、宏、图片）逐字节保留。支持：

- **公式栏与实时求值**：可通过顶部 `fx` 公式栏或双击单元格输入数值、文本与 `=` 公式，内置引擎实时计算四则运算、跨表引用及常用函数（`SUM`、`AVERAGE`、`COUNT`、`MIN`、`MAX`、`IF`、`IFS`、`IFERROR`、`SUMIF`、`COUNTIF`、`VLOOKUP`、`XLOOKUP`、`INDEX`、`MATCH`、`ROUND`、文本与日期函数等），并在保存时同时标记 `fullCalcOnLoad="1"`
- **增删行列与自动移位**：可通过工具栏按钮或右键菜单在任意位置插入/删除行列，自动平移合并单元格区域与公式引用坐标
- **工作表管理**：底部标签栏支持 `+` 新建工作表、双击或右键重命名工作表、删除工作表（全部接入 VS Code 原生撤销/重做）

## 设置

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `docsview.markdown.scrollSync` | `true` | Markdown 编辑器与预览同步滚动 |
| `docsview.markdown.contentWidth` | `fixed` | Markdown 正文宽度：`fixed`（固定阅读宽度）/ `fluid`（自适应铺满窗口） |
| `docsview.markdown.splitPosition` | `sourceLeft` | 分栏预览左右顺序：`sourceLeft`（源码在左）/ `previewLeft`（预览在左） |
| `docsview.csv.delimiter` | `auto` | CSV 分隔符；`auto` 按内容自动识别（逗号、分号、Tab、竖线） |
| `docsview.appearance.theme` | `editor` | 预览主题：`editor` / `github` / `paper` / `academic` |
| `docsview.appearance.colorScheme` | `auto` | 明暗：`auto`（跟随编辑器）/ `light` / `dark` |
| `docsview.appearance.invertPages` | `false` | 暗色下把 PDF、Word、PPT 页面反色显示 |
| `docsview.language` | `auto` | 界面语言：`auto` / `zh-cn` / `en` |
| `docsview.highlightRowColumn` | `true` | 高亮选中（表格）或悬停（Markdown 表格）单元格所在的行和列 |
| `docsview.table.lockEditing` | `false` | 锁定 CSV / Excel 单元格编辑 |
| `docsview.showNotices` | `true` | 在预览顶部显示格式说明提示条 |
| `docsview.image.loupePosition` | `follow` | 图片像素取色放大镜位置：`follow`（跟随指针）/ `fixed`（固定在右上角） |
| `docsview.sidebarPosition` | `left` | 导航/目录/批注侧边栏位置：`left`（左侧）/ `right`（右侧） |
| `docsview.comments.author` | `""` | Word / PPT / PDF 添加批注时记录的作者名称（留空默认使用当前系统用户名） |
| `docsview.toolbar` | 默认左区 | 顶部工具栏左侧与右侧显示的项目及其排列顺序 |

## 已知限制

- `.doc` 只能提取文字；`.pptx` 的动画、部分复杂版式与图表还原有限
- `.docx` 按文件里记录的分页符分页；没有分页信息的文档（多为程序生成）会显示为一张连续的长页
- 超过约 40 MB 的 CSV 不提供表格视图
- 加密（带密码）的 Office 文件无法打开

## 下载安装

每次推送到 `main`，GitHub Actions 都会编译、测试（含真实 VS Code 中的冒烟测试）并在 [Releases](https://github.com/aimuch/vscode-docsview/releases) 发布离线安装包 `docsview-<版本>.vsix`。版本号的补丁位是构建序号（例如 `0.1.23`），主、次版本号取自 `package.json`。

下载后在 VS Code 扩展视图右上角 **…** → **从 VSIX 安装…**，或运行：

```bash
code --install-extension docsview-0.1.23.vsix
```

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
| Markdown | `.md` `.markdown` | preview button in the editor title | GitHub-style rendering, YAML frontmatter property card, Alerts, task checkboxes, Mermaid lightbox, `.pdf#page=N` / `.pptx#slide=N` deep links, `F5` slide deck, `Ctrl/Cmd+V` image paste to `assets/`, KaTeX, outline & scroll sync |
| CSV / TSV / JSONL | `.csv` `.tsv` `.jsonl` `.ndjson` | preview button in the editor title | table / split / text views, **JSONL Record Inspector drawer (nested JSON tree & write-back)**, CSV/Excel ↔ JSONL conversion, multi-select & numeric filters, `Ctrl/Cmd+H` replace, conditional formatting, ISO date & formula autofill |
| Excel | `.xlsx` `.xlsm` | on click | styles, merged cells, multi-select & numeric filters, formula-safe `Ctrl/Cmd+H` replace, conditional formatting, drag series/date/formula autofill, copy as Markdown / JSON, convert to CSV/TSV/JSONL, `fx` formula bar & multi-sheet editing |
| Excel (legacy) | `.xls` `.ods` | on click | read-only (with advanced filters, conditional formatting, selection stats & convert to `.xlsx` / `.jsonl`) |
| Word | `.docx` | on click | paged layout, **one-click Export to Markdown (`.md`)**, `Ctrl/Cmd+F` search, CJK font aliases, double-click paragraph editing, interoperable OOXML comments & Markdown comment export |
| Word (legacy) | `.doc` | on click | **text only**, with zoom, `Ctrl/Cmd+F` search, **export as `.md`**, word/paragraph stats & open in system app |
| PDF | `.pdf` | on click | page restructuring (`90°` rotation, delete/reorder/extract/merge), multi-quad per-line `/Highlight` & quote comments, rotation-aware ISO 32000 box/pin annotations & Markdown comment export |
| PowerPoint | `.pptx` | on click | native slide aspect ratio, **one-click Export to Markdown (`.md`)**, Speaker Notes & `F5` fullscreen teleprompter + virtual laser pointer, cross-slide search, shape text editing & OOXML comments |
| Images | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` `.svg` `.ico` `.avif` | on click (`.svg` live-syncs split source) | 15×11 pixel loupe, **EXIF / PNG DPI / AI prompt metadata inspector**, **`[` / `]` folder dataset stepping & sibling YOLO/COCO auto-load**, Image Diff, markup & mosaic brush, rotate/flip/resize/crop & format conversion |
| EPUB Books | `.epub` | on click | offline EPUB 2/3 TOC, cross-chapter links & embedded images with DocsView themes, fluid width, **Export to Markdown (`.md`)**, zoom & search |
| Archives | `.zip` `.vsix` `.whl` `.jar` `.apk` `.nupkg` `.tar` `.tar.gz` `.tgz` | on click | instant directory tree (GNU LongLink / PAX + zip-bomb & Zip-Slip guards), inline code/SVG/image preview, **double-click zero-dialog open** & Extract All |

Markdown and CSV keep opening as text; use the preview icon in the editor title or **DocsView: Open Preview to the Side**. Use **Reopen Editor With…** to switch any file between DocsView and the text editor.

**Toolbar and appearance:** every viewer shares one toolbar. On the left: a navigation sidebar (Markdown and Word headings with filter and collapse, PDF bookmarks or page thumbnails, PPT slide list) and a view switch (Markdown preview / split / source, CSV table / text, Excel styled / plain, Word pages / continuous, PDF continuous / single page, PPT list / single slide). On the right: preview theme (Editor, GitHub, Paper, Academic, each with light and dark palettes), light / dark / follow editor, optional inverted pages in dark mode, and the interface language (follow VS Code, 简体中文, English). A crosshair button highlights the row and column of the selected cell (CSV, Excel) or the hovered cell (Markdown tables). Markdown and CSV text editors get two DocsView title-bar buttons: open the preview in place, or to the side. Settings: `docsview.appearance.theme`, `docsview.appearance.colorScheme`, `docsview.appearance.invertPages`, `docsview.highlightRowColumn`, `docsview.language`.

**More features:** find in the Markdown preview (Ctrl/Cmd+F); an edit mode where double-clicking a block edits its Markdown source in place; export to a self-contained HTML file, or to PDF through the browser's print dialog; column sort and "contains" filters in CSV/Excel views (display only, the file is never reordered; edits still land on the right rows); a lock that prevents accidental cell edits; conversion between CSV, TSV and XLSX; one-click "open .md/.csv with DocsView by default"; version history (a copy is kept before every save, up to 30 per file, with compare/open/restore); right-to-left text.

**Editing xlsx:** saving patches only the affected OOXML parts so untouched styles, charts, pivot tables, macros and images are preserved byte-for-byte. Includes an editable `fx` formula bar, real-time formula evaluation (arithmetic, cross-sheet refs, `SUM`, `AVERAGE`, `IF`, `SUMIF`, `COUNTIF`, `VLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`, etc.), row/column insertion and deletion with automatic reference/merge shifting, and worksheet creation, renaming and deletion with full VS Code Undo/Redo.

**Limitations:** `.doc` shows extracted text only; `.docx` pages follow the page breaks stored in the file (documents without them render as one continuous page); `.pptx` rendering is approximate; CSV files over ~40 MB have no table view; password-protected Office files cannot be opened.
