const MARKET_ZONE = 'Asia/Shanghai';
const UPSTREAM_TIMEOUT = 6500;
const MODEL_TIMEOUT = 9000;
const DAY_MS = 86_400_000;
const PRICE_TOLERANCE = 0.005;
const SAME_DAY_CUTOFF_MINUTES = 15 * 60 + 40;
const TRADING_DATE_POLICY = '北京时间 15:40 前排除当日日线。到达截止时点后，以来源已发布的日线为准，上游数据可能延迟。';
const STOCK_PREFIXES = new Set(['000', '001', '002', '003', '300', '301', '600', '601', '603', '605', '688', '689']);
const TENCENT_SHARE_VOLUME_PREFIXES = new Set(['688', '689']);
const EASTMONEY_FIELDS = ['f51', 'f52', 'f53', 'f54', 'f55', 'f56', 'f57'];
const TENCENT_FIELDS = ['day[0]', 'day[1]', 'day[2]', 'day[3]', 'day[4]', 'day[5]'];

const toolRegistry = [
  { id: 'eastmoney.daily', title: '东方财富日线', role: '主行情与成交额', access: '公开只读', timeoutMs: UPSTREAM_TIMEOUT, unitPrice: 0 },
  { id: 'tencent.daily', title: '腾讯证券日线', role: '独立行情核查与故障降级', access: '公开只读', timeoutMs: UPSTREAM_TIMEOUT, unitPrice: 0 },
  { id: 'model.plan', title: '模型辅助规划', role: '调整研究计划表述', access: '可选服务器配置，仅发送公开代码和主题类别', timeoutMs: MODEL_TIMEOUT, unitPrice: null },
];

const fieldInfo = [
  ['open', '开盘价', '元/股'],
  ['close', '收盘价', '元/股'],
  ['high', '最高价', '元/股'],
  ['low', '最低价', '元/股'],
  ['volume', '成交量', '手'],
  ['amount', '成交额', '元'],
];

const planTemplate = [
  { id: 'scope', title: '明确目标、标的和可核验的研究范围' },
  { id: 'fetch', title: '请求两家公开行情来源并记录交易日与原始字段' },
  { id: 'compare', title: '核对同一交易日的收盘价并计算近两日变动' },
  { id: 'report', title: '生成引用证据的研究摘要，列出异常和待验证事项' },
];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function parseTicker(value) {
  const ticker = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{6}$/.test(ticker) || !STOCK_PREFIXES.has(ticker.slice(0, 3))) {
    throw new ApiError(400, '请输入本工作台支持的六位沪深 A 股股票代码，例如 600519 或 000001。指数及基金代码无法查询。');
  }
  return { ticker, prefix: ticker[0] === '6' ? 'sh' : 'sz', market: ticker[0] === '6' ? '1' : '0' };
}

function localTradingWindow(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const today = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  const pastClose = Number(values.hour) * 60 + Number(values.minute) >= SAME_DAY_CUTOFF_MINUTES;
  const endTime = today.getTime() - (pastClose ? 0 : DAY_MS);
  return {
    start: new Date(endTime - 35 * DAY_MS).toISOString().slice(0, 10),
    end: new Date(endTime).toISOString().slice(0, 10),
  };
}

async function fetchJson(url, signal, timeout = UPSTREAM_TIMEOUT, options = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.any([signal, timeoutSignal]),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseDailyRows(rawRows, range, rawVolumeUnit) {
  if (!Array.isArray(rawRows)) throw new Error('没有返回可读取的日线序列');
  const days = new Map();
  for (const row of rawRows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error('日线字段缺失');
    const [date, ...values] = row;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('交易日格式异常');
    if (date < range.start || date > range.end) continue;
    const numbers = values.slice(0, 6).map(value => {
      if (value == null || String(value).trim() === '') throw new Error('日线包含空值');
      return Number(value);
    });
    const [open, close, high, low, volume, amount] = numbers;
    if (!numbers.every(Number.isFinite) || Math.min(open, close, high, low) <= 0 ||
      low > Math.min(open, close) || high < Math.max(open, close) || volume < 0 ||
      (amount !== undefined && amount < 0)) {
      throw new Error('日线价格或成交字段未通过有效性检查');
    }
    if (days.has(date)) throw new Error('日线包含重复交易日');
    const volumeInLots = rawVolumeUnit === '股' ? volume / 100 : volume;
    days.set(date, { date, open, close, high, low, volume: volumeInLots, amount, raw: row });
  }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-2);
  if (rows.length < 2) throw new Error('请求期间不足两个有效交易日，无法比较');
  return rows;
}

function eastmoneyRequest(symbol, range) {
  const rawVolumeUnit = '手';
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.search = new URLSearchParams({
    secid: `${symbol.market}.${symbol.ticker}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: EASTMONEY_FIELDS.join(','),
    klt: '101',
    fqt: '0',
    beg: range.start.replaceAll('-', ''),
    end: range.end.replaceAll('-', ''),
  }).toString();
  return {
    tool: toolRegistry[0],
    url,
    rawFields: EASTMONEY_FIELDS,
    rawVolumeUnit,
    parse(body) {
      if (body?.rc !== 0) throw new Error(`上游业务状态 ${body?.rc ?? '缺失'}`);
      if (body?.data?.code !== symbol.ticker) throw new Error('未找到对应证券或证券代码不匹配');
      const lines = body.data.klines;
      return {
        company: body.data.name || symbol.ticker,
        rows: parseDailyRows(Array.isArray(lines) ? lines.map(line => line.split(',')) : lines, range, rawVolumeUnit),
      };
    },
  };
}

function tencentRequest(symbol, range) {
  // 腾讯部分科创板代码按股返回成交量，证据保留原始单位，统计统一按手。
  const rawVolumeUnit = TENCENT_SHARE_VOLUME_PREFIXES.has(symbol.ticker.slice(0, 3)) ? '股' : '手';
  const marketCode = symbol.prefix + symbol.ticker;
  const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
  url.searchParams.set('param', `${marketCode},day,${range.start},${range.end},30,`);
  return {
    tool: toolRegistry[1],
    url,
    rawFields: TENCENT_FIELDS,
    rawVolumeUnit,
    parse(body) {
      if (body?.code !== 0) throw new Error(`上游业务状态 ${body?.code ?? '缺失'}`);
      const entity = body?.data?.[marketCode];
      if (!entity) throw new Error('未找到对应证券');
      const company = entity.qt?.[marketCode]?.[1];
      return {
        company: company || symbol.ticker,
        rows: parseDailyRows(Array.isArray(entity.day) ? entity.day.map(row => row.slice(0, 6)) : entity.day, range, rawVolumeUnit),
      };
    },
  };
}

async function readSource(provider, signal) {
  const startedAt = performance.now();
  const { tool, url, parse, rawFields, rawVolumeUnit } = provider;
  const base = { tool: tool.id, source: tool.title, sourceUrl: url.toString(), rawFields, rawVolumeUnit, volumeUnit: '手', cost: 0, calls: 1 };
  try {
    const data = parse(await fetchJson(url, signal));
    return { ...base, ok: true, ...data, retrievedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    const reason = signal.aborted ? '请求已取消' :
      error.name === 'TimeoutError' ? '请求超过 6.5 秒' : error.message;
    return { ...base, ok: false, error: reason, retrievedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt) };
  }
}

function factsFor(symbol, source) {
  return source.rows.flatMap(row => fieldInfo
    .map(([field, label, unit], index) => row[field] === undefined ? null : ({
      id: `${symbol.ticker}-${row.date}-${field}`,
      label,
      value: row[field],
      unit,
      period: row.date,
      filed: null,
      form: '未复权日线',
      accession: null,
      source: source.source,
      sourceUrl: source.sourceUrl,
      retrievedAt: source.retrievedAt,
      concept: field,
      start: row.date,
      end: row.date,
      taxonomy: '沪深 A 股日线',
      raw: row.raw[index + 1],
      rawField: source.rawFields[index + 1],
      rawUnit: field === 'volume' ? source.rawVolumeUnit : unit,
    }))
    .filter(Boolean));
}

function crossCheck(primary, other) {
  if (!other?.ok) return { status: 'single-source', matches: [], conflicts: [], unmatched: [] };
  const matches = [];
  const conflicts = [];
  const unmatched = [];
  for (const row of primary.rows) {
    const peer = other.rows.find(item => item.date === row.date);
    if (!peer) {
      unmatched.push(row.date);
      continue;
    }
    if (Math.abs(row.close - peer.close) > PRICE_TOLERANCE) {
      conflicts.push({ date: row.date, primaryClose: row.close, secondaryClose: peer.close, unit: '元/股' });
    } else {
      matches.push(row.date);
    }
  }
  const status = conflicts.length ? 'conflict' : unmatched.length ? 'partial' : 'matched';
  return { status, matches, conflicts, unmatched };
}

async function company(request) {
  const symbol = parseTicker(new URL(request.url).searchParams.get('ticker'));
  const range = localTradingWindow(new Date());
  const startedAt = performance.now();
  const sourceReports = await Promise.all([
    readSource(eastmoneyRequest(symbol, range), request.signal),
    readSource(tencentRequest(symbol, range), request.signal),
  ]);
  const usage = { calls: sourceReports.length, cost: 0, elapsedMs: Math.round(performance.now() - startedAt) };
  const available = sourceReports.filter(source => source.ok);
  if (!available.length) {
    return json({
      ok: false,
      ticker: symbol.ticker,
      error: sourceReports.map(source => `${source.source}：${source.error}`).join('；'),
      sourceReports,
      usage,
      facts: [],
      dataPolicy: { tradingDate: TRADING_DATE_POLICY, range },
    }, 502);
  }
  const [eastmoney, tencent] = sourceReports;
  const primary = eastmoney.ok && (!tencent.ok || eastmoney.rows.at(-1).date >= tencent.rows.at(-1).date)
    ? eastmoney : tencent;
  const check = crossCheck(primary, sourceReports.find(source => source !== primary));
  const warnings = [];
  if (check.status === 'single-source') warnings.push('只有一家来源返回有效日线，收盘价未完成独立核查。');
  if (check.status === 'partial') warnings.push('两家来源的最新交易日未完全重合，比较结果只适用于所列日期。');
  if (check.status === 'conflict') warnings.push('同一交易日的收盘价存在来源冲突，列示双方数据并等待核实。');
  const calendarGap = (Date.parse(range.end) - Date.parse(primary.rows.at(-1).date)) / DAY_MS;
  if (calendarGap > 5) warnings.push(`最新交易日距查询截止日 ${calendarGap} 个自然日，请核查节假日、停牌或上游数据更新情况。`);
  return json({
    ok: true,
    company: primary.company,
    ticker: symbol.ticker,
    source: primary.source,
    sourceUrl: primary.sourceUrl,
    retrievedAt: primary.retrievedAt,
    facts: factsFor(symbol, primary),
    sourceReports,
    warnings,
    crossCheck: check,
    usage,
    dataPolicy: { tradingDate: TRADING_DATE_POLICY, range },
  });
}

const prohibitedObjective = /(?:该不该|应不应该|要不要|现在能不能)(?:立即|现在)?(?:买入|卖出|买|卖)|(?:买入|卖出|交易|投资)(?:建议|指令|信号)|(?:荐股|买点|卖点|满仓|内幕消息|稳赚|保证收益|必涨|必跌|预测涨跌)|(?:预测|保证|确定).{0,10}(?:涨停|跌停|目标价|收益率)/iu;

function topicFor(objective) {
  if (/成交|量价|流动性/.test(objective)) return '成交与流动性';
  if (/财报|盈利|估值|公告|资金流|行业/.test(objective)) return '超出当前数据范围的研究目标';
  return '近期股价和交易日行情';
}

function modelSettings(env) {
  const { BUDDY_LLM_URL, BUDDY_LLM_MODEL, BUDDY_LLM_KEY } = env;
  if (!BUDDY_LLM_URL || !BUDDY_LLM_MODEL || !BUDDY_LLM_KEY) return null;
  const url = new URL(BUDDY_LLM_URL);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('模型地址必须使用 HTTPS，且不能含凭据');
  return { url, model: BUDDY_LLM_MODEL, key: BUDDY_LLM_KEY };
}

async function modelPlan(settings, symbol, topic, signal) {
  const body = await fetchJson(settings.url, signal, MODEL_TIMEOUT, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: '你负责改写四步研究计划标题，不产生研究结论。依次为范围、行情取证、两源核对及确定性计算、报告。输出 JSON 对象 {"titles":["…","…","…","…"]}，每项中文，最多48字。禁止预测涨跌、推荐买卖、保证收益。' },
        { role: 'user', content: `公开 A 股标的 ${symbol.ticker}，研究主题类别为${topic}。仅支持近两个有效交易日的公开未复权日线。` },
      ],
      max_tokens: 260,
    }),
  });
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型未返回文本');
  const titles = JSON.parse(content.trim()).titles;
  if (!Array.isArray(titles) || titles.length !== planTemplate.length ||
    titles.some(title => typeof title !== 'string' || title.trim().length < 4 || title.length > 48 || prohibitedObjective.test(title))) {
    throw new Error('模型计划未通过格式和内容核查');
  }
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
    .filter(key => Number.isSafeInteger(body.usage?.[key]) && body.usage[key] >= 0)
    .map(key => [key, body.usage[key]]));
  return {
    steps: planTemplate.map((step, index) => ({ ...step, title: titles[index].trim() })),
    model: settings.model,
    usage: { calls: 1, cost: null, ...usage },
  };
}

async function plan(request, env) {
  let input;
  try {
    input = await request.json();
  } catch {
    throw new ApiError(400, '研究规划请求应为 JSON。');
  }
  const symbol = parseTicker(input?.ticker);
  const objective = typeof input?.objective === 'string' ? input.objective.trim() : '';
  if (!objective || objective.length > 800) throw new ApiError(400, '研究目标需要 1 至 800 字。');
  if (prohibitedObjective.test(objective)) {
    throw new ApiError(422, '请将目标改写为可核验的研究问题。工作台提供历史证据和研究摘要，无法提供买卖指令、确定性预测或收益承诺。');
  }
  const topic = topicFor(objective);
  const clarification = topic.startsWith('超出') ?
    '当前工具支持近两个有效交易日的公开日线。财务、估值、公告等目标只能记录为待验证项。' :
    '确认以近两个有效交易日的不复权日线为研究范围。';
  const startedAt = performance.now();
  let steps = planTemplate;
  let model = '规则引擎';
  let usage = { calls: 0, cost: 0 };
  let warning = '模型服务未配置，计划由可核对的规则生成。';
  try {
    const settings = modelSettings(env);
    if (settings) {
      usage = { calls: 1, cost: null };
      ({ steps, model, usage } = await modelPlan(settings, symbol, topic, request.signal));
      warning = null;
    }
  } catch (error) {
    warning = `模型不可用，已切换到规则计划。原因：${error.name === 'TimeoutError' ? '模型请求超时' : '模型配置、连接或响应异常'}。`;
  }
  return json({ ok: true, steps, clarification, model, warning, usage: { ...usage, elapsedMs: Math.round(performance.now() - startedAt) } });
}

export async function handleApi(request, env = {}) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/api/')) return null;
  try {
    if (pathname === '/api/company' && request.method === 'GET') return await company(request);
    if (pathname === '/api/plan' && request.method === 'POST') return await plan(request, env);
    if (pathname === '/api/tools' && request.method === 'GET') {
      return json({ ok: true, tools: toolRegistry });
    }
    if (['/api/company', '/api/plan', '/api/tools'].includes(pathname)) throw new ApiError(405, '请求方法不受支持。');
    throw new ApiError(404, '接口不存在。');
  } catch (error) {
    if (error instanceof ApiError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: '服务处理失败，请稍后重试。' }, 500);
  }
}

