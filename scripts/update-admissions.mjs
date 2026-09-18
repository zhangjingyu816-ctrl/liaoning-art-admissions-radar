import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

setDefaultResultOrder('ipv4first');

const root = resolve(import.meta.dirname, '..');
const sourcesPath = resolve(root, 'config/sources.json');
const noticesPath = resolve(root, 'dist/data/notices.json');
const statusPath = resolve(root, 'dist/data/status.json');
const cutoff = '2026-07-01';

const topicWords = [
  '美术与设计', '美术类', '美术学', '绘画', '中国画', '雕塑', '视觉传达', '环境设计',
  '产品设计', '数字媒体艺术', '工艺美术', '服装与服饰设计', '公共艺术', '摄影', '动画',
  '戏剧影视美术设计', '陶瓷艺术设计', '艺术与科技', '新媒体艺术', '包装设计', '设计学类'
];
const admissionWords = ['招生', '录取', '校考', '统考', '考试', '简章', '分数线'];
const excludedOnlyWords = ['音乐类', '舞蹈类', '播音与主持', '表演专业', '戏剧影视导演', '书法类'];
const excludedNoticePattern = /(研究生|硕士|博士|第二学士|入学复查|专业复查|录取通知书|理论类|本科生招生$|本科招生$)/;
const entityMap = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value = '') {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, code) => {
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x';
      return String.fromCodePoint(Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return entityMap[code.toLowerCase()] ?? _;
  });
}

function plainText(html = '') {
  return decodeEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(base, href = '') {
  try {
    const url = new URL(decodeEntities(href), base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function parseDate(value = '') {
  const normalized = value.replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, ' ');
  const full = normalized.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  const compact = value.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
}

function parsePublishDate(value = '') {
  const labelled = value.match(/(?:发布日期|发布时间|发布日|时间|更新日期)\s*[：:]?\s*((?:20\d{2})[年/.\-]\d{1,2}[月/.\-]\d{1,2}日?)/);
  return parseDate(labelled?.[1] || value);
}

function parseAnchors(html, baseUrl) {
  const anchors = [];
  const regex = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const url = normalizeUrl(baseUrl, match[2]);
    const title = plainText(match[4]);
    if (!url || !title || title.length < 4) continue;
    const context = plainText(html.slice(Math.max(0, match.index - 150), regex.lastIndex + 150));
    anchors.push({ url, title, date: parseDate(`${context} ${url}`) });
  }
  return anchors;
}

async function fetchText(url) {
  const candidates = [url];
  if (url.startsWith('https://')) candidates.push(url.replace(/^https:/, 'http:'));
  let response;
  let lastError;
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(candidate, {
          redirect: 'follow',
          signal: AbortSignal.timeout(25000),
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; LiaoningArtAdmissionsRadar/1.0; +https://github.com/zhangjingyu816-ctrl/liaoning-art-admissions-radar)',
            accept: 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
          }
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (response) break;
  }
  if (!response) throw lastError || new Error('network request failed');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) return '';
  const bytes = await response.arrayBuffer();
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, '') || 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function isCandidate(title, source) {
  if (excludedNoticePattern.test(title)) return false;
  const hasAdmission = admissionWords.some(word => title.includes(word));
  const hasTopic = topicWords.some(word => title.includes(word));
  const artFocusedGeneral = source.artFocused && hasAdmission && /(2026|2027|本科|艺术类)/.test(title);
  const artPolicy = /艺术类.*(?:招生|录取方式|录取|专业)/.test(title);
  return artFocusedGeneral || artPolicy || (hasAdmission && (hasTopic || /(美术|设计|绘画|校考|统考)/.test(title)));
}

function isRelevant(title, body, source) {
  if (excludedNoticePattern.test(title)) return false;
  const combined = `${title} ${body}`;
  const hasTopic = topicWords.some(word => combined.includes(word));
  const hasAdmission = admissionWords.some(word => combined.includes(word));
  const excludedOnly = excludedOnlyWords.some(word => title.includes(word)) && !topicWords.some(word => title.includes(word));
  return !excludedOnly && hasAdmission && (hasTopic || source.artFocused);
}

function classifyType(text) {
  if (/(录取方式|招生方式|调整|改革|校考.*统考|统考.*校考|暂停招生)/.test(text)) return 'policy';
  if (/(分数线|录取名单|录取情况|录取结果|最低分)/.test(text)) return 'score';
  return 'notice';
}

function classifyScope(text) {
  if (text.includes('辽宁')) return 'liaoning';
  if (/(面向全国|全国招生|不编制分省|各省|招生录取方式)/.test(text)) return 'national';
  return 'pending';
}

function extractMajors(text) {
  const found = topicWords.filter(word => text.includes(word));
  return [...new Set(found)].slice(0, 12);
}

function fingerprint(record) {
  return createHash('sha256').update(`${record.school}|${record.url}`).digest('hex').slice(0, 20);
}

function makeSummary(scope, majors) {
  const subject = majors.length ? `页面涉及：${majors.join('、')}` : '页面涉及美术与设计类招生信息';
  const scopeText = scope === 'liaoning' ? '正文提及辽宁' : scope === 'national' ? '内容属于全国性信息' : '辽宁适用范围待复核';
  return `${subject}；${scopeText}。本条由规则自动发现，请以官方原文为准。`;
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function scanSource(source) {
  const html = await fetchText(source.url);
  const candidates = parseAnchors(html, source.url)
    .filter(item => isCandidate(item.title, source))
    .filter((item, index, all) => all.findIndex(other => other.url === item.url) === index)
    .slice(0, source.maxLinks || 20);

  const records = [];
  for (const candidate of candidates) {
    let detail = '';
    try {
      detail = plainText(await fetchText(candidate.url));
    } catch {
      detail = '';
    }
    const evidence = `${candidate.title} ${detail.slice(0, 30000)}`;
    if (!isRelevant(candidate.title, evidence, source)) continue;
    const date = parsePublishDate(detail.slice(0, 8000)) || parseDate(candidate.title) || candidate.date;
    if (!date || date < cutoff) continue;
    const majors = extractMajors(evidence);
    const scope = classifyScope(evidence);
    const record = {
      date,
      school: source.school,
      type: classifyType(candidate.title) === 'notice' ? classifyType(evidence) : classifyType(candidate.title),
      scope,
      important: false,
      title: candidate.title,
      summary: makeSummary(scope, majors),
      majors: majors.length ? majors : ['美术与设计类'],
      url: candidate.url,
      source: source.source,
      verified: false,
      automated: true
    };
    record.id = fingerprint(record);
    records.push(record);
  }
  return records;
}

async function main() {
  const sources = (await loadJson(sourcesPath, [])).filter(source => source.enabled !== false && source.url);
  const previous = await loadJson(noticesPath, { records: [] });
  const previousRecords = previous.records || [];
  const byUrl = new Map(previousRecords.filter(record => record.automated !== true).map(record => [record.url, record]));
  const previousAutomatedBySchool = new Map();
  previousRecords.filter(record => record.automated === true).forEach(record => {
    if (!previousAutomatedBySchool.has(record.school)) previousAutomatedBySchool.set(record.school, []);
    previousAutomatedBySchool.get(record.school).push(record);
  });
  const results = [];

  for (const source of sources) {
    try {
      const found = await scanSource(source);
      found.forEach(record => byUrl.set(record.url, { ...byUrl.get(record.url), ...record }));
      results.push({ school: source.school, ok: true, found: found.length });
      console.log(`OK  ${source.school}: ${found.length}`);
    } catch (error) {
      const preserved = previousAutomatedBySchool.get(source.school) || [];
      preserved.forEach(record => byUrl.set(record.url, record));
      const detail = [error.message, error.cause?.code, error.cause?.message].filter(Boolean).join(' · ');
      results.push({ school: source.school, ok: false, error: detail, preserved: preserved.length });
      console.error(`ERR ${source.school}: ${detail}`);
    }
  }

  const records = [...byUrl.values()]
    .filter(record => record.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date) || a.school.localeCompare(b.school, 'zh-CN'));
  const updatedAt = new Date().toISOString();
  await mkdir(dirname(noticesPath), { recursive: true });
  await writeFile(noticesPath, `${JSON.stringify({ updatedAt, cutoff, records }, null, 2)}\n`, 'utf8');
  await writeFile(statusPath, `${JSON.stringify({
    updatedAt,
    cutoff,
    configuredSources: sources.length,
    successfulSources: results.filter(result => result.ok).length,
    failedSources: results.filter(result => !result.ok).length,
    discoveredRecords: records.length,
    results
  }, null, 2)}\n`, 'utf8');
}

await main();

