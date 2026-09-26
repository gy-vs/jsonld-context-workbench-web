# JSON-LD Context 解析工作台

一个**完全离线**的 JSON-LD 1.1 context 解析工作台：输入 JSON-LD 文档与一组本地 context
资源，后端展开 compact IRI 并返回每个字段的**来源链（provenance）**，前端以树形方式
对照原文与展开结果，点击任一展开节点即可回溯到原始字段与完整的 context 决策链。

> **禁止访问公网 context**：`http(s)://` 及任何非 `local:` 的 context 引用一律被拒绝。
> 所有 context 必须先保存为本地不可变资源。

## 运行

```bash
npm start          # http://localhost:8080 （PORT 环境变量可改端口）
npm test           # 51 个单元 + 集成测试（node:test，零依赖）
```

零第三方依赖，Node ≥ 18 即可。首次启动自动写入三个演示资源
（`schema` / `ext` / `secure`），数据落盘在 `data/store.json`
（可用 `WORKBENCH_DATA` 环境变量覆盖）。

## 功能与架构

```
src/
  jsonld/
    iri.js        IRI 解析/拼接（RFC 3986 子集）
    context.js    JSON-LD 1.1 context 处理算法 + 决策链记录
    expand.js     展开算法 + 逐字段 provenance trace
    loader.js     本地快照加载器（local: 协议，钉死 revision）
    errors.js     结构化错误码
  store.js        不可变 revision 存储 + 会话快照（乐观并发）
  parse-service.js 解析编排
  server.js       零依赖 HTTP API + 静态前端
public/           原生 JS 前端（无构建步骤）
test/             parser / store / api 三层测试
```

### 解析器能力

- **嵌套 context**：context 对象可通过 `"@context": "local:other"` 再引入其它资源；
  文档级与节点级（scoped）context 均支持，节点级决策只作用于该节点子树，不泄漏给兄弟节点。
- **词项覆盖**：后处理的 context 覆盖先处理的词项；每次覆盖记入词项的
  `history`，前端展示「当前 ⇒ 历史」链。
- **@base / @vocab**：相对 IRI 按 `@base` 解析（支持相对 `@base` 叠加与
  `@base: null` 清除）；无词项的键按 `@vocab` 展开。
- **关键字别名**：词项可映射到 `@id` / `@type` 等关键字（如 `"id": "@id"`）。
- **容器**：`@list`、`@set`、`@index`、`@language`、`@id`、`@type` map。
- **受保护词项**：`@protected: true` 的词项不能被不同映射重定义，也不能被
  `null` 删除；空 context 重置（`"@context": [..., null]`）时受保护词项保留。
- **循环与深度**：资源引用环（`local:a ↔ local:b`）报 `cyclic IRI mapping` 并给出
  环路径；context 嵌套深度（默认 32）与数据展开深度（默认 64）超限分别报
  `context overflow` / `processing depth exceeded`。

### 不可变 revision 与并发

- 资源 body 的 revision id = 规范化 JSON 的 SHA-256 内容哈希，**同内容同 revision**，
  重复保存幂等、不产生历史。
- 更新已存在的资源**必须**携带 `baseRevision`；与当前 head 不符即返回
  `409 revision conflict`（响应里附带当前 head 与其 body 供合并）——
  两个页面同时改同名资源时，后到者收到冲突而不是静默覆盖（无 last-write-wins）。
- **解析会话绑定资源快照**：创建会话时把 `name → revision` 钉死；此后资源继续演进，
  会话内解析结果不变，完全可复现。

### 来源链（provenance）

每个展开字段都带一条 trace：原始字段路径（`$.a.b[0]`）、展开输出路径、
展开后 IRI、词项解析方式（term / compact-IRI / @vocab / absolute-IRI，
含覆盖历史）以及**该节点可见的完整决策链**（文档级 + 各级 scoped，
含每次 include 钉死的 revision、@base/@vocab 变更、词项定义/覆盖/删除、
空 context 重置及其保留的受保护词项）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/resources` | 资源列表（名称、最新 revision、修订数） |
| GET | `/api/resources/:name` | 资源详情 + 全部 revision 列表 |
| GET | `/api/resources/:name/revisions/:rev` | 读取历史 revision（不可变） |
| PUT | `/api/resources/:name` | `{ body, baseRevision }` 创建/追加 revision；冲突返回 409 |
| GET/POST | `/api/sessions` | 会话列表 / 创建（`{ name?, bindings, document? }`） |
| GET/DELETE | `/api/sessions/:id` | 读取（含快照）/ 删除会话 |
| POST | `/api/sessions/:id/parse` | 用会话快照解析（可顺带更新文档） |
| POST | `/api/parse` | 一次性解析：`{ document, bindings, baseUrl? }` |

错误统一为 `{ error: { code, message, details? } }`，主要 code：
`loading remote context failed`、`cyclic IRI mapping`、`context overflow`、
`processing depth exceeded`、`protected term redefinition`、
`revision conflict`、`unknown resource`、`validation error`。

## 前端

- 三栏布局（输入+绑定 / 原文↔展开双树 / 追踪+决策链），**窄屏自动切换为
  标签页**（文档 / 对照 / 决策链 / 资源库），树可逐层折叠展开。
- 点击展开树任意节点 → 右侧显示来源字段（原文树同步高亮并滚动定位）、
  展开 IRI、词项解析方式与覆盖历史、该字段可见的完整决策链；
  点击原文树节点可反向定位其展开结果。
- 资源编辑器显示当前 base revision；保存遇 409 时展示冲突面板
  （对方版本内容 + 「基于最新覆盖保存 / 放弃修改」两个合并选项）。
