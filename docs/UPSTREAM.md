# 上游核实记录 · fflate 0.8.3

> 本文件只记录**可复核的事实**：仓库元数据、源码行号、测试文件、公开 issue、实测输出。
> 所有数字都能用 `node scripts/baseline-upstream.js` 重跑（输出 `docs/BASELINE.json`）。

核实时间：2026-10-25。所有 GitHub 数据来自 REST API 当日响应。

---

## 1. 三个候选的横向核实

| 项目 | Star | 许可 | 最近推送 | 开放 issue | 发布 | 运行时 | 是否校验 CRC |
|---|---:|---|---:|---:|---|---|---|
| [101arrowz/fflate](https://github.com/101arrowz/fflate) | 3,065 | MIT（LICENSE 全文 20 行） | 2026-05-16 | 56 | npm 0.8.3 | 浏览器 + Node | **否**（见 §3） |
| [thejoshwolfe/yauzl](https://github.com/thejoshwolfe/yauzl) | 831 | MIT | 2026-06-07 | 12 | 无 GitHub Release | 仅 Node（`fd-slicer`） | **否**，作者明确声明 |
| [cthackers/adm-zip](https://github.com/cthackers/adm-zip) | 2,184 | MIT | 2026-10-18 | 60 | v0.6.1 (2026-09-11) | 仅 Node | **是**（`zipEntry.js:40` `crc32OK`） |

### 1.1 fflate 的 ZIP 层没有任何测试

`test/` 下共 6 个文件，其中三个是空壳：

```
test/0-valid.ts    21 行
test/1-size.ts     23 行
test/2-perf.ts     46 行
test/3-zip.ts      17 字节  →  // TODO: test ZIP
test/4-streams.ts  41 字节  →  // TODO: test all streams (including ZIP)
test/5-async.ts    62 字节  →  // TODO: test all async operations (including streams and ZIP)
```

`package.json` 的 `scripts.test` 是 `uvu -b -r ts-node/register test`，即**这三个空文件也被当作"测试通过"计入**。
也就是说：0.8.3 的 ZIP 容器行为（`zip` / `unzip` / `unzipSync` / `Zip` / `Unzip` / `AsyncZipDeflate`）没有一条回归测试。

### 1.2 C 候选确实做了 CRC 校验 —— 这一点必须在差异化里承认

`adm-zip` 的 `zipEntry.js:40-57`：

```js
function crc32OK(data) {
    // When bit 3 ... set, the crc-32 and sizes are in the data descriptor ...
    const expectedCrc = _centralHeader.flags_desc || _centralHeader.localHeader.flags_desc ? _centralHeader.crc : _centralHeader.localHeader.crc;
    return Utils.crc32(data) === expectedCrc;
}
```

实测（本机，2026-10-25）：

| 输入 | adm-zip 行为 |
|---|---|
| stored 条目翻转 1 bit | `getData()` 抛 `ADM-ZIP: CRC32 checksum failed {0}` |
| 尾部截断 | 构造即抛 `No END header found` |
| deflate 中途损坏 | `getData()` 抛 `unexpected end of file` |

所以"校验 CRC"不是本项目的独有价值，只是及格线。`yauzl` 的 README §"No CRC-32 Checking" 原文：

> This library provides the `crc32` field of `Entry` objects read from the Central Directory.
> However, this field is not used for anything in this library.

### 1.3 结论：不是"谁校验 CRC"，而是"谁能在坏掉之后说清楚并救回来"

三个候选在**索引（EOCD + 中央目录）被破坏**后的行为：

| 库 | 中央目录被抹掉 | 尾部被截断 | 结果 |
|---|---|---|---|
| fflate | `unzipSync` 抛 `code=14 unknown compression type 65535` | 抛 `code=13 invalid zip data` | 整个包不可用 |
| adm-zip | 构造抛 `No END header found` / `Invalid or unsupported zip format` | 同左 | 整个包不可用 |
| yauzl | 依赖中央目录，无回退路径（`readEntry` 由 CD 驱动） | 同左 | 整个包不可用 |

**三者都没有"丢掉索引、按本地文件头顺序扫描"的路径。** 这是本项目存在的第一个理由。

---

## 2. fflate 内部实现（选定项目的核心能力）

单文件实现：`src/index.ts`，3,854 行，导出约 60 个符号。

| 层 | 代码位置 | 能力 |
|---|---|---|
| DEFLATE 编解码内核 | `src/index.ts:257` `inflt()` / `:1000+` `dflt()` | 手写 Huffman + LZ77，流式/同步双形态 |
| gzip / zlib 封装 | `:1050-1250` | CRC32、Adler32、gzip 头尾 |
| 流式 API | `Inflate` `:1152`、`Deflate`、`Gunzip`、`Zip` `:3140+`、`Unzip` `:3598` | 分块推入，`ondata(chunk, final)` |
| ZIP 容器 | `zipSync` `:3300+`、`unzipSync` `:3820`、`zip`、`unzip` | 读写 ZIP，支持 store/deflate、basic ZIP64 |
| Worker 加速 | `worker.ts` / `node-worker.ts` | 大块异步解压走线程 |

**关键实现事实**：ZIP 读取路径完全不信本地文件头，只读中央目录：

```ts
// src/index.ts:3839-3851 (unzipSync)
for (let i = 0; i < c; ++i) {
  const [c, sc, su, fn, no, off] = zh(data, o, z), b = slzh(data, off);
  o = no;
  if (!c) files[fn] = slc(data, b, b + sc);              // stored: 直接切片
  else if (c == 8) files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
  else err(14, 'unknown compression type ' + c);
}
```

三件事值得注意：

1. **没有任何 CRC 比较**。`crc()` 只在写 ZIP/gzip 时被调用（`:3311`、`:3372`），读取路径完全不碰。
2. `files[fn] = ...` 用对象字面量按**文件名**存结果 → 同名条目后者覆盖前者（实测：`same.txt` 只剩 `SECOND`）。
3. 出错只有 3 个数字错误码：`:210-212` 的 `InvalidZipData: 13`、`UnknownCompressionMethod: 14`、以及内核的 `unexpected EOF: 0`，没有"哪个条目、哪个字段"的信息。

`Unzip` 流式类的收尾同样只有一句 `err(13)`：

```ts
// src/index.ts:3704-3707
if (final) {
  if (this.c) err(13);
  this.p = null;
}
```

---

## 3. 目标用户与使用价值

- **直接用户**：在浏览器里做"上传前先解压"的工具（在线解压站、CI 产物预览、PWA 离线包）、Node 里需要零原生依赖做 ZIP 的服务端脚本。
- **间接用户**：任何下载完 ZIP 想确认"文件没坏"的人——这是本项目的用户。
- fflate 的真实优势是**体积与速度**（UMD 32.3 KB，本机 2,000 条目 2.6 MB 包 `unzipSync` 24.4 ms），不是容器健壮性。它的 README 用一整张表对比 pako/UZIP，但表里没有"完整性校验"这一行。

---

## 4. 现存问题（按证据强度排序）

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 1 | 读取不校验 CRC-32 | `src/index.ts:3839-3851` 全文无 `crc` 调用 | stored 条目损坏时**静默返回错数据**（实测 15,000 字节中 1 字节不同，无异常） |
| 2 | ZIP 路径零测试 | `test/3-zip.ts` 仅一行 TODO | 上述缺陷不会被上游 CI 发现 |
| 3 | 索引损坏即全损 | `:3824` `err(13)`；`:3705` `err(13)` | 截断/覆盖 EOCD 后连"还能救几条"都不知道 |
| 4 | 错误信息不可定位 | `:210-212` 错误码表 | 只拿到 `invalid zip data`，无法区分"索引坏了"与"第 7 条数据坏了" |
| 5 | 同名条目静默覆盖 | `:3848-3849` `files[fn] =` | 恶意构造的同名条目可让审计者看到 A、解压者拿到 B |
| 6 | `__proto__` 条目被丢弃 | 上游 issue [#307](https://github.com/101arrowz/fflate/issues/307)（2026-10-21，open，0 评论） | 归档内容与源目录不一致 |
| 7 | 不支持 >65,535 条目 | 上游 issue [#229](https://github.com/101arrowz/fflate/issues/229)（2025-01-27，open） | 大数据集 ZIP64 写出错 |
| 8 | 特定 ZIP 解不出 | issue [#208](https://github.com/101arrowz/fflate/issues/208)（2024-02-12，open，12 评论）、[#243](https://github.com/101arrowz/fflate/issues/243)（2025-09-22，open） | 用户拿不到可行动的信息 |

> 说明：#1/#2 是**本项目自己核实的**（源码 + 空测试 + 实测输出）。#6/#7/#8 是**上游已公开承认的**，本项目不声称"发现"。

---

## 5. 许可与复用边界

- fflate：MIT，`LICENSE` 为完整 20 行 MIT 原文，版权行 `Copyright (c) 2026 Arjun Barrett`。
- MIT 允许在保留版权与许可声明的前提下**修改、分发、再许可**。本项目**不修改 fflate 源码**，只以依赖方式调用其 `inflateSync` / `deflateSync` / `Inflate`，因此：
  - 不需要 fork，不产生"衍生作品"的源码混合；
  - 容器层（解析/审计/打捞/写包）全部为本项目原创，采用 MIT；
  - 归属声明写在 `NOTICE`，`LICENSE` 保持纯 MIT 原文（GitHub 才能识别）。
- 若将来需要修改 fflate 内部实现，必须 fork 并在 `NOTICE` 中注明改动范围——本次刻意不做。

---

## 6. 复核命令

```bash
npm ci
node scripts/baseline-upstream.js   # 6 个用例，输出 docs/BASELINE.json
node bench/bench.js                 # 吞吐与打捞成本，输出 docs/MEASUREMENTS.json
node --test test/*.test.js          # 72 项
```
