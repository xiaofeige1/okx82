/**
 * GitHub Actions 版本 - OKX永续合约形态筛选器（动态 Median 实时比对版）
 *
 * ✅ 筛选逻辑：
 * 1. 最近连续 CHECK_EMA_BARS (12根) 1H K 线收盘价 > 1H EMA80
 * 2. 200 根 1H K 线内寻找最高点 (Max High)
 * 3. 最高点后寻找最低点，当收盘价突破【当时时刻】的动态 Median ( (MaxHigh + MinLow)/2 ) 时，锁定该最低点 (Support Low)
 * 4. 从突破分水岭那一刻起，直到最新一根 K 线，最低价均未跌破锁定的支撑最低点
 * 5. 最近 5 根 1H K 线中，至少有一根的最高价突破了【其对应时刻】的动态 Median
 */

import axios from "axios"
import fs from "fs"

const now = new Date()
const dateStr = now.toLocaleDateString('zh-CN')
const timeStr = now.toLocaleTimeString('zh-CN')

console.log("┌────────────────────────────────────────────────────────┐")
console.log("│* 执行时间: " + `${dateStr} ${timeStr}`.padEnd(43) + "│")
console.log("│* 连续12根 > EMA80                                      │")
console.log("│* 动态突破50%锁定低点不破                                │")
console.log("│* 近5H最高价突破当刻 Median                              │")
console.log("└────────────────────────────────────────────────────────┘")

// =====================================================
// 参数配置
// =====================================================
const BAR = "1H"
const KLINE_LIMIT = 200        // K线获取根数
const EMA_PERIOD = 80          // EMA 周期
const CHECK_EMA_BARS = 12      // 需要连续大于 EMA80 的 K 线数量
const TOP_N = 100              // 筛选成交额前 N 的币种
const MIN_VOL_USDT = 8_000_000 // 最小 24h 成交额 (USDT)
const CONCURRENCY = 2          // 请求并发数
const FETCH_TIMEOUT = 10000    // 请求超时时间 (ms)
const MAX_RETRY = 3            // 最大重试次数

const RESULT_FILE = "result.json"

// =====================================================
// 基础工具函数
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
// 全量 EMA 计算函数 (输入正序数组)
// =====================================================
function calculateEMA(closes, period) {
  if (closes.length < period) return []
  const ema = new Array(closes.length)
  const multiplier = 2 / (period + 1)

  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += closes[i]
  }
  ema[period - 1] = sum / period

  for (let i = period; i < closes.length; i++) {
    ema[i] = (closes[i] - ema[i - 1]) * multiplier + ema[i - 1]
  }

  return ema
}

// =====================================================
// 单币种处理逻辑
// =====================================================
async function processSymbol(t) {
  try {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${t.symbol}&bar=${BAR}&limit=${KLINE_LIMIT}`
    const kline = await fetchJson(url)

    if (!kline.data || kline.data.length < KLINE_LIMIT) return null

    // 转为【正序】数组，Index 0 为最老 K 线，Index 199 为最新 K 线
    const rawData = kline.data.slice().reverse()
    const highs = rawData.map(bar => +bar[2])  // 最高价
    const lows = rawData.map(bar => +bar[3])   // 最低价
    const closes = rawData.map(bar => +bar[4]) // 收盘价

    // ----------------------------------------------------
    // 条件 A：最近 CHECK_EMA_BARS 根 K 线收盘价均大于 EMA80
    // ----------------------------------------------------
    const ema80Array = calculateEMA(closes, EMA_PERIOD)
    if (ema80Array.length === 0) return null
    const totalLen = closes.length

    for (let i = 0; i < CHECK_EMA_BARS; i++) {
      const idx = totalLen - 1 - i
      if (closes[idx] <= ema80Array[idx]) {
        return null // 只要有一根小于等于 EMA80，直接淘汰
      }
    }

    // ----------------------------------------------------
    // 条件 B-1：寻找 200 根内最高点 maxHigh
    // ----------------------------------------------------
    let maxHigh = -1
    let maxHighIdx = -1
    for (let i = 0; i < KLINE_LIMIT - 1; i++) {
      if (highs[i] > maxHigh) {
        maxHigh = highs[i]
        maxHighIdx = i
      }
    }

    if (maxHighIdx === -1) return null

    // ----------------------------------------------------
    // 条件 B-2：动态计算每个时刻的 Median，收盘价突破当刻 Median 时截断锁定低点
    // ----------------------------------------------------
    let confirmedPullbackLow = null
    let breakThroughIdx = -1
    let currentMin = Infinity

    // 用于记录后续每根 K 线发生时的【动态 Median 轨迹】
    const historicalMedians = new Array(KLINE_LIMIT).fill(0)

    for (let i = maxHighIdx + 1; i < KLINE_LIMIT; i++) {
      const currentLow = lows[i]
      const currentClose = closes[i]

      // 实时更新最高点至今的极小值
      if (currentLow < currentMin) {
        currentMin = currentLow
      }

      // 计算当前 K 线时刻的【动态 Median】
      const dynamicMedian = (maxHigh + currentMin) / 2
      historicalMedians[i] = dynamicMedian

      // 如果尚未锁定支撑低点，判断当前收盘价是否突破当刻的 dynamicMedian
      if (breakThroughIdx === -1) {
        if (currentClose > dynamicMedian) {
          confirmedPullbackLow = currentMin
          breakThroughIdx = i
          // 锁定突破时刻，后续继续循环填充历史 Median 轨迹数组
        }
      }
    }

    // 未能完成突破锁定则淘汰
    if (confirmedPullbackLow === null || breakThroughIdx === -1) return null

    // ----------------------------------------------------
    // 条件 B-3：突破分水岭至今，最低价未跌破锁定的支撑低点
    // ----------------------------------------------------
    for (let i = breakThroughIdx; i < KLINE_LIMIT; i++) {
      if (lows[i] < confirmedPullbackLow) {
        return null // 跌破锁定支撑，淘汰
      }
    }

    // ----------------------------------------------------
    // 条件 B-4：动态强弱过滤（最近 5 根 K 线，各自与当刻的动态 Median 对比）
    // ----------------------------------------------------
    const idx0 = KLINE_LIMIT - 1 // 最新 1H
    const idx1 = KLINE_LIMIT - 2 // 前 1H
    const idx2 = KLINE_LIMIT - 3 // 前 2H
    const idx3 = KLINE_LIMIT - 4 // 前 3H
    const idx4 = KLINE_LIMIT - 5 // 前 4H

    // 只要最近 5 根 K 线的最高价【全都小于等于】各自发生时刻的动态 Median，则视为无力突破，淘汰
    if (
      highs[idx0] <= historicalMedians[idx0] &&
      highs[idx1] <= historicalMedians[idx1] &&
      highs[idx2] <= historicalMedians[idx2] &&
      highs[idx3] <= historicalMedians[idx3] &&
      highs[idx4] <= historicalMedians[idx4]
    ) {
      return null
    }

    // ----------------------------------------------------
    // 构建输出数据
    // ----------------------------------------------------
    const currentPrice = closes[KLINE_LIMIT - 1]
    const latestEMA80 = ema80Array[KLINE_LIMIT - 1]
    const latestMedian = historicalMedians[KLINE_LIMIT - 1]
    const todayOpen = t.sodUtc0
    if (!todayOpen || todayOpen <= 0) return null

    const changePercent = ((currentPrice - todayOpen) / todayOpen) * 100

    return {
      symbol: t.symbol.replace(' ', ''),
      price: currentPrice.toFixed(4),
      ema80: latestEMA80.toFixed(4),
      maxHigh: maxHigh.toFixed(4),
      median: latestMedian.toFixed(4),
      supportLow: confirmedPullbackLow.toFixed(4),
      holdBars: KLINE_LIMIT - 1 - breakThroughIdx,
      changePercent: changePercent.toFixed(2),
      volUsdt: Math.round(t.volUsdt)
    }

  } catch (err) {
    return null
  }
}

// =====================================================
// 并发控制池
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
        console.log(`✅ 找到符合条件币种: ${result.symbol}`)
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
// 保存结果 JSON
// =====================================================
function saveResults(results, executionTime) {
  const symbols = results.map(r => r.symbol)
  const output = {
    localTime: `${dateStr} ${timeStr}`,
    executionTime: `${executionTime}秒`,
    count: results.length,
    symbols: symbols,
    details: results
  }

  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2))
  console.log(`📁 结果已保存到: ${RESULT_FILE}`)
  console.log(`✅ 找到 ${symbols.length} 个符合条件的币种`)

  if (results.length > 0) {
    console.log("\n📊 符合条件币种及详细数据:")
    console.table(
      results,
      [
        "rank",
        "symbol",
        "price",
        "ema80",
        "maxHigh",
        "median",
        "supportLow",
        "holdBars",
        "changePercent"
      ]
    )
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
        from: `OK905 <onboarding@resend.dev>`,
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
// 主函数
// =====================================================
async function main() {
  console.log("1/3: 获取 OKX 永续合约成交额排行...")

  const tickersRes = await fetchJson(
    "https://www.okx.com/api/v5/market/tickers?instType=SWAP"
  )

  if (!tickersRes || !tickersRes.data) {
    console.error("获取永续合约列表失败")
    return
  }

  const top = tickersRes.data
    .filter(t => t.instId.endsWith("USDT-SWAP"))
    .map(t => ({
      symbol: t.instId,
      volUsdt: (+t.last) * (+t.vol24h),
      sodUtc0: parseFloat(t.sodUtc0)
    }))
    .filter(t => t.volUsdt > MIN_VOL_USDT)
    .sort((a, b) => b.volUsdt - a.volUsdt)
    .slice(0, TOP_N)

  console.log(`2/3: 满足成交额条件的候选币种数量: ${top.length}`)
  console.log(`3/3: 开始并发筛选（并发数: ${CONCURRENCY}）...\n`)

  const startTime = Date.now()
  const results = await runPool(top, processSymbol, CONCURRENCY)

  // 按当日涨跌幅从高到低排序
  results.sort((a, b) => parseFloat(b.changePercent) - parseFloat(a.changePercent))
  results.forEach((r, i) => {
    r.rank = i + 1
  })

  const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)

  console.log("\n" + "=".repeat(50))
  console.log(`✅ 筛选完成！找到 ${results.length} 个符合条件的币种`)
  console.log(`⏱️ 总耗时: ${executionTime} 秒`)
  console.log("=".repeat(50) + "\n")

  const savedOutput = saveResults(results, executionTime)
  await sendSimpleEmail(savedOutput.symbols)
}

// =====================================================
// 启动入口
// =====================================================
if (import.meta.url === new URL(import.meta.url).href) {
  main().catch(err => {
    console.error("❌ 程序异常:", err)
    process.exit(1)
  })
}
