/**
 * GitHub Actions 版本 - OKX永续合约形态筛选器（精简版）
 *
 * ✅ 1. 最近连续 24 根 1H K线收盘价 > 1H EMA80
 * ✅ 2. 结构性最高点 (Max High) 后寻找最低点，收盘突破 (MaxHigh + MinLow)/2 时锁定支撑
 * ✅ 3. 突破至今最低价未跌破锁定的支撑低点
 */

import axios from "axios"
import fs from "fs"

const now = new Date()
const dateStr = now.toLocaleDateString('zh-CN')
const timeStr = now.toLocaleTimeString('zh-CN')

console.log("┌────────────────────────────────────────")
console.log("│* 连续24根 > EMA80                     ")
console.log("│* 突破(MaxHigh+MinLow)/2锁定支撑低点不破 ")
console.log("└────────────────────────────────────────")

// =====================================================
// 参数配置
// =====================================================
const BAR = "1H"
const KLINE_LIMIT = 200
const EMA_PERIOD = 80
const CHECK_EMA_BARS = 24
const TOP_N = 100
const MIN_VOL_USDT = 8_000_000
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
// EMA 计算函数
// =====================================================
function calculateEMA(closes, period) {
  const ema = new Array(closes.length)
  const multiplier = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  ema[period - 1] = sum / period
  for (let i = period; i < closes.length; i++) {
    ema[i] = (closes[i] - ema[i - 1]) * multiplier + ema[i - 1]
  }
  return ema
}

// =====================================================
// 单个币种处理
// =====================================================
async function processSymbol(t) {
  try {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${t.symbol}&bar=${BAR}&limit=${KLINE_LIMIT}`
    const kline = await fetchJson(url)

    if (!kline.data || kline.data.length < KLINE_LIMIT) return null

    const rawData = kline.data.slice().reverse()
    const highs = rawData.map(bar => +bar[2])
    const lows = rawData.map(bar => +bar[3])
    const closes = rawData.map(bar => +bar[4])
    const totalLen = closes.length

    // 1. 连续 24 根 > EMA80
    const ema80Array = calculateEMA(closes, EMA_PERIOD)
    for (let i = 0; i < CHECK_EMA_BARS; i++) {
      const idx = totalLen - 1 - i
      if (closes[idx] <= ema80Array[idx]) return null
    }

    // 2. 寻找结构性最高点 (避开最后 10 根)
    let maxHigh = -1
    let maxHighIdx = -1
    for (let i = totalLen - 100; i < totalLen - 10; i++) {
      if (highs[i] > maxHigh) {
        maxHigh = highs[i]
        maxHighIdx = i
      }
    }
    if (maxHighIdx === -1) return null

    // 3. 突破 50% 分水岭锁定支撑
    let confirmedPullbackLow = null
    let breakThroughIdx = -1
    let currentMin = Infinity

    for (let i = maxHighIdx + 1; i < totalLen; i++) {
      const currentLow = lows[i]
      const currentClose = closes[i]

      if (currentLow < currentMin) currentMin = currentLow

      const midPoint = (maxHigh + currentMin) / 2
      if (currentClose > midPoint) {
        confirmedPullbackLow = currentMin
        breakThroughIdx = i
        break
      }
    }

    if (confirmedPullbackLow === null || breakThroughIdx === -1) return null

    // 4. 突破后未跌破锁定的支撑
    for (let i = breakThroughIdx; i < totalLen; i++) {
      if (lows[i] < confirmedPullbackLow) return null
    }

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
        from: `OK853 <onboarding@resend.dev>`,
        to: [recipientEmail],
        subject: `Filter results`,
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
    .filter(t => t.instId.endsWith("USDT-SWAP"))
    .map(t => ({
      symbol: t.instId,
      volUsdt: (+t.last) * (+t.vol24h)
    }))
    .filter(t => t.volUsdt > MIN_VOL_USDT)
    .sort((a, b) => b.volUsdt - a.volUsdt)
    .slice(0, TOP_N)

  console.log(`2/3: 候选币种数量: ${top.length}`)
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
