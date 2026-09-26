# JSON-LD 上下文解析工作台

一个**零公网依赖**的 JSON-LD Context 解析工作台。用户输入文档与一组本地 context 资源，
后端展开 compact IRI，并为每个字段记录完整的来源决策链；前端以**原文 / 展开双树对照**
方式呈现，点击任一节点即可追踪到原始字段与经过的每一层 context 决策。窄屏下可逐层钻取。

## 特性

### Context 处理能力（`context.js`，按 JSON-LD 1.1 语义实现）
- 嵌套 context：数组按序合并、对象内 `@context` 分组、字符串引用本地资源
- 词项覆盖：后定义覆盖前定义，保留完整 `define → override → remove` 历史
- `@base`：文档相对 IRI、嵌套资源中逐级相对解析、`null` 清空
- `@vocab`：词表相对解析（非 `/`、`?` 结尾一律拼接，符合 1.1 规范）、compact IRI 前缀链
- 容器：`@list` / `@set` / `@index` / `@language` / `@id` / `@type` / `@graph`
- 属性作用域与类型作用域 `@context`（类型作用域在值展开**前**生效）
- 受保护词项 `@protected`：不一致重定义拒绝（409），兼容重述保留，显式 `null` 可清除
- 关键字别名（`id → @id`、`type → @type` 及其合法例外）与非法别名校验
- **空 context 重置**：`@context: null` 清空 `@base/@vocab/语言/词项`
- 相对 IRI、compact IRI 前缀、空节点 `_:`、`@type: @id/@vocab/@json` 强制
- **循环检测**：资源引用祖先链（a→b→a）、内联对象回环、词项 IRI 映射自环、compact 前缀链回环
- **最大深度**：context 嵌套深度与文档嵌套深度分别可配，超限结构化报错并给出路径
- **禁止访问公网**：`http/https/ftp/file` 引用一律拒绝（`remote-context-forbidden`）

### 资源与会话（`store.js`）
- 资源正文按内容 hash 保存为**不可变 revision**（canonical JSON，等价内容共享 revision）
- 更新采用 **CAS（compare-and-swap）**：必须携带 `expectedRevision`
- 两个页面修改同名资源时，后到者得到 **409 revision-conflict**（而非最后写入覆盖），
  响应回传服务端当前 head 与正文供三方合并
- 解析**会话绑定资源 revision 快照**：解析只从快照加载，资源更新后旧会话结果可复现
- 快照过期检测、按 revision 重新绑定、原子落盘（tmp + rename）

### 前端（`public/`，无框架原生 JS）
- 原文树 / 展开树并排对照，点击联动高亮（父子路径弱高亮）
- 决策链面板：字段对照 → IRI 解析机制 → 词项定义与历次覆盖 → context 层链 → 事件时间线 → 警告
- context 层以 chip 呈现（引用资源 / 属性·类型作用域 / 空重置），点击查看该层全部事件
- 资源编辑器：revision 历史、基于 head 的 CAS 保存、冲突弹窗并可一键拉取服务端正文
- 窄屏（≤980px）：三个 Tab（文档/资源、双树、决策链）+ 双树互切 + **逐层钻取**与面包屑返回

## 快速开始

```bash
node server.js
# 打开 http://localhost:5173
```

环境变量：
- `PORT`（默认 5173）
- `WORKBENCH_DATA_DIR`（默认 `./data`，资源/会话持久化目录）

首启自动写入 3 个演示资源（`ex-base`、`ex-profile`、`ex-empty`）。点击「载入演示」可填入
覆盖 @vocab/@base、protected 覆盖、容器、属性作用域、compact 前缀的示例文档。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/resources` | 资源列表（含 revision 元信息） |
| POST | `/api/resources` | 创建资源 |
| GET | `/api/resources/:id/head` | 取 head 正文 |
| GET | `/api/resources/:id/revisions/:rev` | 取指定不可变 revision |
| PUT | `/api/resources/:id` | CAS 更新（body: `content`,`expectedRevision`），冲突 409 |
| POST | `/api/sessions` | 创建会话（body: `rootRefs:[{resourceId,revision?}]`） |
| GET | `/api/sessions/:id` | 会话与文档 |
| POST | `/api/sessions/:id/rebind` | 重绑快照 pin |
| GET | `/api/sessions/:id/stale` | 快照过期报告 |
| POST | `/api/sessions/:id/expand` | 基于快照展开，返回 `{document,root,trace}` |

资源引用为资源 ID 字符串（如 `"ex-profile"`），也支持片段：
`bundle#/contexts/person`（JSON Pointer）或 `bundle#a.b`（点分）。

## 测试

```bash
npm test          # 36 项：context 引擎 + 存储/会话/并发（node:test）
npm run test:api  # 9 项：进程内 HTTP 端到端（展开、未知资源、公网拦截、
                  #       protected、循环、并发冲突、快照隔离、深度限制）
```

> 注：API 测试会在进程内监听临时回环端口；在禁止 `listen` 的沙箱中需放开网络权限运行。

## 代码结构

```
errors.js   统一错误码
iri.js      绝对 IRI / 远程协议判定、@base 与 @vocab 相对解析
context.js  Context Processing：活动上下文、词项定义、protected、循环、深度、来源 trace
expand.js   Value Expansion：节点树 + 每个字段的 decision、容器/作用域/强制
store.js    不可变 revision、CAS、会话快照 loader（拒绝公网与快照外资源）
seed.js     首启演示资源与文档
server.js   零依赖 HTTP API + 静态前端
public/     前端（index.html / styles.css / app.js）
test/       context/store 单测与 API 端到端
```

## 安全边界
- 解析器**只**从会话快照读取 context，任何 `http(s)://` 等远程引用直接拒绝，不发起网络请求。
- 会话引用未固定资源返回 `unknown-resource`，避免隐式拉取。
- revision 不可变 + CAS，保证并发编辑可检测、历史可回溯、旧会话结果可复现。
