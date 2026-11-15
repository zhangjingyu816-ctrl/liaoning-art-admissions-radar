import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SEASON = 2027
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_NOTICE_DOCUMENTS = 8
const MAX_SUPPLEMENTS_PER_SCAN = 40
const RADAR_FEED = 'https://raw.githubusercontent.com/zhangjingyu816-ctrl/liaoning-art-admissions-radar/main/dist/data/feed.json'
const ZHEJIANG_HOST = 'zsw.cuz.edu.cn'
const ZHEJIANG_CATEGORIES = [
  'e8659322e16240d296178402510b34f2', // 通知公告
  '4c5e94d3b4c74098bfc6bfc5f1c7c785', // 招生资讯
  '40249c45486b4db5b8027f3b6af55849' // 报名须知
]
const EXCLUDED_TITLE = /研究生|硕士|博士|国际学生|留学生|留学预科|港澳台|港澳|澳门保送|香港中学|台湾学测|预科招生|成人高考|继续教育|专升本|高职|省际联考|艺术团|高水平运动队|第二学士|辅修|培训班|招生咨询会|入学复查|成绩复核/
const NOTICE_TITLE = /校考|艺术类.*(?:招生|考试)|本科.*(?:招生简章|初试|复试|三试|终试|考试说明)/
const SCHEDULE_TITLE = /招生简章|报名(?:时间|须知|通知|安排|公告)|(?:初试|复试|三试|终试|校考|现场考试|线上考试|网络考试).{0,12}(?:时间|须知|通知|安排|公告)/
const UPDATE_TITLE = /(?:更正|补充|改期|延期|调整|取消).{0,18}(?:报名|考试|初试|复试|三试|终试)|(?:报名|考试|初试|复试|三试|终试).{0,18}(?:更正|补充|改期|延期|调整|取消)/
const FATAL_CONTEXT = /往年|去年|曾于|原定|样例|示例|模拟|测试账号|模考|考前练习|准考证打印|公布成绩|成绩查询|查询结果|统考时间|省统考报名|延长报名至|暂定|待定|拟于|拟定|仅限|限报|特殊考生|补报名|港澳|台湾|华侨|留学生|国际学生|省际联考|咨询会/
const YEAR = '(20\\d{2})\\s*年'
const DAY = '(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日'
const CLOCK = '(?:\\s*(\\d{1,2}:\\d{2})(?::\\d{2})?)?'
const FIRST = YEAR + '\\s*' + DAY + CLOCK
const LAST = '(?:' + YEAR + '\\s*)?(?:(\\d{1,2})\\s*月\\s*)?(\\d{1,2})\\s*日' + CLOCK
const DATE_SLOT = new RegExp('^' + FIRST + '(?:\\s*(?:至|到|[-–—~～])\\s*(?:' + LAST + '|(\\d{1,2}:\\d{2})(?::\\d{2})?))?')
const DETAIL_LABEL = /^(?:(?:更正后|调整后|延期后|新的|现行)\s*)?((?:(?:校考|本科|专业|网上|线上|网络|线下|现场|远程|统一|初试|复试|三试|终试)\s*){0,4}(?:报名(?:(?:及|和|、|,)\s*缴费)?|(?:初试|复试|三试|终试)(?:考试)?|考试))\s*(?:起止)?\s*(?:日期|时间|时段)\s*[:：]?\s*/
const CONFIRMED_RANGE_NOTE = /^[,，；;]?\s*(具体(?:考试)?(?:场次(?:和|与|及)?时间|场次|时间)(?:详见|以)准考证(?:为准)?)[。.]?$/

class OutsideCalendarScope extends Error {}
class UnsafeNoticeLink extends Error {}

function decodeHtml(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' }
  return value.replace(/&(#[xX][\da-fA-F]+|#\d+|\w+);/g, (whole, entity) => {
    if (entities[entity]) return entities[entity]
    if (!entity.startsWith('#')) return whole
    const hex = entity[1].toLowerCase() === 'x'
    const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return number > 0 && number <= 0x10FFFF ? String.fromCodePoint(number) : whole
  })
}

function htmlText(html) {
  return decodeHtml(html
    .replace(/<!--[\s\S]*?-->|<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|tr|h[1-6]|li|section|article|dd)\s*>/gi, '\n')
    .replace(/<\/(?:td|th|dt)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
}

function dateKey(year, month, day) {
  const key = [String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-')
  const date = new Date(key + 'T00:00:00Z')
  if (Number.isNaN(+date) || date.toISOString().slice(0, 10) !== key) return ''
  return key
}

function inScheduleSeason(date) {
  return date >= '2026-10-01' && date <= '2027-08-31'
}

function normalizedClock(value) {
  if (!value) return ''
  const [hour, minute] = value.split(':').map(Number)
  if (hour > 23 || minute > 59) return null
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
}

function parseDateSlot(value) {
  const match = value.match(DATE_SLOT)
  if (!match) return null
  const [, year, month, day, startClock, endYear, endMonth, endDay, endClock, sameDayEndClock] = match
  const start = dateKey(year, month, day)
  const end = endDay ? dateKey(endYear || year, endMonth || month, endDay) : start
  const from = normalizedClock(startClock)
  const to = normalizedClock(endClock || sameDayEndClock)
  if (!start || !end || !inScheduleSeason(start) || !inScheduleSeason(end) || end < start || from === null || to === null) return null
  if (start === end && from && to && to < from) return null
  const trailing = value.slice(match[0].length).trim()
  // A list, missing range end, tentative date, or day/clock not captured by this rule needs review.
  const notes = trailing.match(CONFIRMED_RANGE_NOTE)?.[1]
  if (trailing && !notes && !/^[。；;.]$/.test(trailing)) return null
  let time = from && to ? from + '–' + to : from || to
  if (start !== end && from) time = '首日 ' + from + (to ? ' 至末日 ' + to : '')
  if (start !== end && !from && to) time = '末日 ' + to
  return { start, end, time, notes }
}

function eventType(label) {
  if (label.includes('报名')) return 'registration'
  if (/线上|网上|网络|远程/.test(label)) return 'online'
  if (/线下|现场/.test(label)) return 'offline'
  return 'exam'
}

function phaseOf(label) {
  const round = label.match(/初试|复试|三试|终试/)?.[0] || ''
  return label.includes('报名') ? '报名' + round : round || '考试'
}

function eventId(schoolId, phase) {
  return 'radar-' + createHash('sha256').update(schoolId + '|' + phase).digest('hex').slice(0, 16)
}

function holdFromAmendment(school, notice, entries) {
  const title = notice.title
  if (!notice.publishedAt || !UPDATE_TITLE.test(title) || !/时间|日期|改期|延期|取消/.test(title) ||
      /资格|名单|恢复|体检|录取|招生专业|科目|考试内容|咨询/.test(title)) return null
  const rounds = new Set(title.match(/初试|复试|三试|终试/g) || [])
  if (rounds.size > 1) return null
  const phase = phaseOf(title)
  const id = eventId(school.id, phase)
  if (entries.some(entry => entry.id === id)) return null
  return { id, schoolId: school.id, publishedAt: notice.publishedAt, url: notice.url }
}

export function isCurrentNotice(title) {
  const provinceOnly = /统考/.test(title) && !/校考/.test(title) && /对照|省统考(?:报名|时间|考试)|子科类|科类对应/.test(title)
  return /2027\s*年/.test(title) && NOTICE_TITLE.test(title) && !EXCLUDED_TITLE.test(title) && !provinceOnly
}

export function extractSchedules(body, school, notice) {
  if (!isCurrentNotice(notice.title) || !SCHEDULE_TITLE.test(notice.title)) return []
  const candidates = new Map()
  const conflicting = new Set()
  let sectionExcluded = false
  let subsectionExcluded = false
  let nearExcluded = 0
  for (const raw of body.split(/\r?\n/)) {
    const sourceLine = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
    if (!sourceLine) continue
    const line = sourceLine.replace(/^(?:[一二三四五六七八九十\d]+[.、]|[(][一二三四五六七八九十\d]+[)])\s*/u, '')
    const heading = line.match(DETAIL_LABEL)
    if (!heading && /^[一二三四五六七八九十]+[.、]/u.test(sourceLine)) {
      sectionExcluded = FATAL_CONTEXT.test(line)
      subsectionExcluded = false
      nearExcluded = 0
      continue
    }
    if (!heading && /^\([一二三四五六七八九十]+\)/u.test(sourceLine)) {
      subsectionExcluded = FATAL_CONTEXT.test(line)
      nearExcluded = 0
      continue
    }
    if (!heading) {
      nearExcluded = FATAL_CONTEXT.test(line) && line.length <= 70 ? 2 : Math.max(0, nearExcluded - 1)
      continue
    }
    if (sectionExcluded || subsectionExcluded || nearExcluded || FATAL_CONTEXT.test(line)) continue
    const label = heading[1].replace(/\s+/g, '')
    const phase = phaseOf(label)
    const dates = parseDateSlot(line.slice(heading[0].length))
    if (!dates) {
      conflicting.add(phase)
      continue
    }
    const existing = candidates.get(phase)
    const type = eventType(label)
    if (type !== 'registration' && dates.start < '2027-01-01') continue
    if (existing && (existing.start !== dates.start || existing.end !== dates.end || (existing.time || '') !== dates.time || existing.type !== type)) {
      conflicting.add(phase)
      continue
    }
    const item = {
      id: eventId(school.id, phase),
      schoolId: school.id,
      type,
      title: label,
      start: dates.start,
      end: dates.end,
      sourceUrl: notice.url,
      sourceTitle: notice.title
    }
    if (dates.time) item.time = dates.time
    if (dates.notes) item.notes = dates.notes
    if (notice.publishedAt) item.publishedAt = notice.publishedAt
    candidates.set(phase, item)
  }
  return [...candidates].filter(([phase]) => !conflicting.has(phase)).map(([, item]) => item)
}

function officialUrl(value, allowedHosts, base) {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.has(url.hostname)) return ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

export function identifySupplement(value, schools, watch = {}) {
  const url = typeof value === 'string' ? value.trim() : ''
  if (url.length > 1800 || !/^https:\/\//i.test(url) || /[\\\s\u0000-\u001f\u007f]/.test(url)) {
    throw new Error('请输入一条完整的院校官方 HTTPS 公告链接')
  }
  const matches = schools.flatMap(school => {
    const address = officialUrl(url, safeHostSet(school, watch[school.id] || []))
    return address ? [{ schoolId: school.id, url: address }] : []
  })
  if (matches.length !== 1) throw new Error('链接不属于本日历固定跟踪名单中的院校官网')
  const parsed = new URL(matches[0].url)
  const hasCredentials = [...parsed.searchParams.keys()].some(key =>
    /^(?:access[_-]?token|api[_-]?key|authorization|code|credential|password|secret|signature|session(?:id)?|token)$/i.test(key))
  if (hasCredentials) throw new Error('请使用无需登录、没有鉴权参数的公开公告链接')
  return matches[0]
}

async function incoming(url, allowedHosts, maxBytes, form) {
  let next = officialUrl(url, allowedHosts)
  if (!next) throw new UnsafeNoticeLink('链接超出院校官方 HTTPS 来源')
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(next, {
      redirect: 'manual',
      signal: AbortSignal.timeout(14000),
      ...(form ? { method: 'POST', body: new URLSearchParams(form) } : {}),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; LiaoningAdmissionsRadar/1.0)', 'accept-language': 'zh-CN,zh;q=0.9' }
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (form) throw new Error('官方公告查询接口已改址')
      next = officialUrl(response.headers.get('location'), allowedHosts, next)
      if (!next) throw new UnsafeNoticeLink('公告跳转到院校官方来源范围以外')
      continue
    }
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const type = response.headers.get('content-type') || ''
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('响应过大')
    const chunks = []
    let count = 0
    for await (const chunk of response.body) {
      count += chunk.length
      if (count > maxBytes) throw new Error('响应过大')
      chunks.push(chunk)
    }
    return { bytes: Buffer.concat(chunks), type, url: next }
  }
  throw new Error('公告链接跳转次数过多')
}

function decodeDocument({ bytes, type }) {
  const sample = bytes.subarray(0, 4096).toString('latin1')
  const encoding = type.match(/charset=["']?([^;\s"'>]+)/i)?.[1] ||
    sample.match(/charset=["']?([^;\s"'>]+)/i)?.[1] || 'utf-8'
  return new TextDecoder(encoding).decode(bytes)
}

async function queryJson(url, allowedHosts, form) {
  const response = await incoming(url, allowedHosts, MAX_HTML_BYTES, form)
  return JSON.parse(decodeDocument(response))
}

function articleTitle(html) {
  const title = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  return htmlText(title).replace(/\s+/g, ' ').trim()
}

function publicationDate(body) {
  const match = body.normalize('NFKC').match(/(?:发布时间|发布日期|更新日期)\s*[:：]?\s*(20\d{2})[年./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})/)
  return match ? dateKey(match[1], match[2], match[3]) : ''
}

function validPublishedAt(value) {
  const match = String(value || '').match(/^(20\d{2})-(\d{2})-(\d{2})(?:$|[ T])/)
  return match ? dateKey(match[1], match[2], match[3]) : ''
}

function shanghaiDate(milliseconds) {
  const date = new Date(Number(milliseconds) + 8 * 60 * 60 * 1000)
  return Number.isNaN(+date) ? '' : validPublishedAt(date.toISOString())
}

async function officialDynamicIndex(school, allowedHosts) {
  if (school.id === 'zhejiang-media' && allowedHosts.has(ZHEJIANG_HOST)) {
    const base = 'https://' + ZHEJIANG_HOST
    const pages = await Promise.all(ZHEJIANG_CATEGORIES.map(categoryId => queryJson(
      base + '/f/newsCenter/ajax_category_article_list', allowedHosts, { categoryId, pageSize: '18' }
    )))
    return pages.flatMap(page => {
      const entries = page?.data?.[0]?.contentList
      if (!Array.isArray(entries)) throw new Error('浙江传媒学院公开公告目录格式已变更')
      return entries.map(item => ({
        title: item.title || '',
        url: officialUrl(item.url, allowedHosts, base),
        publishedAt: shanghaiDate(item.releaseDate)
      }))
    })
  }
  return []
}

function dynamicNotice(html, title, publishedAt, attachments, notice, allowedHosts) {
  if (!html || !title) throw new Error('未读取到官方公告正文')
  if (!isCurrentNotice(title)) throw new OutsideCalendarScope('该链接不是所跟踪年度的艺术类本科校考公告')
  return {
    body: htmlText(html),
    title,
    publishedAt,
    attachments: [...attachments, ...pageLinks(html, notice.url, allowedHosts)]
      .filter(link => link.url && /\.pdf(?:\?|$)/i.test(link.url) && /简章|通知|安排/.test(link.title)).slice(0, 2)
  }
}

async function officialDynamicDocument(notice, allowedHosts) {
  const url = new URL(notice.url)
  const id = url.searchParams.get('id')
  if (!id || !/^[a-f0-9]{32}$/i.test(id)) return null
  if (url.hostname === ZHEJIANG_HOST && url.pathname.endsWith('/frontViewArticle.html')) {
    const result = await queryJson(url.origin + '/f/newsCenter/ajax_article_view', allowedHosts, { contentId: id })
    const item = result?.data?.article
    return dynamicNotice(item?.articleData?.content, item?.title, shanghaiDate(item?.releaseDate), [], notice, allowedHosts)
  }
  return null
}

function directNoticeTitle(candidates) {
  const headings = candidates.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const chosen = headings.find(value => isCurrentNotice(value))
  if (chosen) return chosen
  if (headings.some(value => /20\d{2}\s*年/.test(value))) {
    throw new OutsideCalendarScope('该链接不是所跟踪年度的艺术类本科校考公告')
  }
  throw new Error('未读取到明确的 2027 年艺术类本科招生公告标题')
}

function screenDocument(document, notice, allowedHosts) {
  const pdf = /application\/pdf/i.test(document.type) || document.bytes.subarray(0, 5).toString() === '%PDF-'
  if (pdf) {
    const result = spawnSync('pdftotext', ['-layout', '-', '-'], {
      input: document.bytes,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 9000
    })
    if (result.status !== 0 || !result.stdout?.trim()) throw new Error('PDF 未能读取文字')
    const title = notice.supplement
      ? directNoticeTitle(result.stdout.slice(0, 1500).split(/\r?\n/).slice(0, 6))
      : notice.title
    if (!/2027\s*年/.test(result.stdout.slice(0, 3000))) throw new Error('PDF 招生年度待核对')
    return { body: result.stdout, title, publishedAt: publicationDate(result.stdout), attachments: [] }
  }
  if (!/html|text\/plain/i.test(document.type)) throw new Error('公告格式待人工核对')
  const html = decodeDocument(document)
  const typeTitle = articleTitle(html)
  if (typeTitle && EXCLUDED_TITLE.test(typeTitle)) throw new OutsideCalendarScope('不属于本科校考公告')
  const body = htmlText(html)
  if (notice.supplement) {
    const headings = [...html.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)].slice(0, 15).map(match => htmlText(match[1]))
    const pageTitle = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
    const title = directNoticeTitle([typeTitle, ...headings, htmlText(pageTitle)])
    return {
      body,
      title,
      publishedAt: publicationDate(body),
      attachments: scheduleAttachments(html, document.url, allowedHosts)
    }
  }
  if (!/2027\s*年/.test(typeTitle) && !/2027\s*年/.test(body.slice(0, 7000))) throw new Error('原文招生年度待核对')
  return {
    body,
    title: isCurrentNotice(typeTitle) ? typeTitle : notice.title,
    publishedAt: publicationDate(body),
    attachments: scheduleAttachments(html, document.url, allowedHosts)
  }
}

function scheduleAttachments(html, base, allowedHosts) {
  return pageLinks(html, base, allowedHosts).filter(link =>
    /\.pdf(?:\?|$)/i.test(link.url) && /简章|通知|安排/.test(link.title)).slice(0, 2)
}

function pageLinks(html, base, allowedHosts) {
  const links = []
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(anchor)) {
    const url = officialUrl(decodeHtml(match[1] ?? match[2] ?? match[3]), allowedHosts, base)
    const title = htmlText(match[4]).replace(/\s+/g, ' ').trim()
    if (url && title) links.push({ url, title })
  }
  return links
}

function safeHostSet(school, watchUrls) {
  const addresses = [school.sourceUrl, school.noticeUrl, ...watchUrls].filter(Boolean)
  return new Set(addresses.map(address => new URL(address).hostname))
}

async function readSchoolNotice(school, notice, allowedHosts, review) {
  const dynamic = await officialDynamicDocument(notice, allowedHosts)
  const doc = dynamic ? null : await incoming(notice.url, allowedHosts, MAX_DOCUMENT_BYTES)
  const read = dynamic || screenDocument(doc, notice, allowedHosts)
  const verified = { url: doc?.url || notice.url, title: read.title, publishedAt: read.publishedAt || notice.publishedAt }
  let entries = extractSchedules(read.body, school, verified)
  for (const attachment of read.attachments) {
    try {
      const file = await incoming(attachment.url, allowedHosts, MAX_DOCUMENT_BYTES)
      // The verified official article supplies the title for its attached announcement.
      const attached = screenDocument(file, verified, allowedHosts)
      entries = entries.concat(extractSchedules(attached.body, school, { ...verified, url: file.url }))
    } catch (error) {
      review.push({ schoolId: school.id, url: attachment.url, reason: error.message })
    }
  }
  if (SCHEDULE_TITLE.test(verified.title) && !entries.length) {
    review.push({ schoolId: school.id, url: verified.url, title: verified.title, reason: UPDATE_TITLE.test(verified.title) ? '调整公告日期或场次待核对' : '未提取到明确完整的日程' })
  }
  return { ...verified, entries, hold: holdFromAmendment(school, verified, entries) }
}

export async function processSupplement(school, supplement, allowedHosts, review) {
  try {
    const notice = await readSchoolNotice(school, { url: supplement.url, supplement: true }, allowedHosts, review)
    return { notice, status: notice.entries.length ? 'dates-extracted' : 'dates-pending' }
  } catch (error) {
    const status = error instanceof OutsideCalendarScope || error instanceof UnsafeNoticeLink ? 'out-of-scope' : 'source-pending'
    review.push({ schoolId: school.id, url: supplement.url, reason: error.message })
    return { notice: null, status }
  }
}

async function lookupSchool(school, watchUrls, radar, review, excludedUrls = new Set()) {
  const allowedHosts = safeHostSet(school, watchUrls)
  const records = radar.filter(record => record.school === school.name && isCurrentNotice(record.title || ''))
  const fromRadar = records.map(record => ({
    title: record.title,
    url: officialUrl(record.url, allowedHosts),
    publishedAt: ''
  })).filter(item => item.url)
  const indexes = [...new Set([school.sourceUrl, ...watchUrls])]
  const scans = await Promise.allSettled(indexes.map(async url => {
    const document = await incoming(url, allowedHosts, MAX_HTML_BYTES)
    return pageLinks(decodeDocument(document), document.url, allowedHosts)
      .filter(link => isCurrentNotice(link.title))
  }))
  const byUrl = new Map(fromRadar.map(item => [item.url, item]))
  for (let index = 0; index < scans.length; index += 1) {
    const scan = scans[index]
    if (scan.status === 'rejected') {
      review.push({ schoolId: school.id, url: indexes[index], reason: scan.reason.message })
    } else {
      for (const item of scan.value) byUrl.set(item.url, item)
    }
  }
  if (school.noticeUrl && isCurrentNotice(school.noticeTitle || '')) {
    byUrl.set(school.noticeUrl, { url: school.noticeUrl, title: school.noticeTitle, publishedAt: school.publishedAt })
  }
  try {
    const dynamic = await officialDynamicIndex(school, allowedHosts)
    for (const notice of dynamic) {
      if (notice.url && isCurrentNotice(notice.title)) byUrl.set(notice.url, notice)
    }
  } catch (error) {
    review.push({ schoolId: school.id, url: school.sourceUrl, reason: error.message })
  }
  const notices = [...byUrl.values()].filter(notice => !excludedUrls.has(notice.url)).sort((left, right) => {
    return Number(SCHEDULE_TITLE.test(right.title)) - Number(SCHEDULE_TITLE.test(left.title)) ||
      (right.publishedAt || '').localeCompare(left.publishedAt || '')
  }).slice(0, MAX_NOTICE_DOCUMENTS)
  const outcomes = await Promise.allSettled(notices.map(notice => readSchoolNotice(school, notice, allowedHosts, review)))
  return outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return [outcome.value]
    review.push({ schoolId: school.id, url: notices[index].url, reason: outcome.reason.message })
    return []
  })
}

function sameEvent(left, right) {
  return left.start === right.start && left.end === right.end && (left.time || '') === (right.time || '') && left.type === right.type
}

export function mergeScheduleEvents(previous, current, review, holds = []) {
  const groups = new Map()
  for (const change of current) {
    const items = groups.get(change.id) || []
    items.push(change)
    groups.set(change.id, items)
  }
  const safe = new Map(previous.map(event => [event.id, event]))
  for (const [id, changes] of groups) {
    const existing = safe.get(id)
    const options = existing ? [...changes, existing] : changes
    const newest = options.sort((left, right) => (right.publishedAt || '').localeCompare(left.publishedAt || ''))[0]
    const ambiguous = options.some(option => !sameEvent(option, newest) &&
      (!newest.publishedAt || !option.publishedAt || newest.publishedAt === option.publishedAt ||
        !UPDATE_TITLE.test(newest.sourceTitle) && newest.sourceUrl !== option.sourceUrl))
    if (ambiguous) {
      review.push({ schoolId: newest.schoolId, url: newest.sourceUrl, reason: '同一场次存在冲突，日期待核对' })
      if (existing && newest.publishedAt && (newest.publishedAt > (existing.publishedAt || '') ||
          UPDATE_TITLE.test(newest.sourceTitle))) {
        safe.delete(id)
      }
      continue
    }
    safe.set(id, newest)
  }
  for (const hold of holds) {
    const existing = safe.get(hold.id)
    if (existing && hold.publishedAt >= (existing.publishedAt || '')) {
      safe.delete(hold.id)
      review.push({ schoolId: hold.schoolId, url: hold.url, reason: '已移除受调整公告影响的旧日程，等待核对新安排' })
    }
  }
  return [...safe.values()].sort((left, right) => left.start.localeCompare(right.start) || left.id.localeCompare(right.id))
}

async function optionalJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

function seedShape(feed) {
  return feed?.version === 1 && feed?.season === SEASON && Array.isArray(feed.schools) && Array.isArray(feed.events)
}

function saveSupplementResult(record, result) {
  const updated = { ...record, status: result.status }
  if (result.notice) updated.title = result.notice.title
  return updated
}

async function supplementSummary(message) {
  console.log(message)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '### 公告补录\n\n' + message + '\n', 'utf8')
}

async function run() {
  const root = process.cwd()
  const seedPath = resolve(root, process.env.CALENDAR_SEED_FILE || 'config/calendar-2027.json')
  const outputPath = resolve(root, process.env.CALENDAR_OUTPUT_FILE || 'dist/data/calendar-2027.json')
  const feedPath = resolve(root, process.env.CALENDAR_RADAR_FILE || 'dist/data/feed.json')
  const watchPath = resolve(root, process.env.CALENDAR_WATCH_FILE || 'config/calendar-watch-2027.json')
  const supplementPath = resolve(root, process.env.CALENDAR_SUPPLEMENT_FILE || 'config/calendar-supplements-2027.json')
  const reviewPath = resolve(root, process.env.CALENDAR_REVIEW_FILE || 'work/calendar-review-2027.json')
  const seed = await optionalJson(seedPath, null)
  if (!seedShape(seed)) throw new Error('2027 日历配置缺失或版本不符')
  if (process.argv.includes('--seed-only')) {
    if (!await optionalJson(outputPath, null)) await writeJson(outputPath, seed)
    return
  }
  const local = await optionalJson(feedPath, null)
  const prior = await optionalJson(outputPath, seed)
  if (!seedShape(prior)) throw new Error('上一版日历格式无效')
  const watch = await optionalJson(watchPath, {})
  const rawSubmission = process.env.CALENDAR_SUPPLEMENT_URL
  const submission = rawSubmission ? identifySupplement(rawSubmission, seed.schools, watch) : null
  const saved = await optionalJson(supplementPath, { version: 1, season: SEASON, links: [] })
  if (saved?.version !== 1 || saved.season !== SEASON || !Array.isArray(saved.links)) {
    throw new Error('补录链接文件格式无效')
  }
  const allowedIds = new Set(seed.schools.map(school => school.id))
  const links = saved.links.filter(item => allowedIds.has(item.schoolId))
  const review = []
  let publishedRadar = local
  if (!submission && !publishedRadar) {
    try {
      const downloaded = await incoming(RADAR_FEED, new Set([new URL(RADAR_FEED).hostname]), MAX_HTML_BYTES)
      publishedRadar = JSON.parse(decodeDocument(downloaded))
    } catch (error) {
      review.push({ url: RADAR_FEED, reason: error.message })
    }
  }
  const now = new Date().toISOString()
  let submittedNotice
  if (submission) {
    const school = seed.schools.find(item => item.id === submission.schoolId)
    const previous = links.findIndex(item => item.url === submission.url)
    submittedNotice = await processSupplement(school, submission, safeHostSet(school, watch[school.id] || []), review)
    if (submittedNotice.status === 'out-of-scope') {
      const reason = review.findLast(item => item.url === submission.url)?.reason
      throw new Error('未收录：' + (reason || '公告超出校考日历范围'))
    }
    const priorLink = previous === -1 ? { ...submission, submittedAt: now } : links[previous]
    const updatedLink = saveSupplementResult(priorLink, submittedNotice)
    if (previous === -1) links.push(updatedLink)
    else links[previous] = updatedLink
  }

  const reads = await Promise.all(seed.schools.map(async school => {
    const watchUrls = watch[school.id] || []
    const schoolLinks = links.filter(item => item.schoolId === school.id)
    const notices = []
    if (submission) {
      if (school.id === submission.schoolId && submittedNotice.notice) notices.push(submittedNotice.notice)
    } else {
      const blocked = new Set(schoolLinks.map(item => item.url))
      notices.push(...await lookupSchool(school, watchUrls, publishedRadar?.records || [], review, blocked))
      const hosts = safeHostSet(school, watchUrls)
      const activeLinks = schoolLinks.filter(item => item.status !== 'out-of-scope').slice(-MAX_SUPPLEMENTS_PER_SCAN)
      for (let index = 0; index < activeLinks.length; index += 4) {
        const batch = activeLinks.slice(index, index + 4)
        const outcomes = await Promise.all(batch.map(item => processSupplement(school, item, hosts, review)))
        for (let position = 0; position < batch.length; position++) {
          const outcome = outcomes[position]
          Object.assign(batch[position], saveSupplementResult(batch[position], outcome))
          if (outcome.notice) notices.push(outcome.notice)
        }
      }
    }
    const matchingNotice = notices.sort((left, right) =>
      (right.publishedAt || '').localeCompare(left.publishedAt || ''))[0]
    const previousSchool = prior.schools.find(item => item.id === school.id) || school
    const retained = !school.noticeUrl || (previousSchool.publishedAt || '') >= (school.publishedAt || '')
      ? previousSchool : school
    const useNewNotice = matchingNotice &&
      (!retained.noticeUrl || (matchingNotice.publishedAt || '') > (retained.publishedAt || ''))
    const summary = useNewNotice
      ? {
          id: school.id, name: school.name, sourceUrl: school.sourceUrl,
          noticeUrl: matchingNotice.url, noticeTitle: matchingNotice.title,
          ...(matchingNotice.publishedAt ? { publishedAt: matchingNotice.publishedAt } : {})
        }
      : { ...retained, id: school.id, name: school.name, sourceUrl: school.sourceUrl }
    return { summary, events: notices.flatMap(notice => notice.entries), holds: notices.map(notice => notice.hold).filter(Boolean) }
  }))
  const automaticallyFound = mergeScheduleEvents(
    prior.events.filter(event => allowedIds.has(event.schoolId)),
    reads.flatMap(read => read.events),
    review,
    reads.flatMap(read => read.holds)
  )
  // A manually checked correction with the same event ID is authoritative.
  const eventsById = new Map(automaticallyFound.map(event => [event.id, event]))
  for (const event of seed.events) eventsById.set(event.id, event)
  const events = [...eventsById.values()].sort((left, right) => left.start.localeCompare(right.start) || left.id.localeCompare(right.id))
  const schools = reads.map(read => read.summary)
  const payload = { version: 1, season: SEASON, updatedAt: now, schools, events }
  if (JSON.stringify(prior.schools) !== JSON.stringify(schools) ||
      JSON.stringify(prior.events) !== JSON.stringify(events) || !await optionalJson(outputPath, null)) {
    await writeJson(outputPath, payload)
  }
  if (JSON.stringify(saved.links) !== JSON.stringify(links)) {
    await writeJson(supplementPath, { version: 1, season: SEASON, links })
  }
  const sortedReview = review.sort((left, right) => (left.schoolId || '').localeCompare(right.schoolId || '') || left.url.localeCompare(right.url))
  await writeJson(reviewPath, { version: 1, season: SEASON, checkedAt: now, records: sortedReview })
  console.log(SEASON + ' 校考日历：' + schools.length + ' 所院校，' + events.length + ' 条日程，' + review.length + ' 项来源需查看')
  if (submission) {
    const school = seed.schools.find(item => item.id === submission.schoolId)
    const extracted = submittedNotice.notice?.entries || []
    const published = extracted.filter(entry => events.some(item => item.id === entry.id && item.sourceUrl === entry.sourceUrl))
    const outcome = submittedNotice.status === 'source-pending'
      ? '原文暂未读取成功，后续定时重试'
      : extracted.length
        ? '提取 ' + extracted.length + ' 项日期，当前日历收录 ' + new Set(published.map(item => item.id)).size + ' 项'
        : '已读取官方公告，时间待公布或原文暂未给出完整日程'
    await supplementSummary(school.name + '：' + outcome)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
