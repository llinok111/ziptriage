# ziptriage

**ZIP 容器级完整性审计与打捞工具。** 逐条校验 CRC-32、交叉比对中央目录与本地文件头、在索引被破坏后按本地头重建归档。

解码内核来自 [fflate](https://github.com/101arrowz/fflate)（MIT）；容器层（解析 / 审计 / 打捞 / 重写）为本项目原创（MIT）。

```
✓ 干净    exit 0     warnings    exit 3     损坏    exit 4    不可读    exit 5
```

## 为什么需要它

`fflate` 的 ZIP 读取路径只信中央目录，**不比较 CRC**（`src/index.ts:3839-3851`），
而且它的 ZIP 测试文件只有一行 `// TODO: test ZIP`。实测：

| 输入 | `fflate.unzipSync` | `ziptriage` |
|---|---|---|
| stored 条目翻转 1 bit | 返回 15,000 字节、**无异常**、其中 1 字节不同 | `crc-mismatch`，exit 4 |
| 中央目录被抹掉 | 抛 `code=14 unknown compression type 65535` | 报告 `cd-signature-invalid`，并救回 3/3 条 |
| 尾部截断 60 字节 | 抛 `code=13 invalid zip data` | 报告 `eocd-missing`，并救回 3/3 条 |
| 两个同名条目 | 只剩后者（`SECOND`） | 两条都列出 + `duplicate-name` 告警 |

对照参考实现：同一批损坏包，Python `zipfile.testzip()` 返回 `img.dat`，`read()` 抛 `BadZipFile: Bad CRC-32`。
完整证据与行号见 [`docs/UPSTREAM.md`](docs/UPSTREAM.md)，数据见 [`docs/BASELINE.json`](docs/BASELINE.json)。

### 与同类库的分工（不夸大）

- **adm-zip 已经校验 CRC**（`zipEntry.js:40`），但校验失败只能抛异常，且索引坏了整个包直接不可用。
- **yauzl 明确声明不校验 CRC**（README「No CRC-32 Checking」），且完全依赖中央目录。
- 本项目不声称"首创 CRC 校验"。它补的是三件没人做的事：**分级诊断（不是抛异常）**、**索引损坏后的打捞**、**同一套代码在浏览器与 Node 完全同构**。

## 安装与运行

需要 Node ≥ 18。

```bash
npm ci                      # 只装 fflate 一个运行时依赖

# 审计
node bin/ziptriage.js audit path/to/file.zip
node bin/ziptriage.js audit file.zip --json > report.json
cat file.zip | node bin/ziptriage.js audit - --json

# 打捞
node bin/ziptriage.js salvage broken.zip -o repaired.zip
node bin/ziptriage.js salvage broken.zip --extract ./out/     # 同时落盘，路径会被净化
```

作为库：

```js
import { readFileSync } from 'node:fs';
import { audit, salvage } from 'ziptriage';

const report = audit(readFileSync('x.zip'));
console.log(report.summary.verdict, report.summary.exitCode);

const { archive, summary } = salvage(readFileSync('broken.zip'));
if (archive) writeFileSync('repaired.zip', archive);
```

浏览器（无需打包器，无网络请求）：

```bash
node scripts/build-demo.js     # 复制 fflate UMD 到 demo/vendor
node scripts/serve-demo.js     # http://127.0.0.1:4173/demo/
```

## 命令与退出码

| 退出码 | 含义 | 触发条件 |
|---:|---|---|
| 0 | clean | 无任何发现 |
| 2 | 用法错误 | 参数缺失 / 未知选项 / 文件不存在 |
| 3 | warnings | 仅有告警：无法验证、同名、膨胀比、解压预算等 |
| 4 | corrupt | 存在 error/critical：CRC 不符、结构矛盾、数据截断 |
| 5 | unreadable / 无法打捞 | 索引缺失且无条目可恢复，或 salvage 一条都没救回 |

`audit` 选项：`--json` `--report <path>` `--no-crc` `--max-entry-mb` `--max-total-mb` `--max-ratio` `--limit` `--no-color`。
`salvage` 选项：`-o/--out` `--extract <dir>` `--json`。

## 检查项

| 代码 | 级别 | 说明 |
|---|---|---|
| `eocd-missing` | critical | 找不到中央目录结束记录（截断 / 被覆盖） |
| `cd-signature-invalid` / `cd-truncated` / `cd-offset-out-of-range` | critical | 中央目录不可读 |
| `zip64-locator-dangling` | error | ZIP64 定位器指向无效位置 |
| `local-header-missing` | error | 中央目录记录的偏移处没有本地文件头 |
| `local-name-mismatch` / `local-method-mismatch` | error | 两条记录对同一个条目的说法不一致 |
| `local-crc-mismatch` / `local-size-mismatch` | warning | 本地头与中央目录字段不一致 |
| `crc-mismatch` | error | 解出的字节与头部 CRC 不符（**唯一能抓到"合法但错误"数据的检查**） |
| `size-mismatch` | warning | 实际解压长度与声明不同 |
| `data-out-of-range` | error | 条目数据超出文件末尾 |
| `deflate-error` | error | deflate 流无法解出 |
| `unsupported-method` / `encrypted-entry` | warning | 无法验证（不冒充"通过"） |
| `duplicate-name` | warning | 同名条目；普通对象映射会静默丢掉一条 |
| `unsafe-path` / `name-contains-nul` | error / critical | 可逃出解压根目录的名称 |
| `unsafe-name` | warning | `__proto__` / `constructor` / `prototype` |
| `expansion-limit` | critical | 声明解压尺寸或整包预算超限（拒绝解码，不分配） |
| `expansion-ratio` | warning | 膨胀比超过阈值 |
| `prefix-stub` / `offset-shift` | info / warning | 自解压包：索引偏移含前置存根，条目偏移不含 |
| `scan-recoverable` | info | 索引坏了，但顺序扫描能救回 N 条 |

级别只影响退出码与排序；**每一项都带条目序号**，报告可直接进 CI 日志。

## 设计约束（刻意不做的事）

1. **不改 fflate 源码**。只调用 `inflateSync` / `deflateSync` / `Inflate`，升级上游不需要解冲突。
2. **不自动"修复"数据**。CRC 不符的条目不会被悄悄改写成"看起来正常"；它被标为 `partial` 并写明原因。
3. **不猜密码**。加密条目一律 `unverifiable`。
4. **不做 GUI 框架**。demo 是原生 ESM + 一个 `<script>`，没有构建步骤。
5. **不用第三方解析库**。ZIP 结构解析、CRC-32、写包全部自己实现，才能控制限额与错误粒度。

## 测试

```bash
node --test test/*.test.js     # 72 项：CRC / 解析 / 审计 / 打捞 / 写包 / CLI / Python 交叉验证
node scripts/baseline-upstream.js
node bench/bench.js
```

- 交叉验证用 **Python `zipfile`** 作为独立参考实现（`test/interop.test.js`）；没有解释器时该套件 **skip 而不是 pass**。
- 本机实测（2,000 条 × 8 KiB 语料，5 次取中位数）：审计吞吐约 **20,000 条/秒**、**28–30 MB/s**；
  相对 `unzipSync` 的耗时比约 **3.4×**，其中结构交叉比对只占约 17%，其余是 CRC 计算。
  同一台机器上重复运行会在 **19,900–24,000 条/秒** 之间浮动，所以 README 只写量级，精确数字见
  [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md)（结论只从比值下，绝对值随负载漂移）。

## 已知限制

- 只解 `stored`(0) 与 `deflate`(8)；bzip2/LZMA/zstd/AES 条目报 `unsupported-method`，不尝试解码。
- ZIP64 支持到"读取已存在的 ZIP64 记录"级别；**写出的修复包固定为 32 位 ZIP**，>4 GB 或 >65,535 条的修复包会失败（明确报错，不静默降级）。
- 加密条目（传统 ZipCrypto / AES）不解析内容。
- 流式解压的"部分恢复"以 deflate 块为粒度：损坏块之前的完整块能救回，块内字节无法还原。
- 上游 `npm test` 在本机跑不完（需要从 `raw.githubusercontent.com` 下载 fixture，本机 443 超时），因此基线改用直接调用其公开 API 的 6 个用例。
- 尚未发布到 npm；未提供 TypeScript 类型声明（JSDoc 已覆盖公共 API）。

## 许可

- 本项目：MIT，见 [`LICENSE`](LICENSE)。
- 上游 fflate：MIT，版权归 Arjun Barrett，见 [`NOTICE`](NOTICE) 与 `node_modules/fflate/LICENSE`。
- `demo/vendor/fflate.umd.js` 是上游构建产物原样拷贝，未做任何修改。
