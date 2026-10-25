# 验收记录（第五阶段）

> 口径：`executed / skipped / failed` 三段分开，**跳过不计入通过**。
> 复现：`node scripts/verify-all.js`（Node 侧）+ `node verify/browser/demo-verify.cjs`（真机浏览器）。

## 1. Node 侧总闸（2026-10-25 最后一次运行）

```
ziptriage acceptance

  ok   test suite (node --test) (1479 ms) — 72 pass / 0 fail / 0 skipped
  ok   upstream baseline reproducible (113 ms) — 6 cases, byte-identical to previous run
  ok   demo assets present and offline (1 ms) — 32.3 KB vendored
  ok   CLI end-to-end on a broken archive (176 ms) — audit=5 → salvage=0 → re-audit=clean, 2/2 entries
  ok   library API contract (1 ms) — clean=0, damaged=corrupt with crc.ok=false
  ok   salvage is deterministic (2 ms) — 203 bytes, identical across runs
  ok   python zipfile interop (264 ms) — python flags the damage; python accepts the repair
  ok   benchmark produces numbers (2809 ms) — 22504 entries/s, 28.7 MB/s, salvage 185.4 ms
  ok   licence and provenance files (1 ms) — MIT text clean, upstream attributed with version + copyright
  ok   package metadata matches the code (87 ms) — ziptriage@0.1.0, 10 packaged paths, bin+main resolve
  ok   README claims match measurements (1498 ms) — claims 20000/s vs measured 22504; ratio & test count agree (72)

executed 11 · skipped 0 · failed 0 (of 11)

RESULT: PASS
```

### 检查脚本本身也出过一次假绿（留档）

第一版的"README 数字与实测一致"用了 `/\B(?=(\d3})+(?!\d))/g`（正则写错）加 `includes('24,000')`，
实测已是 21,891 却照样 PASS。修正为"解析 README 所有 `N 条/秒` 声明并落在实测 ±20% 内"后，
该项立刻 FAIL，随后把 README 改成量级表述才通过。**验收脚本出错比被测代码出错更危险**，这类假绿必须在报告里承认。

## 2. 真机浏览器验收（Edge 152，Playwright 驱动）

`node verify/browser/demo-verify.cjs`，17 项断言全部读出**实时 DOM 状态**，不是"看起来对"：

```
PASS  page loads and auto-runs a sample :: verdict=CLEAN
PASS  codec reported as ready :: fflate umd · codec ready
PASS  no external network requests :: none
PASS  sample "healthy" -> CLEAN
PASS  sample "bitflip" -> CORRUPT
PASS  sample "truncated" -> UNREADABLE
PASS  sample "destroyed" -> UNREADABLE
PASS  bitflip shows a damaged row with mismatching CRC :: ✗ 损坏 | assets/photo.dat | stored | 5.9 KB | 5.9 KB | ✗ 8833a90c ≠ 9d811b8a
PASS  salvage reports recovered entries :: 恢复 3 条（11.3 KB）· 完整 3 / 部分 0 · 放弃 0
PASS  salvage self-check is clean :: 修复包自检：3 条 · CLEAN · 410 B
PASS  download link present :: blob:http://127.0.0.1:... 
PASS  repaired archive downloaded
PASS  downloaded repair re-audits CLEAN in the browser
PASS  truncated sample offers a recovery hint :: eocd-missing ×1 … / scan-recoverable
PASS  JSON report export triggers a download :: sample-truncated.report.json
PASS  no uncaught page errors :: none
PASS  no console errors :: none

executed 17 · passed 17 · failed 0
```

关键路径是**闭环**：页面生成损坏包 → 审计 → 打捞 → 下载修复包 → 把下载的文件重新灌回页面 → 判为 CLEAN。

### 浏览器验收抓到两个真实缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 打捞报告"完整 2 / 部分 1"，但三条都完好 | `scan.js` 用 `compressedSize > 0` 判断"尺寸可信"，空文件（0 字节）被当成"尺寸未知" → 不做 CRC 判定 → 降级 partial | 改为 `!usesDescriptor` 即视为可信；补回归测试 `zero-byte entries … verified, not partial` |
| 2 | 截断包看不到"可扫描恢复"的提示 | 该提示是 `info` 级，前端把 `info` 全过滤了 | 前端改为全部展示（按 code 分组控噪），并让"最可行动的那条"不再被级别过滤掉 |

两个缺陷都**只在实际渲染路径上暴露**，单元测试与 CLI 都不会发现。

### 截图统计（本机读图工具收不到图像，改自解码 PNG 统计）

| 图 | 尺寸 | 去重色数 | 平均亮度 | 四段分带标准差 | 判定 |
|---|---|---:|---:|---|---|
| page-healthy.png | 1280×900 | 297 | 8.2 | 18.9 / 20.7 / 23.8 / 13.7 | OK |
| sample-bitflip.png | 1280×900 | 350 | 9.3 | 19.0 / 21.1 / 27.7 / 14.2 | OK |
| salvage-result.png | 1280×900 | 324 | 10.4 | 18.8 / 21.2 / 27.3 / 15.4 | OK |

四条阈值（尺寸 ≥1200×600、去重色数 ≥200、亮度 5–250、四段 stdev >2）同时满足，可排除空帧 / 白屏 / 半渲染。
平均亮度低是因为深色主题，属预期。

**必须说明的限度**：上述统计能证明"画面有内容且分区都有内容"，**不能证明排版美观、无遮挡、文案无误**。
由于本机读图能力不可用，这两类问题只能靠 DOM 断言（列宽/文本）间接覆盖，未做人工视检。

## 3. 独立启动验证

| 路径 | 结果 |
|---|---|
| 干净 clone 后 `npm ci` + `node --test test/*.test.js` | 72 pass / 0 fail |
| `npm pack` → 空目录 `npm i <tgz>` → `import('ziptriage')` | `audit/salvage/formatAudit` 均为 function；`audit()` 返回 `clean/1` |
| 安装后执行 `node_modules/.bin/ziptriage --version` | `0.1.0` |
| 包体 | 70,667 字节；依赖仅 fflate |
| `node scripts/serve-demo.js` → `http://127.0.0.1:4173/demo/` | 页面自跑样例，0 外部请求 |

## 4. 未验证 / 明确限制

| 项 | 状态 | 原因 |
|---|---|---|
| 上游 `npm test` 全套 | **未完成** | 需从 `raw.githubusercontent.com` 下载 fixture，本机 `ETIMEDOUT 185.199.108.133:443`。改用直接调用其公开 API 的 6 个用例做基线 |
| 人工视检（排版/遮挡/文案） | **未做** | 本机读图工具无法返回图像；只有像素统计 + DOM 断言 |
| Linux / macOS | **未运行** | 本次仅 Windows x64 + Edge。CI 矩阵已写好但未在真机跑过 |
| >4 GB 或 >65,535 条 | **不支持** | 修复包固定 32 位 ZIP，超限明确报错 |
| bzip2 / LZMA / zstd / AES | **不解码** | 报 `unsupported-method` / `encrypted-entry`，不冒充通过 |
| npm publish | **未做** | 无授权，不占用 registry 名 |
