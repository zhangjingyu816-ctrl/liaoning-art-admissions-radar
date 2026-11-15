import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractSchedules, identifySupplement, isCurrentNotice, mergeScheduleEvents, processSupplement
} from './update-exam-calendar.mjs'

const school = { id: 'lumei', name: '鲁迅美术学院', sourceUrl: 'https://www.lumei.edu.cn/zsjy/bkszs.htm' }
const notice = {
  title: '鲁迅美术学院2027年艺术类本科校考招生简章',
  url: 'https://www.lumei.edu.cn/info/example-only.htm',
  publishedAt: '2026-12-28'
}

test('extracts complete dates and distinguishes school-wide registration, online and on-site rounds', () => {
  const events = extractSchedules([
    '一、报名及考试',
    '1. 初试网上报名、缴费时间：2027年1月6日9:00至1月10日17:00。',
    '2. 网络初试时间：2027年1月23日 14：00—16：00',
    '3. 现场复试考试时间：2027年2月26日–27日',
    '4. 现场复试考试时间：2027年2月26日–27日'
  ].join('\n'), school, notice)
  assert.deepEqual(events.map(item => [item.type, item.start, item.end, item.time]), [
    ['registration', '2027-01-06', '2027-01-10', '首日 09:00 至末日 17:00'],
    ['online', '2027-01-23', '2027-01-23', '14:00–16:00'],
    ['offline', '2027-02-26', '2027-02-27', undefined]
  ])
  assert.ok(events.every(event => event.sourceUrl === notice.url && event.publishedAt === notice.publishedAt))
})

test('rejects earlier cycles, undated policy notices, ambiguous and reserved admission sections', () => {
  assert.equal(isCurrentNotice('2027年本科留学生招生简章'), false)
  assert.equal(isCurrentNotice('鲁迅美术学院2026年本科校考招生简章'), false)
  assert.equal(isCurrentNotice('中央民族大学2027年艺术类本科招生统考专业与各省统考子科类对照表'), false)
  assert.equal(isCurrentNotice('中央民族大学2027年艺术类本科招生校考专业与各省统考子科类对照表'), true)
  assert.deepEqual(extractSchedules('考试时间：2027年1月1日', school, {
    ...notice, title: '鲁迅美术学院2027年本科招生校考专业考试说明'
  }), [])
  assert.deepEqual(extractSchedules([
    '一、往年报名安排',
    '网上报名时间：2027年1月1日',
    '二、港澳华侨考生',
    '报名时间：2027年1月2日',
    '三、普通校考',
    '补报名注意事项',
    '网上报名时间：2027年1月3日',
    '（一）模拟考试',
    '网上初试时间：2027年1月4日',
    '（二）正常招考',
    '初试时间：2026年12月1日',
    '现场复试时间：2027年2月31日',
    '考试时间：2027年3月',
    '现场三试时间：2027年1月23日、2027年2月3日'
  ].join('\n'), school, notice), [])
  assert.deepEqual(extractSchedules('初试时间：2027年1月1日\n初试时间：2027年1月2日', school, notice), [])
})

test('accepts an explicitly dated registration crossing the two calendar years', () => {
  const events = extractSchedules('网上报名时间：2026年12月28日9:00至2027年1月5日16:00', school, notice)
  assert.deepEqual(events.map(item => [item.start, item.end]), [['2026-12-28', '2027-01-05']])
  assert.deepEqual(extractSchedules('报名时间：2026年12月28日至1月5日', school, notice), [])
  assert.deepEqual(extractSchedules('考试时间：2026年12月28日', school, notice), [])
})

test('handles PDF date spacing and known candidate-specific detail references', () => {
  const events = extractSchedules(
    '1. 现场终试考试时间：2027 年 2 月 24 日–2 月 28 日，具体考试场次及时间以准考证为准。',
    school,
    notice
  )
  assert.deepEqual(events.map(item => [item.start, item.end, item.notes]), [
    ['2027-02-24', '2027-02-28', '具体考试场次及时间以准考证为准']
  ])
})

test('accepts exact newer correction, suspends unresolved amendments and does not erase data on fetch errors', () => {
  const original = extractSchedules('现场复试时间：2027年2月18日', school, notice)[0]
  const correction = {
    ...notice,
    url: 'https://www.lumei.edu.cn/info/example-amendment.htm',
    title: '鲁迅美术学院2027年本科校考复试时间调整公告',
    publishedAt: '2027-01-21'
  }
  const replacement = extractSchedules('调整后现场复试时间：2027年2月20日', school, correction)[0]
  assert.equal(replacement.id, original.id)
  assert.deepEqual(mergeScheduleEvents([original], [replacement], []), [replacement])
  const incomplete = { id: original.id, schoolId: school.id, url: correction.url, publishedAt: correction.publishedAt }
  assert.deepEqual(mergeScheduleEvents([original], [], [], [incomplete]), [])
  assert.deepEqual(mergeScheduleEvents([original], [], []), [original])
  const review = []
  assert.deepEqual(mergeScheduleEvents([original], [
    { ...replacement, sourceTitle: notice.title }
  ], review), [])
  assert.equal(review.length, 1)
})

test('accepts one public official link for the fixed schools', () => {
  assert.deepEqual(identifySupplement('  ' + notice.url + '#section  ', [school]), {
    schoolId: school.id, url: notice.url
  })
  assert.deepEqual(identifySupplement('https://admission.lumei.edu.cn/detail?id=2027', [school], {
    lumei: ['https://admission.lumei.edu.cn/news/']
  }), { schoolId: school.id, url: 'https://admission.lumei.edu.cn/detail?id=2027' })
  for (const url of [
    'http://www.lumei.edu.cn/',
    'https://www.lumei.edu.cn.example.org/',
    'https://www.bda.edu.cn/zsjy/bkzsxx/index.htm',
    'https://www.lumei.edu.cn/?token=private',
    'https://public.example.org/\n' + notice.url
  ]) {
    assert.throws(() => identifySupplement(url, [school]))
  }
})

test('verifies the submitted article itself and extracts announced date ranges', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    '<html><head><title>本科招生</title></head><body><h1>招生就业</h1>' +
      '<h4>' + notice.title + '</h4><p>发布时间：2026年12月28日</p>' +
      '<p>网上报名时间：2027年1月6日9:00至1月10日17:00。</p>' +
      '<p>现场复试考试时间：2027年2月26日–27日</p></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  ))
  const review = []
  const result = await processSupplement(school, identifySupplement(notice.url, [school]), new Set(['www.lumei.edu.cn']), review)
  assert.equal(result.status, 'dates-extracted')
  assert.equal(result.notice.title, notice.title)
  assert.deepEqual(result.notice.entries.map(event => [event.type, event.start, event.end]), [
    ['registration', '2027-01-06', '2027-01-10'],
    ['offline', '2027-02-26', '2027-02-27']
  ])
  assert.deepEqual(review, [])
})

test('keeps unavailable and undated sources separate from confirmed dates', async t => {
  const approvedHosts = new Set(['www.lumei.edu.cn'])
  const submission = identifySupplement(notice.url, [school])
  let body = '<h1>鲁迅美术学院2027年本科招生校考考试说明</h1><p>时间另行公布。</p>'
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'Content-Type': 'text/html' } }))
  const pending = await processSupplement(school, submission, approvedHosts, [])
  assert.equal(pending.status, 'dates-pending')
  assert.equal(pending.notice.entries.length, 0)

  body = '<h1>鲁迅美术学院2026年艺术类本科校考招生简章</h1><p>考试时间：2027年2月26日</p><h4>' + notice.title + '</h4>'
  const outside = await processSupplement(school, submission, approvedHosts, [])
  assert.deepEqual(outside, { notice: null, status: 'out-of-scope' })

  body = '<h1>正在验证，请稍候</h1>'
  assert.deepEqual(await processSupplement(school, submission, approvedHosts, []), { notice: null, status: 'source-pending' })
})

test('does not follow a redirect away from the approved official host', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response(null, { status: 302, headers: { Location: 'https://public.example.org/notice' } })
  })
  const review = []
  const result = await processSupplement(school, identifySupplement(notice.url, [school]), new Set(['www.lumei.edu.cn']), review)
  assert.deepEqual(result, { notice: null, status: 'out-of-scope' })
  assert.equal(requests, 1)
  assert.equal(review.length, 1)
})
