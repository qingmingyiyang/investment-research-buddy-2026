'use strict';

const storageKey = 'investment-x-buddy-v1';
const requestTimeout = 25_000;
const maxAttempts = 3;
const tickerPattern = /^(?:000|001|002|003|300|301|600|601|603|605|688|689)\d{3}$/u;
const scopeNote = '本次取证范围为最近两个有效交易日的公开不复权日线。';
const stageTitles = ['界定目标与权限', '读取真实行情证据', '比较同口径数据', '形成研究记录'];
const statusText = {
  planning: '规划中',
  approval: '等待审批',
  running: '执行中',
  paused: '已暂停',
  failed: '取证失败',
  partial: '部分完成',
  completed: '已完成',
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' });
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 });
const field = (id) => document.getElementById(id);
const clock = () => new Date().toISOString();
let operation;
let storageProblem = '';

function readStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.version === 1 && Array.isArray(saved.threads) && Array.isArray(saved.memories)) {
      return saved;
    }
    if (saved !== null) storageProblem = '本地记录版本不兼容，当前工作台将从空白状态开始。';
  } catch {
    storageProblem = '读取本地研究记录失败。当前仍可继续使用工作台。';
  }
  return { version: 1, active: null, threads: [], memories: [] };
}

const state = readStorage();

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    storageProblem = '';
  } catch {
    storageProblem = '当前浏览器无法写入本地研究记录。请在离开前下载已有研究产物。';
  }
  renderNotice();
}

function create(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, callback, className) {
  const button = create('button', label, className);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

function activeThread() {
  return state.threads.find((thread) => thread.id === state.active);
}

function renderNotice() {
  const node = field('notice');
  node.hidden = !storageProblem;
  node.textContent = storageProblem;
}

function when(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? dateFormat.format(date) : '未提供';
}

function log(thread, message) {
  thread.logs.push({ at: clock(), message });
  if (thread.logs.length > 30) thread.logs.shift();
}

function checkpoint(thread, stage, message) {
  thread.cursor = stage;
  thread.checkpoint = { stage, at: clock(), message };
  log(thread, message);
  persist();
  render();
}

function rules(thread, reason) {
  thread.planner = { name: '规则计划', detail: reason };
  thread.proposals = [
    '确认研究目标、股票代码及读取权限。',
    '读取最近可用交易日的行情，保留字段、单位、时点和来源。',
    '比较同一指标、同一单位与口径的数据，列出变化及证据缺口。',
    '保存证据与可复核的研究记录。',
  ];
  thread.clarification = scopeNote;
}

let recovered = false;
for (const thread of state.threads) {
  if (thread.status === 'planning') {
    rules(thread, '上一次模型调用中断，当前采用规则计划。');
    thread.status = 'approval';
    log(thread, '已恢复到等待审批。');
    recovered = true;
  } else if (thread.status === 'running') {
    thread.status = 'paused';
    thread.problem = '页面离开时执行中断，可从最近保存的检查点继续。';
    log(thread, thread.problem);
    recovered = true;
  }
}
if (recovered) persist();

function hasTradingInstruction(value) {
  return /(?:该不该|应不应该|要不要|是否应该|值得|建议|推荐|现在能不能).{0,8}(?:买|卖|加仓|减仓|抄底)|(?:买入|卖出|交易|投资|仓位|止损|止盈)(?:建议|指令|信号|点位)|(?:荐股|买点|卖点|满仓|内幕消息|稳赚|保证收益|必涨|必跌)|(?:预测|必然|肯定|一定).{0,12}(?:涨跌|涨停|跌停|上涨|下跌|股价|目标价|收益率)/u.test(value);
}

function clearForm() {
  field('research-form').reset();
  field('objective').setCustomValidity('');
  field('ticker').setCustomValidity('');
}

function useExample() {
  field('objective').value = '比较贵州茅台最近两个交易日的收盘价和成交量，核对变化幅度与数据来源。';
  field('ticker').value = '600519';
  field('objective').setCustomValidity('');
  field('ticker').setCustomValidity('');
  field('objective').focus();
}

async function callApi(thread, path, init, kind, controller) {
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort('timeout'), requestTimeout);
  thread.calls += 1;
  log(thread, '开始调用' + kind + '。');
  persist();
  render();
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const result = await response.json().catch(() => {
      throw new Error(kind + '返回了无法解析的响应（HTTP ' + response.status + '）。');
    });
    if (!response.ok || !result?.ok) {
      const error = new Error(typeof result?.error === 'string' ? result.error : kind + '请求失败（HTTP ' + response.status + '）。');
      error.payload = result;
      throw error;
    }
    return result;
  } catch (error) {
    if (controller.signal.reason === 'timeout') throw new Error(kind + '超过 25 秒，已停止等待。');
    if (error instanceof TypeError && !controller.signal.aborted) throw new Error(kind + '连接失败，请检查工作台服务或网络。');
    throw error;
  } finally {
    const elapsed = Math.round(performance.now() - started);
    clearTimeout(timeout);
    thread.elapsed += elapsed;
    log(thread, kind + '结束，耗时 ' + elapsed + ' 毫秒。');
    persist();
  }
}

async function makeThread(event) {
  event.preventDefault();
  if (operation) return;
  const objective = field('objective').value.trim();
  const ticker = field('ticker').value.trim();
  if (!objective || hasTradingInstruction(objective)) {
    field('objective').setCustomValidity(objective
      ? '请改写为可复核的研究问题，例如核对历史指标变化。工作台只进行研究取证。'
      : '请输入研究目标。');
    field('objective').reportValidity();
    return;
  }
  if (!tickerPattern.test(ticker)) {
    field('ticker').setCustomValidity('请输入六位沪深 A 股代码，支持 000、001、002、003、300、301、600、601、603、605、688 和 689 前缀。');
    field('ticker').reportValidity();
    return;
  }
  if (state.threads.length >= 24) {
    field('objective').setCustomValidity('本机已有 24 个线程，请先打开并移除旧线程。');
    field('objective').reportValidity();
    return;
  }
  const useModel = field('use-model').checked;
  const thread = {
    id: crypto.randomUUID(),
    objective,
    ticker,
    status: useModel ? 'planning' : 'approval',
    proposals: [],
    cursor: 0,
    calls: 0,
    elapsed: 0,
    attempts: 0,
    logs: [],
    created: clock(),
    usage: null,
    prior: state.memories.find((item) => item.ticker === ticker) ?? null,
  };
  state.threads.unshift(thread);
  state.active = thread.id;
  log(thread, '已记录研究目标和标的。');
  if (!useModel) {
    rules(thread, '未发起模型调用，使用固定研究步骤。');
    checkpoint(thread, 0, '计划已生成，等待行情读取审批。');
    return;
  }
  operation = { id: thread.id, type: 'plan', controller: new AbortController() };
  persist();
  render();
  try {
    const result = await callApi(thread, '/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective, ticker }),
    }, '模型规划', operation.controller);
    const steps = Array.isArray(result.steps)
      ? result.steps.map((step) => step?.title).filter((title) => typeof title === 'string' && title.trim() && !hasTradingInstruction(title))
      : [];
    const clarification = typeof result.clarification === 'string' && !hasTradingInstruction(result.clarification)
      ? result.clarification.trim().slice(0, 300)
      : '';
    if (!result.model || typeof result.model !== 'string' || (!steps.length && !clarification)) {
      rules(thread, '后端未返回可执行的模型计划，已切换为规则计划。');
    } else {
      const usedRules = result.model === '规则引擎';
      thread.planner = {
        name: usedRules ? '规则计划' : result.model.slice(0, 100),
        detail: result.warning || '模型仅提出研究步骤，取证受白名单和审批约束。',
      };
      thread.usage = result.usage ?? null;
      thread.proposals = steps.slice(0, 6).map((title) => title.trim().slice(0, 160));
      thread.clarification = [scopeNote, clarification].filter(Boolean).join(' ');
    }
  } catch (error) {
    rules(thread, '模型规划未完成，已切换为规则计划。' + error.message);
    log(thread, '模型未用于生成当前计划。');
  } finally {
    operation = undefined;
    thread.status = 'approval';
    checkpoint(thread, 0, '计划已保存，等待行情读取审批。');
  }
}

function prepareEvidence(result) {
  if (!Array.isArray(result.facts)) throw new Error('行情响应缺少证据字段。');
  if (!result.facts.length) throw new Error('未返回可核对的行情证据。请检查股票代码、交易时点或数据源状态。');
  const facts = result.facts.filter((fact) =>
    fact && typeof fact.label === 'string' && typeof fact.unit === 'string' &&
    typeof fact.value === 'number' && Number.isFinite(fact.value) &&
    (typeof fact.period === 'string' || typeof fact.end === 'string'));
  if (!facts.length) throw new Error('行情响应中的字段、数值或报告期无法核验。');
  return {
    company: typeof result.company === 'string' ? result.company : result.ticker,
    ticker: result.ticker,
    source: typeof result.source === 'string' ? result.source : '来源未返回',
    sourceUrl: result.sourceUrl,
    retrievedAt: result.retrievedAt,
    facts: facts.slice(0, 80).map((fact, index) => ({
      id: typeof fact.id === 'string' ? fact.id : 'E' + (index + 1),
      label: fact.label.slice(0, 120),
      value: fact.value,
      unit: fact.unit.slice(0, 30),
      period: fact.period || fact.end,
      start: fact.start,
      end: fact.end,
      filed: fact.filed,
      form: fact.form,
      accession: fact.accession,
      sourceUrl: fact.sourceUrl,
      source: fact.source,
      concept: fact.concept,
      basis: fact.basis,
      observedAt: fact.observedAt ?? fact.asOf,
      retrievedAt: fact.retrievedAt,
      raw: fact.raw,
      rawField: fact.rawField,
      rawUnit: fact.rawUnit,
      taxonomy: fact.taxonomy,
    })),
    warnings: [
      ...(Array.isArray(result.warnings) ? result.warnings.filter((item) => typeof item === 'string').slice(0, 10) : []),
      ...(facts.length < result.facts.length ? ['部分证据缺少可核验字段，已从计算中排除。'] : []),
    ],
    sourceReports: sourceSummaries(result.sourceReports),
    crossCheck: result.crossCheck,
    dataPolicy: result.dataPolicy,
    usage: result.usage ?? null,
  };
}

function sourceSummaries(reports) {
  if (!Array.isArray(reports)) return [];
  return reports.filter((source) => source && typeof source.source === 'string').slice(0, 5).map((source) => ({
    source: source.source,
    sourceUrl: source.sourceUrl,
    ok: source.ok,
    retrievedAt: source.retrievedAt,
    elapsedMs: source.elapsedMs,
    error: source.error,
  }));
}

function recordDataUsage(thread, result) {
  const usage = result?.usage;
  if (!Number.isSafeInteger(usage?.calls) || usage.calls < 0) return;
  const previous = thread.dataUsage ?? { calls: 0, elapsedMs: 0 };
  const elapsed = Number.isFinite(usage.elapsedMs) && usage.elapsedMs >= 0 ? usage.elapsedMs : 0;
  thread.dataUsage = { calls: previous.calls + usage.calls, elapsedMs: previous.elapsedMs + elapsed };
}

function dateKey(fact) {
  return String(fact.end || fact.period).match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0];
}

function comparableFacts(facts, crossCheck) {
  const groups = new Map();
  for (const fact of facts) {
    if (!dateKey(fact)) continue;
    const key = [fact.concept || fact.label, fact.unit, fact.basis || fact.form || ''].join('|');
    if (!groups.has(key)) groups.set(key, new Map());
    const byDate = groups.get(key);
    const date = dateKey(fact);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(fact);
  }
  const comparisons = [];
  const gaps = [];
  for (const dates of groups.values()) {
    const dated = [...dates.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-2);
    const label = dated[0][1][0].label;
    if (dated.length < 2) {
      gaps.push(label + '缺少第二个同口径时点。');
      continue;
    }
    if (dated.some(([, values]) => new Set(values.map(({ value }) => value)).size > 1)) {
      gaps.push(label + '同一时点存在不同数值，保留证据等待核对。');
      continue;
    }
    if (/收盘/u.test(label) && dated.some(([date]) => crossCheck?.conflicts?.some((item) => item.date === date))) {
      gaps.push(label + '存在来源冲突，暂不计算变化。');
      continue;
    }
    const [base, current] = dated.map(([, values]) => values[0]);
    const delta = current.value - base.value;
    comparisons.push({ label, base, current, delta, percent: base.value > 0 ? delta / base.value * 100 : null });
  }
  if (!comparisons.length && !gaps.length) gaps.push('返回证据缺少可比较的时点或口径。');
  return { comparisons, gaps };
}

function targetFields(objective, comparisons) {
  const requests = [
    [/收盘/u, /收盘/u],
    [/开盘/u, /开盘/u],
    [/最高/u, /最高/u],
    [/最低/u, /最低/u],
    [/成交量/u, /成交量/u],
    [/成交额/u, /成交额/u],
  ];
  const wanted = requests.filter(([keyword]) => keyword.test(objective));
  const selected = wanted.length
    ? comparisons.filter((item) => wanted.some(([, label]) => label.test(item.label)))
    : comparisons;
  return {
    selected,
    missing: wanted.filter(([, label]) => !selected.some((item) => label.test(item.label))).map(([, label]) => label.source),
  };
}

function unavailablePeriod(objective, facts) {
  const available = new Set(facts.map(dateKey).filter(Boolean));
  const dates = [...objective.matchAll(/(?<!\d)(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?!\d)/gu)];
  if (dates.some(([, year, month, day]) => !available.has(year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0')))) {
    return true;
  }
  const rest = objective.replace(/(?<!\d)\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?(?!\d)/gu, '');
  return /(?:\d{4}年|(?<!\d)\d{4}[-/.]\d{1,2}(?!\d)|上周|上月|上季度|去年|本周|本月|本季度|今年|(?:近|过去|最近)\s*(?:[3-9]|[1-9]\d+|三|四|五|六|七|八|九|十|百)\s*(?:个)?(?:交易日|天|日|周|月|年))/u.test(rest);
}

function makeAnalysis(thread) {
  const { comparisons, gaps } = comparableFacts(thread.evidence.facts, thread.evidence.crossCheck);
  const { selected, missing } = targetFields(thread.objective, comparisons);
  const unsupported = /财报|利润|净利|收入|主营|营收|现金流|财年|估值|分红|毛利|政策|市场份额|原因|归因|为什么|基本面|公告|资金流|行业/u.test(thread.objective);
  const limits = [...gaps, ...thread.evidence.warnings];
  if (missing.length) limits.push('缺少可比较的目标指标：' + missing.join('、') + '。');
  if (unsupported) limits.push('当前证据覆盖公开历史行情，目标中的基本面或因果判断仍待财报、公告等材料支持。');
  if (unavailablePeriod(thread.objective, thread.evidence.facts)) {
    limits.push('目标指定的历史期间未全部覆盖，当前只列出最近两个可用交易日的结果。');
  }
  const latest = thread.evidence.facts.map(dateKey).filter(Boolean).sort().at(-1);
  let continuity = '';
  if (thread.prior?.latest && latest) {
    if (latest < thread.prior.latest) {
      limits.push('本次证据的最近日期早于已保存摘要，需要核对数据时点。');
    } else if (latest === thread.prior.latest) {
      continuity = '最近交易日与已保存摘要一致（' + latest + '），未见更新交易日。';
    } else {
      continuity = '最近交易日从已保存摘要的 ' + thread.prior.latest + ' 更新为 ' + latest + '。';
    }
  }
  return { comparisons: selected, limits, continuity, producedAt: clock() };
}

async function run(thread) {
  if (operation || !['approval', 'paused', 'failed'].includes(thread.status)) return;
  if (thread.cursor < 2 && thread.attempts >= maxAttempts) {
    thread.status = 'failed';
    thread.problem = '已达到三次行情读取上限。可新建线程，修改研究问题或标的。';
    persist();
    render();
    return;
  }
  const resume = thread.status !== 'approval';
  thread.status = 'running';
  thread.problem = '';
  thread.sourceErrors = [];
  const controller = new AbortController();
  operation = { id: thread.id, type: 'run', controller };
  if (thread.cursor === 0) {
    thread.approvedAt = clock();
    checkpoint(thread, 1, '已审批只读行情访问。');
  } else {
    log(thread, resume ? '从检查点继续执行。' : '开始执行已审批计划。');
    persist();
    render();
  }
  try {
    if (thread.cursor < 2) {
      thread.attempts += 1;
      const result = await callApi(thread, '/api/company?ticker=' + encodeURIComponent(thread.ticker), {}, '行情取证', controller);
      if (controller.signal.aborted) return;
      recordDataUsage(thread, result);
      if (result.ticker !== thread.ticker) throw new Error('返回标的与已审批代码不一致。');
      thread.evidence = prepareEvidence(result);
      checkpoint(thread, 2, '已保存真实行情和来源。');
    }
    if (controller.signal.aborted) return;
    if (thread.cursor < 3) {
      thread.analysis = makeAnalysis(thread);
      checkpoint(thread, 3, '已完成确定性比较与证据缺口检查。');
    }
    thread.status = thread.analysis.comparisons.length && !thread.analysis.limits.length ? 'completed' : 'partial';
    checkpoint(thread, 4, '研究产物已生成。');
  } catch (error) {
    if (controller.signal.reason === 'user-stop') return;
    recordDataUsage(thread, error.payload);
    thread.sourceErrors = sourceSummaries(error.payload?.sourceReports).filter((item) => !item.ok);
    thread.status = 'failed';
    thread.problem = error.message;
    log(thread, '执行失败。' + error.message);
  } finally {
    operation = undefined;
    persist();
    render();
  }
}

function pause(thread) {
  if (operation?.id !== thread.id || operation.type !== 'run') return;
  operation.controller.abort('user-stop');
  thread.status = 'paused';
  thread.problem = '已停止后续步骤，成功检查点已保留。';
  log(thread, '用户停止本次执行。');
  persist();
  render();
}

function select(thread) {
  state.active = thread.id;
  field('objective').value = thread.objective;
  field('ticker').value = thread.ticker;
  field('objective').setCustomValidity('');
  field('ticker').setCustomValidity('');
  persist();
  render();
}

function archive(thread) {
  if (operation || !window.confirm('移除此线程及其中的本机记录？已保存的长期记忆将保留。')) return;
  state.threads = state.threads.filter((item) => item.id !== thread.id);
  state.active = state.threads[0]?.id ?? null;
  if (state.threads[0]) select(state.threads[0]);
  else {
    clearForm();
    persist();
    render();
  }
}

function labelValue(list, label, value) {
  list.append(create('dt', label), create('dd', value));
}

function summaryFor(thread) {
  const result = thread.analysis?.comparisons.map((item) =>
    item.label + ' ' + dateKey(item.base) + ' 至 ' + dateKey(item.current) + '，差额 ' +
    numberFormat.format(item.delta) + ' ' + item.current.unit + '，证据 ' + item.base.id + '、' + item.current.id
  ).join('；') ?? '';
  return [thread.ticker + ' ' + thread.objective, result, thread.analysis?.limits[0] ?? ''].filter(Boolean).join('\n').slice(0, 780);
}

function pinMemory(thread) {
  const existing = state.memories.findIndex((memory) => memory.threadId === thread.id);
  const latest = thread.evidence.facts.map(dateKey).filter(Boolean).sort().at(-1);
  const item = { threadId: thread.id, ticker: thread.ticker, latest, summary: summaryFor(thread), at: clock() };
  if (existing >= 0) state.memories.splice(existing, 1);
  state.memories.unshift(item);
  if (state.memories.length > 20) state.memories.pop();
  log(thread, '已将压缩研究摘要保存到本机长期记忆。');
  persist();
  render();
}

function renderRail() {
  const threads = field('threads');
  threads.replaceChildren();
  if (!state.threads.length) threads.append(create('p', '暂无研究线程', 'subtle'));
  for (const thread of state.threads) {
    const button = action('', () => select(thread), 'thread');
    button.setAttribute('aria-current', thread.id === state.active ? 'true' : 'false');
    button.append(create('span', thread.ticker + ' · ' + statusText[thread.status], 'thread-symbol'));
    button.append(create('span', thread.objective, 'thread-title'));
    threads.append(button);
  }
  const memories = field('memories');
  memories.replaceChildren();
  if (!state.memories.length) memories.append(create('p', '从研究产物保存摘要。', 'subtle'));
  for (const memory of state.memories) {
    const card = create('details', undefined, 'memory-card');
    card.append(create('summary', memory.ticker + ' · ' + when(memory.at)));
    card.append(create('p', memory.summary));
    card.append(action('移除记忆', () => {
      state.memories = state.memories.filter((item) => item.threadId !== memory.threadId);
      persist();
      render();
    }, 'secondary compact'));
    memories.append(card);
  }
}

function renderPlan(thread) {
  const status = field('task-status');
  status.textContent = statusText[thread.status];
  status.className = 'status ' + thread.status;
  field('active-goal').textContent = thread.ticker + ' · ' + thread.objective;
  field('plan-origin').textContent = thread.planner
    ? thread.planner.name + ' · ' + thread.planner.detail
    : '正在请求模型规划。';
  field('proposals').replaceChildren(...thread.proposals.map((step) => create('li', step)));
  const clarification = field('clarification');
  clarification.hidden = thread.status === 'planning';
  clarification.textContent = '审批范围 · ' + (thread.clarification || scopeNote);
  if (thread.prior) {
    clarification.textContent += ' 已载入同标的本机研究摘要，取证后核对最新交易日是否变化。';
  }
  const steps = stageTitles.map((title, index) => {
    let description = '待执行';
    let className = '';
    if (thread.cursor > index) {
      description = '完成';
      className = 'completed';
    } else if (thread.cursor === index) {
      description = statusText[thread.status];
      className = thread.status;
    }
    const node = create('li', undefined, 'step');
    node.append(create('span', title), create('span', description, 'status ' + className));
    return node;
  });
  field('steps').replaceChildren(...steps);
  const error = field('task-error');
  error.hidden = !thread.problem;
  error.textContent = thread.problem ?? '';
  const sourceErrors = field('source-errors');
  sourceErrors.hidden = !thread.sourceErrors?.length;
  sourceErrors.replaceChildren(...(thread.sourceErrors ?? []).map(sourceLine));
  const actions = field('task-actions');
  actions.replaceChildren();
  if (thread.status === 'approval') {
    const approve = action('批准只读取证并执行', () => run(thread));
    approve.disabled = Boolean(operation);
    actions.append(approve);
  }
  if (thread.status === 'running') actions.append(action('停止执行', () => pause(thread), 'secondary'));
  if (['failed', 'paused'].includes(thread.status) && (thread.cursor >= 2 || thread.attempts < maxAttempts)) {
    const retry = action('从检查点继续', () => run(thread));
    retry.disabled = Boolean(operation);
    actions.append(retry);
  }
  if (!operation && thread.status !== 'running') {
    actions.append(action('编辑目标并另建线程', () => field('objective').focus(), 'secondary'));
    actions.append(action('移除线程', () => archive(thread), 'secondary'));
  }
}

function validLink(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function evidenceIndex(thread, id) {
  return thread.evidence.facts.findIndex((fact) => fact.id === id) + 1;
}

function addEvidenceLink(node, thread, id) {
  const item = create('a', id);
  item.href = '#evidence-' + evidenceIndex(thread, id);
  item.addEventListener('click', () => {
    const entry = document.getElementById(item.hash.slice(1));
    if (entry) entry.open = true;
  });
  node.append(item);
}

function sourceLine(source) {
  const note = create('p', undefined, 'subtle');
  const link = validLink(source.sourceUrl);
  if (link) {
    const anchor = create('a', source.source);
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    note.append(anchor);
  } else {
    note.append(document.createTextNode(source.source || '来源'));
  }
  note.append(document.createTextNode(' · ' + (source.ok ? '已响应' : '未取得有效数据') +
    (source.error ? ' · ' + source.error : '') +
    (Number.isFinite(source.elapsedMs) ? ' · ' + source.elapsedMs + ' 毫秒' : '') +
    (source.retrievedAt ? ' · ' + when(source.retrievedAt) : '')));
  return note;
}

function renderEvidence(thread) {
  const data = thread.evidence;
  field('evidence-panel').hidden = !data;
  if (!data) return;
  field('evidence-count').textContent = data.facts.length + ' 条';
  field('source-summary').textContent = data.company + ' · ' + data.ticker + ' · ' +
    data.source + ' · 获取时间 ' + when(data.retrievedAt);
  const container = field('evidence');
  container.replaceChildren();
  if (typeof data.dataPolicy?.tradingDate === 'string') {
    container.append(create('p', data.dataPolicy.tradingDate, 'subtle'));
  }
  for (const note of data.warnings) container.append(create('p', note, 'notice problem'));
  container.append(...data.sourceReports.map(sourceLine));
  if (data.crossCheck?.matches?.length) {
    container.append(create('p', '双来源收盘价相符 · ' + data.crossCheck.matches.join('、'), 'subtle'));
  }
  for (const conflict of data.crossCheck?.conflicts ?? []) {
    container.append(create('p', conflict.date + ' 收盘价冲突 · 主来源 ' + conflict.primaryClose + ' ' + conflict.unit +
      ' / 对照来源 ' + conflict.secondaryClose + ' ' + conflict.unit, 'notice problem'));
  }
  for (const [index, fact] of data.facts.entries()) {
    const entry = create('details', undefined, 'evidence-entry');
    entry.id = 'evidence-' + (index + 1);
    entry.append(create('summary', fact.id + ' · ' + fact.label + ' · ' + numberFormat.format(fact.value) +
      ' ' + fact.unit + ' · ' + fact.period));
    const dl = create('dl');
    labelValue(dl, '标准化字段', String(fact.concept ?? fact.label));
    labelValue(dl, '标准化数值', String(fact.value) + ' ' + fact.unit);
    if (fact.rawField) labelValue(dl, '原始字段', String(fact.rawField));
    if (fact.raw !== null && fact.raw !== undefined) {
      labelValue(dl, '原始数值', String(fact.raw) + (fact.rawUnit ? ' ' + fact.rawUnit : '（原单位未提供）'));
    }
    labelValue(dl, '数据时点', fact.observedAt || fact.period);
    labelValue(dl, '获取时间', when(fact.retrievedAt || data.retrievedAt));
    labelValue(dl, '口径', fact.basis || fact.form || '来源未单独说明');
    if (fact.filed) labelValue(dl, '披露日期', fact.filed);
    if (fact.accession) labelValue(dl, '来源标识', fact.accession);
    const link = validLink(fact.sourceUrl || data.sourceUrl);
    const sourceLabel = String(fact.source || data.source);
    const dd = create('dd');
    if (link) {
      const anchor = create('a', sourceLabel);
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      dd.append(anchor);
    } else {
      dd.textContent = sourceLabel;
    }
    dl.append(create('dt', '原始来源'), dd);
    entry.append(dl);
    container.append(entry);
  }
}

function deltaText(item) {
  const difference = (item.delta > 0 ? '+' : '') + numberFormat.format(item.delta) + ' ' + item.current.unit;
  const percent = item.percent === null
    ? '，基期非正值，变化率省略'
    : '（' + (item.percent > 0 ? '+' : '') + item.percent.toFixed(2) + '%）';
  return difference + percent;
}

function renderReport(thread) {
  const report = field('report');
  const actions = field('report-actions');
  field('artifact-panel').hidden = !thread.analysis;
  if (!thread.analysis) return;
  report.replaceChildren();
  const analysis = thread.analysis;
  if (!analysis.comparisons.length) report.append(create('p', '目前没有可计算的同口径比较。', 'notice problem'));
  for (const item of analysis.comparisons) {
    const line = create('p', undefined, 'result-line');
    line.append(create('strong', item.label + ' '));
    line.append(document.createTextNode(item.base.period + ' ' + numberFormat.format(item.base.value) + ' → ' +
      item.current.period + ' ' + numberFormat.format(item.current.value) + '，差额 ' + deltaText(item) + '。证据 '));
    addEvidenceLink(line, thread, item.base.id);
    line.append(document.createTextNode('、'));
    addEvidenceLink(line, thread, item.current.id);
    report.append(line);
  }
  if (analysis.limits.length) {
    const list = create('ul', undefined, 'result-boundary');
    list.append(...analysis.limits.map((item) => create('li', item)));
    report.append(list);
  }
  if (analysis.continuity) report.append(create('p', '同标的记忆核对 · ' + analysis.continuity, 'subtle'));
  report.append(create('p', '差额＝末期值－基期值。变化率＝差额÷基期值×100%。比较只涉及已列证据与期间。', 'result-boundary'));
  const saved = state.memories.some((item) => item.threadId === thread.id);
  actions.replaceChildren(
    action('下载研究记录', () => downloadReport(thread)),
    action(saved ? '更新长期记忆' : '保存到长期记忆', () => pinMemory(thread), 'secondary'),
  );
}

function mdCell(value) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').replace(/[|\\]/gu, '\\$&');
}

function downloadReport(thread) {
  const analysis = thread.analysis;
  const evidence = thread.evidence;
  const rows = evidence.facts.map((fact) => '| ' + [
    fact.id, fact.label, fact.concept || fact.label, fact.value, fact.unit, fact.rawField,
    fact.raw, fact.rawUnit || '未提供', fact.period,
    fact.filed || '未提供', fact.basis || fact.form || '未提供', fact.source || evidence.source,
    validLink(fact.sourceUrl || evidence.sourceUrl) || '',
  ].map(mdCell).join(' | ') + ' |');
  const lines = [
    '# ' + mdCell(evidence.company) + ' · ' + thread.ticker + ' 研究记录',
    '',
    '研究目标：' + mdCell(thread.objective),
    '',
    '取证时间：' + (evidence.retrievedAt || '未提供'),
    '',
    '产出时间：' + analysis.producedAt,
    '',
    '## 比较',
    '',
    ...analysis.comparisons.map((item) => '- ' + item.label + '：' + item.base.period + ' ' + item.base.value +
      ' → ' + item.current.period + ' ' + item.current.value + '，差额 ' + deltaText(item) +
      '。证据 ' + item.base.id + '、' + item.current.id + '。'),
    ...(analysis.comparisons.length ? [] : ['暂无可计算的同口径比较。']),
    '',
    '差额＝末期值－基期值。变化率＝差额÷基期值×100%。',
    '',
    '## 证据',
    '',
    '| 编号 | 指标 | 标准化字段 | 标准化值 | 标准化单位 | 原始字段 | 原始值 | 原始单位 | 期间 | 披露日 | 口径 | 来源 | 链接 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 证据缺口与研究范围',
    '',
    ...analysis.limits.map((item) => '- ' + mdCell(item)),
    ...(evidence.dataPolicy?.tradingDate ? ['- 数据截止规则：' + mdCell(evidence.dataPolicy.tradingDate)] : []),
    ...(analysis.continuity ? ['- 同标的记忆核对：' + analysis.continuity] : []),
    ...(evidence.crossCheck?.matches?.length
      ? ['- 双来源收盘价相符日期：' + evidence.crossCheck.matches.join('、')]
      : []),
    ...(evidence.crossCheck?.conflicts ?? []).map((item) => '- ' + item.date + ' 收盘价冲突：' +
      item.primaryClose + ' / ' + item.secondaryClose + ' ' + item.unit),
    '- 结果只反映已列历史行情和证据期间。',
  ];
  const blobUrl = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  const link = create('a');
  link.href = blobUrl;
  link.download = thread.ticker + '-research.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
}

function renderTrace(thread) {
  const stats = field('stats');
  const tokens = thread.usage?.total_tokens ?? thread.usage?.totalTokens;
  const cost = thread.usage?.costUsd ?? thread.usage?.cost_usd ?? thread.usage?.cost;
  const upstreamCalls = thread.dataUsage?.calls ?? thread.evidence?.usage?.calls;
  stats.replaceChildren();
  for (const [label, value] of [
    ['应用请求次数', String(thread.calls)],
    ['数据源已记录调用', Number.isInteger(upstreamCalls) ? String(upstreamCalls) : '无已记录调用'],
    ['行情尝试', thread.attempts + '/' + maxAttempts],
    ['累计请求耗时', (thread.elapsed / 1000).toFixed(2) + ' 秒'],
    ['模型用量', tokens !== undefined ? tokens + ' tokens' : thread.usage ? '上游未提供' : '无已记录用量'],
    ['模型费用', cost === 0 ? '0' : typeof cost === 'number' ? '$' + cost : thread.usage ? '上游未提供' : '无已记录费用'],
  ]) {
    const item = create('div');
    labelValue(item, label, value);
    stats.append(item);
  }
  field('checkpoint').textContent = thread.checkpoint
    ? '最近检查点 · ' + when(thread.checkpoint.at) + ' · ' + thread.checkpoint.message
    : '等待保存第一个检查点。';
  const context = [
    '当前线程摘要 · ' + summaryFor(thread),
    ...(thread.prior ? ['建档时载入的同标的研究摘要 · ' + thread.prior.summary] : []),
    '摘要与历史记忆共保留至多 1600 字，原始证据保存在本机。摘要只用于核对研究衔接。',
  ].join('\n\n');
  field('context').textContent = context.slice(0, 1540) +
    (context.length > 1540 ? '\n\n已达到摘要长度上限，完整证据仍可展开。' : '');
  field('logs').replaceChildren(...thread.logs.map((event) => {
    const item = create('li', undefined, 'log');
    const time = create('time', when(event.at));
    time.dateTime = event.at;
    item.append(create('span', event.message), time);
    return item;
  }));
}

function render() {
  renderNotice();
  renderRail();
  field('plan-button').disabled = Boolean(operation);
  field('new-thread').disabled = Boolean(operation);
  const thread = activeThread();
  field('active-thread').hidden = !thread;
  if (!thread) return;
  renderPlan(thread);
  renderEvidence(thread);
  renderReport(thread);
  renderTrace(thread);
}

field('research-form').addEventListener('submit', makeThread);
field('example-button').addEventListener('click', useExample);
for (const id of ['objective', 'ticker']) {
  field(id).addEventListener('input', (event) => event.target.setCustomValidity(''));
}
field('new-thread').addEventListener('click', () => {
  if (operation) return;
  state.active = null;
  clearForm();
  persist();
  render();
  field('objective').focus();
});

if (activeThread()) select(activeThread());
else render();

