/**
 * CRLF 安全的批量替换器。
 *
 * 为什么要有它：本仓库大部分文件是 CRLF，而拿多行文本去直接比对时，
 * 换行符不一致会让整段匹配**静默失败**（不报错，只说没找到），
 * 于是人以为改了，实际一个字没动。做法：读入时把 \r\n 归一成 \n 比对，
 * 写回时按原本的行尾还原。
 *
 * 再有一条：**每条替换必须恰好命中一次**。命中 0 次说明锚点已经漂了，
 * 命中 2 次说明这条替换会改到不该改的地方 —— 两种都不许含糊过去，
 * 脚本会原样退出、一个字不写。宁可人去重挑锚点，也不要一个改动落了一半。
 *
 * 用法：node scripts/apply-patch.mjs <spec.json>
 *
 * spec 两种写法：
 *   1. 单文件：{ "file": "src/styles.css", "pairs": [["旧", "新"], ...] }
 *   2. 多文件：{ "edits": [{ "file": "...", "pairs": [...] }, ...] }
 */
import { readFileSync, writeFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const edits = spec.edits ?? [spec];

let touched = 0;
let failed = false;

for (const { file, pairs } of edits) {
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  const misses = [];

  for (const [from, to] of pairs) {
    const n = text.split(from).length - 1;
    if (n !== 1) {
      misses.push({ snippet: from.slice(0, 64), count: n });
      continue;
    }
    text = text.replace(from, to);
  }

  if (misses.length) {
    for (const m of misses) console.error(`✗ ${file}：命中 ${m.count} 次 —— ${JSON.stringify(m.snippet)}`);
    failed = true;
    continue;
  }

  writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`✓ ${file}：${pairs.length} 条（${crlf ? 'CRLF' : 'LF'}）`);
  touched += 1;
}

if (failed) {
  console.error('\n有改动没落下去，其余文件也没写（保持整体一致）');
  process.exit(1);
}
console.log(`\n共 ${touched} 个文件`);
