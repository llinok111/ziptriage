#!/usr/bin/env node
/**
 * ziptriage CLI — audit a ZIP before you trust it, salvage it when it is broken.
 * Exit codes: 0 clean · 2 usage error · 3 warnings · 4 corruption · 5 unreadable
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, basename, dirname } from 'node:path';
import { audit, salvage, formatAudit, formatSalvage, VERSION } from '../src/index.js';
import { safeName } from '../src/core/salvage.js';

const HELP = `ziptriage ${VERSION} — ZIP 容器级完整性审计与打捞

用法:
  ziptriage audit <file.zip|-> [选项]
  ziptriage salvage <file.zip> [-o out.zip] [选项]

audit 选项:
  --json                输出机器可读报告（确定性，无时间戳）
  --report <path>       同时把 JSON 报告写入文件
  --no-crc              跳过 CRC 校验（只做结构交叉比对）
  --max-entry-mb <n>    单条目录声明的解压上限（默认 256）
  --max-total-mb <n>    整包解压预算（默认 1024）
  --max-ratio <n>       解压膨胀比告警阈值（默认 500）
  --limit <n>           文本报告最多列出的条目数（默认 200）
  --no-color            关闭 ANSI 颜色

salvage 选项:
  -o, --out <path>      修复包输出路径（默认 <name>.repaired.zip）
  --extract <dir>       同时把恢复出的文件写到目录
  --json                输出机器可读结果
  --no-color            关闭 ANSI 颜色

通用:
  -h, --help            显示帮助
  -v, --version         显示版本

退出码: 0 干净 · 2 参数错误 · 3 有告警 · 4 有损坏 · 5 完全不可读`;

function fail(msg) {
  process.stderr.write(`ziptriage: ${msg}\n\n${HELP}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--no-color': opts.color = false; break;
      case '--no-crc': opts.verifyCrc = false; break;
      case '--report': opts.report = argv[++i]; if (!opts.report) fail('--report 需要路径'); break;
      case '--max-entry-mb': opts.maxEntryBytes = Number(argv[++i]) * 1024 * 1024; if (!Number.isFinite(opts.maxEntryBytes)) fail('--max-entry-mb 需要数字'); break;
      case '--max-total-mb': opts.maxTotalBytes = Number(argv[++i]) * 1024 * 1024; if (!Number.isFinite(opts.maxTotalBytes)) fail('--max-total-mb 需要数字'); break;
      case '--max-ratio': opts.maxRatio = Number(argv[++i]); if (!Number.isFinite(opts.maxRatio)) fail('--max-ratio 需要数字'); break;
      case '--limit': opts.limit = Number(argv[++i]); if (!Number.isFinite(opts.limit)) fail('--limit 需要数字'); break;
      case '-o': case '--out': opts.out = argv[++i]; if (!opts.out) fail('--out 需要路径'); break;
      case '--extract': opts.extract = argv[++i]; if (!opts.extract) fail('--extract 需要目录'); break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a.startsWith('-') && a !== '-') fail(`未知选项 ${a}`);
        opts._.push(a);
    }
  }
  return opts;
}

function readInput(target) {
  if (target === '-') {
    const chunks = [];
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (!n) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks);
  }
  const path = resolve(target);
  if (!existsSync(path)) fail(`文件不存在: ${path}`);
  if (!statSync(path).isFile()) fail(`不是文件: ${path}`);
  return readFileSync(path);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) fail('缺少子命令');
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const [command, target] = opts._;
  if (!command) fail('缺少子命令');
  if (!target) fail(`${command} 需要一个文件参数`);
  if (command !== 'audit' && command !== 'salvage') fail(`未知子命令 ${command}`);

  const buf = readInput(target);
  const color = opts.color !== false && process.stdout.isTTY;
  const name = target === '-' ? 'stdin' : basename(target);
  const limits = {
    verifyCrc: opts.verifyCrc !== false,
    maxEntryBytes: opts.maxEntryBytes,
    maxTotalBytes: opts.maxTotalBytes,
    maxRatio: opts.maxRatio,
  };

  if (command === 'audit') {
    const report = audit(buf, { ...limits, name });
    report.file.sha256 = sha256(buf);
    if (opts.report) {
      writeFileSync(resolve(opts.report), `${JSON.stringify(report, null, 2)}\n`);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatAudit(report, { color, maxEntries: opts.limit })}\n`);
    }
    process.exitCode = report.summary.exitCode;
    return;
  }

  const result = salvage(buf, { ...limits, name });
  const outPath = resolve(opts.out || `${target.replace(/\.zip$/i, '')}.repaired.zip`);
  if (result.archive) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.archive);
    result.output = outPath;
    result.file = { name, size: buf.length, sha256: sha256(buf) };
  }
  if (opts.extract) {
    const dir = resolve(opts.extract);
    mkdirSync(dir, { recursive: true });
    const used = new Set();
    const written = [];
    for (const f of result.files) {
      const rel = safeName(f.name, used);
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
      written.push(rel);
    }
    result.extracted = { dir, files: written.length };
  }
  if (opts.json) {
    const { archive, files, recovered, ...rest } = result;
    process.stdout.write(
      `${JSON.stringify(
        {
          ...rest,
          recovered: recovered.map(({ data, ...r }) => r),
          files: files.map((f) => ({ name: f.name, bytes: f.data.length })),
          output: result.output || null,
          bytes: archive ? archive.length : 0,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatSalvage(result, { color })}\n`);
    if (result.output) process.stdout.write(`\nwritten: ${result.output}${result.extracted ? ` (+ ${result.extracted.files} files in ${result.extracted.dir})` : ''}\n`);
  }
  const s = result.summary;
  process.exitCode = s.recovered === 0 ? 5 : s.partial > 0 || s.dropped > 0 ? 3 : 0;}

main();
