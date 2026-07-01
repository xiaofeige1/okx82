/**
 * GitHub Actions 版本 - OKX永续合约筛选器（极简版）
 * ✅ 修复：今日开盘价使用 UTC 00:00 第一根 1H K 线
 */

import axios from "axios"
import fs from "fs"

const now = new Date()
const dateStr = now.toLocaleDateString('zh-CN')
const timeStr = now.toLocaleTimeString('zh-CN')

console.log("┌────────────────────────────────────────")
console.log("│* 1H最高价 > (昨天最高 + 今天开盘)/2        ")
console.log("│* UTC 00:00 换日（开盘价已修复）")
console.log("└────────────────────────────────────────")

// =====================================================
// 参数配置
// =====================================================
const BAR = "1H"
const MIN_KLINE = 72
const TOP_N = 100
const MIN_VOL_USDT = 20_000_000
const CONCURRENCY = 2
const FETCH_TIMEOUT = 10000
const MAX_RETRY = 3

const RESULT_FILE = "result.json"

// =====================================================
// 工具函数
// =====================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchJson(url, retry = MAX_RETRY) {
  for (let i = 0; i < retry; i++) {
    try {
      const res = await axios.get(url, {
        timeout: FETCH_TIMEOUT,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      })
      return res.data
    } catch (err) {
      if (i === retry - 1) throw err
      await sleep(500 * (i + 1))
    }
  }
}

// =====================================================
// ✅ 修复版：获取今日 / 昨日数据
// =====================================================
function getDayHighLow(klineData) {

  const dayMap = new Map()

  // ✅ 从老到新遍历（关键）
  for (let i = klineData.length - 1; i >= 0; i--) {

    const d = klineData[i]
    const ts = +d[0]
    const date = new Date(ts)

    const dayKey =
      `${date.getUTCFullYear()}-${
        String(date.getUTCMonth() + 1).padStart(2, "0")
      }-${
        String(date.getUTCDate()).padStart(2, "0")
      }`

    const open = +d[1]
    const high = +d[2]
    const low = +d[3]

    if (!dayMap.has(dayKey)) {

      // ✅ 第一次出现的 K 线 = UTC 00:00 开盘
      dayMap.set(dayKey, {
        firstTs: ts,
        open,
        high,
        low
      })

    } else {

      const cur = dayMap.get(dayKey)

      dayMap.set(dayKey, {
        firstTs: Math.min(cur.firstTs, ts),
        open: cur.firstTs < ts ? cur.open : open,
        high: Math.max(cur.high, high),
        low: Math.min(cur.low, low)
      })
    }
  }

  const days = [...dayMap.keys()].sort()
  if (days.length < 2) return null

  const today = dayMap.get(days[days.length - 1])
  const yesterday = dayMap.get(days[days.length - 2])

  return { today, yesterday }
}

// =====================================================
// 单个币种处理
// =====================================================
async function processSymbol(t) {
  try {
    const url =
      `https://www.okx.com/api/v5/market/candles?instId=${t.symbol}` +
      `&bar=${BAR}&limit=${MIN_KLINE}`

    const kline = await fetchJson(url)
    if (!kline.data || kline.data.length < 72) return null

    const current1HKline = kline.data[0]
    const currentHigh = +current1HKline[2]

    const dayData = getDayHighLow(kline.data)
    if (!dayData) return null

    const { yesterday, today } = dayData

    // ✅ 核心筛选条件
    const targetLine = (yesterday.high + today.open) / 2
    if (currentHigh <= targetLine) return null

    return t.symbol.replace(' ', '')
  } catch (err) {
    return null
  }
}

// =====================================================
// 并发控制
// =====================================================
async function runPool(items, worker, concurrency) {
  const results = []
  let index = 0

  async function runner() {
    while (index < items.length) {
      const current = index++
      const result = await worker(items[current])
      if (result) {
        results.push(result)
        console.log(`✅ ${result}`)
      }
    }
  }

  const workers = Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(() => runner())

  await Promise.all(workers)
  return results
}

// =====================================================
// 保存结果
// =====================================================
function saveResults(symbols, executionTime) {
  const output = {
    localTime: `${dateStr} ${timeStr}`,
    executionTime: `${executionTime}秒`,
    count: symbols.length,
    symbols: symbols
  }

  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2))
  console.log(`📁 结果已保存到: ${RESULT_FILE}`)
  console.log(`✅ 找到 ${symbols.length} 个符合条件的币种`)

  if (symbols.length > 0) {
    console.log("📊 符合条件币种:")
    symbols.forEach((symbol, i) => {
      console.log(`  ${i + 1}. ${symbol}`)
    })
  }

  return output
}

// =====================================================
// 发送邮件
// =====================================================
async function sendSimpleEmail(symbols) {
  const apiKey = process.env.RESEND_API_KEY
  const recipientEmail = process.env.RECIPIENT_EMAIL

  if (!apiKey || !recipientEmail) {
    console.log('⚠️ 缺少邮件配置，跳过邮件发送')
    return
  }

  if (symbols.length === 0) {
    console.log('无符合条件币种，跳过邮件发送')
    return
  }

  const html = `<p>${symbols.join('<br>')}</p>`

  try {
    await axios.post(
      "https://api.resend.com/emails",
      {
        from: `OKX852 <onboarding@resend.dev>`,
        to: [recipientEmail],
        subject: `筛选结果`,
        html: html
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    )

    console.log('📧 邮件发送成功')
  } catch (err) {
    console.error('❌ 邮件发送失败:', err.response?.data?.message || err.message)
  }
}

// =====================================================
// 主逻辑
// =====================================================
async function main() {
  console.log("1/3: 获取永续合约成交额排行...")

  const tickersRes = await fetchJson(
    "https://www.okx.com/api/v5/market/tickers?instType=SWAP"
  )

  const top = tickersRes.data
    .map(t => ({ symbol: t.instId, volUsdt: (+t.last) * (+t.vol24h) }))
    .filter(t => t.volUsdt > MIN_VOL_USDT)
    .sort((a, b) => b.volUsdt - a.volUsdt)
    .slice(0, TOP_N)

  console.log(`2/3: 成交额大于20M币种数量: ${top.length}`)
  console.log(`3/3: 开始并发筛选（并发=${CONCURRENCY}）...\n`)

  const startTime = Date.now()
  const symbols = await runPool(top, processSymbol, CONCURRENCY)
  const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)

  console.log("\n" + "=".repeat(50))
  console.log(`✅ 完成！找到 ${symbols.length} 个符合条件的币种`)
  console.log(`⏱️ 总耗时: ${executionTime} 秒`)
  console.log("=".repeat(50))

  saveResults(symbols, executionTime)
  await sendSimpleEmail(symbols)
}

// =====================================================
// 启动
// =====================================================
if (import.meta.url === new URL(import.meta.url).href) {
  main().catch(err => {
    console.error("❌ 程序异常:", err)
    process.exit(1)
  })
}
