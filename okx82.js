/**
 * GitHub Actions 版本 - OKX永续合约筛选器（极简版）
 * 1. 筛选符合条件的币种
 * 2. 只保存symbol名字到result.json
 * 3. 邮件只发筛选时间和symbol名字
 */

import axios from "axios"
import fs from "fs"

const now = new Date()
const timestamp = now.toISOString()
const dateStr = now.toLocaleDateString('zh-CN')
const timeStr = now.toLocaleTimeString('zh-CN')

console.log("┌────────────────────────────────────---──")
console.log("│* high > 昨天最高价                        ")
console.log("│* high > (今天最高 + 今天最低)/2            ")
console.log("└─────────────────────────────────────────")

// =====================================================
// 参数配置
// =====================================================
const BAR = "1H"
const MIN_KLINE = 120
const TOP_N = 100
const MIN_VOL_USDT = 20_000_000
const CONCURRENCY = 2
const FETCH_TIMEOUT = 10000
const MAX_RETRY = 3

// 输出文件
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
// 数据处理函数
// =====================================================
function getDayHighLow(klineData) {
  const dayMap = new Map()

  for (const d of klineData) {
    const ts = +d[0]
    const date = new Date(ts)
    const dayKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
    const high = +d[2]
    const low = +d[3]

    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, { high, low })
    } else {
      const prev = dayMap.get(dayKey)
      dayMap.set(dayKey, {
        high: Math.max(prev.high, high),
        low: Math.min(prev.low, low)
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
    const url = `https://www.okx.com/api/v5/market/candles?instId=${t.symbol}&bar=${BAR}&limit=${MIN_KLINE}`
    const kline = await fetchJson(url)
    if (!kline.data || kline.data.length < 72) return null

    const len = kline.data.length
    const highs = new Array(len)

    for (let i = 0; i < len; i++) {
      const d = kline.data[len - 1 - i]
      highs[i] = +d[2]
    }

    const currentHigh = highs[len - 1]
    const dayData = getDayHighLow(kline.data)
    if (!dayData) return null

    const { yesterday, today } = dayData
    const todayMid = (today.high + today.low) / 2

    // 条件1：当前最高价 > 昨天最高价
    if (currentHigh <= yesterday.high) return null

    // 条件2：当前最高价 > 今天中点
    if (currentHigh <= todayMid) return null

    // 只返回symbol名称
    return t.symbol.replace('-USDT-SWAP', '')
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
// 保存结果到文件（只保存symbol名字）
// =====================================================
function saveResults(symbols, executionTime) {
  const output = {
    // timestamp: timestamp,
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
// 发送极简邮件（只发筛选时间和symbol名字）
// =====================================================
async function sendSimpleEmail(symbols) {
  const apiKey = process.env.RESEND_API_KEY
  const recipientEmail = process.env.RECIPIENT_EMAIL
  const senderEmail = process.env.SENDER_EMAIL || "onboarding@resend.dev"

  if (!apiKey || !recipientEmail) {
    console.log('⚠️ 缺少邮件配置，跳过邮件发送')
    return
  }

  // 只发筛选时间和symbol名字
  // const text = `筛选时间: ${dateStr} ${timeStr}\n符合条件币种:\n${symbols.join('\n') || '无'}`
  const html = `<p>筛选时间: ${dateStr} ${timeStr}</p><p>符合条件币种:</p><p>${symbols.join('<br>') || '无'}</p>`

  try {
    await axios.post(
      "https://api.resend.com/emails",
      {
        from: `OKX Screener <${senderEmail}>`,
        to: [recipientEmail],
        subject: `📈 OKX筛选结果 (${dateStr} ${timeStr})`,
        // text: text,
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
  
  const tickersRes = await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP")
  if (!tickersRes.data) throw new Error("获取 ticker 失败")

  const top = tickersRes.data
    // .filter(t => t.instId.endsWith("USDT-SWAP"))
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

  // 保存结果
  saveResults(symbols, executionTime)
  
  // 发送极简邮件
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
