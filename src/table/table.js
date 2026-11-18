import { beats, classify, rankOf, RANKS, SUITS, TYPE_NAMES } from './cards.js';
import { bid, bidOptions, deal, move, playerView } from './round.js';
import { orderedMoves } from './computer.js';
import { createModelClient, decisionFor } from './model-client.js';
import { decodeTable, encodeTable, loadTable } from './save.js';

const $ = (id) => document.getElementById(id);
const names = ['你', '青雀', '栗雀'];
let state = null;
let roundNumber = 0;
let timer;
let selected = new Set();
const availableHints = () => state?.phase === 'play' && state.turn === 0 ? orderedMoves(playerView(state, 0)) : [];
let hints = availableHints();
let hintIndex = 0;
const requestModel = createModelClient(window.finch);
let opponents = [null, null, null];
let restoring = true;
let restoreError = false;
let saveSequence = 0;
async function checkpoint() {
  const sequence = ++saveSequence;
  const snapshot = encodeTable({ state, roundNumber, opponents, selected, hintIndex });
  const result = await requestModel('save', { snapshot });
  if (sequence === saveSequence) $('save-error').hidden = result?.saved === true;
}
let pendingModel;
let modelClock;
let catalog = [];
let catalogRequest = 0;
let autopilot = null;
const humanTurn = () => state?.turn === 0 && !autopilot;
const configured = () => Boolean(opponents[1] && opponents[2]);
const modelFor = (seat) => seat === 0 ? autopilot : opponents[seat];
const driverName = (seat) => modelFor(seat)?.name ?? '未选模型';
let modelError;
function retryTurn() {
  modelError = undefined;
  renderCenter();
  scheduleTurn();
}

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(text, action, className = 'secondary', disabled = false) {
  const node = element('button', text, className);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}

function card(id, interactive = false) {
  if (id === null) return element('span', '✦', 'card back');
  const rank = rankOf(id);
  const suit = rank < 13 ? id % 4 : null;
  const red = suit === 1 || suit === 3 || rank === 14;
  const node = element(interactive ? 'button' : 'span', '', `card${red ? ' red' : ''}`);
  node.setAttribute('aria-label', `${suit === null ? '' : SUITS[suit]}${RANKS[rank]}`);
  node.append(element('span', rank < 13 ? RANKS[rank] : rank === 13 ? '小王' : '大王', 'rank'));
  node.append(element('span', suit === null ? '★' : SUITS[suit], 'suit'));
  if (interactive) {
    node.type = 'button';
    node.dataset.card = id;
    node.addEventListener('click', () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      checkpoint();
      updateSelection();
    });
  }
  return node;
}

function row(node, cards, interactive = false) {
  node.style.setProperty('--cards', cards.length);
  node.replaceChildren(...cards.map((id) => card(id, interactive)));
}

function roleBadge(seat) {
  if (state?.landlord == null) return null;
  return state.landlord === seat ? element('span', '地主', 'role-badge landlord') : element('span', '农民', 'role-badge');
}

const bidLabel = (value) => value === 0 ? '不叫' : `${value} 分`;

function lastAction(seat, node) {
  if (state?.phase === 'bid' || state?.phase === 'redeal') {
    const value = state.bids[seat];
    node.replaceChildren(element('span', value === null ? '' : bidLabel(value), 'notice'));
    return;
  }
  const action = state?.last[seat];
  if (!action?.cards.length) {
    node.replaceChildren(element('span', action ? '不出' : '', 'notice'));
    return;
  }
  row(node, action.cards);
}

function renderSeat(seat) {
  const identity = element('div', '', `identity${state?.turn === seat ? ' active' : ''}`);
  const name = element('div', names[seat]);
  const source = driverName(seat);
  const meta = element('small', source);
  meta.title = source;
  name.append(meta);
  identity.append(element('span', seat === 1 ? '♣' : '♦', 'avatar'), name,
    element('strong', state ? `${state.hands[seat].length} 张` : '—', 'count'));
  const last = element('div', '', 'row play-row');
  lastAction(seat, last);
  const header = element('div', '', 'seat-header');
  const badge = roleBadge(seat);
  if (badge) header.append(badge);
  header.append(identity);
  $(`seat-${seat}`).replaceChildren(header, last);
}

function updateModelWait() {
  const elapsed = $('model-wait');
  elapsed.hidden = !pendingModel;
  if (!pendingModel) {
    clearInterval(modelClock);
    modelClock = undefined;
    elapsed.textContent = '';
    return;
  }
  const text = `已等待 ${Math.floor((performance.now() - pendingModel.startedAt) / 1000)} 秒`;
  if (elapsed.textContent !== text) elapsed.textContent = text;
}

function renderCenter() {
  const center = $('center-content');
  const status = $('status');
  status.classList.toggle('model-pending', Boolean(pendingModel));
  updateModelWait();
  if (pendingModel) modelClock ??= setInterval(updateModelWait, 1000);
  center.replaceChildren();
  if (restoring || restoreError) {
    status.textContent = restoring ? '正在恢复牌桌…' : (requestModel ? '无法读取牌局存档' : '请在 Finch 内打开雀斗');
    if (restoreError && requestModel) center.append(button('重试读取', restoreTable, 'primary'));
  } else if (!configured() && !pendingModel) {
    status.textContent = state ? '牌局已保留，等待模型' : '请选择模型对手';
    center.append(element('p', '在右上角「对手」为两个座位选择 Finch 模型。'));
  } else if (!state) {
    status.textContent = '';
    center.append(element('h2', '来一局斗地主'), element('p', '一副牌，两位模型对手。开始后可能消耗模型额度。'), button('开始游戏', () => startRound(), 'primary'));
  } else if (state.phase === 'finished') {
    const { landlordWon, spring, scores } = state.result;
    const won = scores[0] > 0;
    status.textContent = `${landlordWon ? '地主' : '农民'}获胜${spring ? ` · ${landlordWon ? '春天' : '反春天'}` : ''}`;
    center.append(element('h2', won ? '你赢了！' : '这局没赢'),
      element('div', `${scores[0] > 0 ? '+' : ''}${scores[0]} 分`, 'score'),
      element('p', `底分 ${state.bid} × ${state.multiplier} 倍`), button('再来一局', () => startRound(), 'primary'));
  } else if (state.phase === 'redeal') {
    status.textContent = '三家都不叫';
    center.append(button('重新发牌', () => startRound((state.starter + 1) % 3), 'primary'));
  } else if (state.phase === 'bid') {
    status.textContent = humanTurn() ? '轮到你叫地主' : `等待${state.turn === 0 ? '托管' : names[state.turn]}叫分`;
    center.append(element('p', state.bid ? `当前最高：${names[state.bidder]} · ${state.bid} 分` : '叫 1～3 分，或选择不叫'));
  } else {
    status.textContent = humanTurn() ? '轮到你出牌' : `等待${state.turn === 0 ? '托管' : names[state.turn]}出牌`;
    center.append(element('p', state.target
      ? `当前牌：${names[state.target.seat]} · ${TYPE_NAMES[state.target.type]} · ${state.target.length} 张`
      : '自由领出 · 可出任意合法牌型'));
  }
  if (pendingModel) {
    const { seat, model } = pendingModel;
    status.textContent = `${seat === 0 ? '托管' : names[seat]} · ${model.name} ${state.phase === 'bid' ? '正在叫分' : '正在出牌'}…`;
    if (model.modelKey !== modelFor(seat)?.modelKey) {
      center.append(element('p', `该座位下一手：${driverName(seat)}`));
    }
    center.append(button('暂停本手', () => {
      interruptModel();
      modelError = '本手已暂停';
      renderCenter();
    }));
  } else if (modelError && !humanTurn()) {
    status.textContent = `${modelError} · 牌局已保留`;
    center.append(button('重试本手', retryTurn, 'primary'), element('p', '也可在右上角「对手」更换模型。'));
  }
  lastAction(0, $('self-play'));
}

function updateSelection() {
  for (const node of $('hand').children) node.setAttribute('aria-pressed', selected.has(Number(node.dataset.card)));
  const playing = state?.phase === 'play' && humanTurn();
  const play = classify([...selected]);
  const valid = beats(play, state?.target);
  $('selection').textContent = !selected.size ? '' : `已选 ${selected.size} 张 · ${play ? `${TYPE_NAMES[play.type]}${valid ? '' : '（压不过）'}` : '不是合法牌型'}`;
  if (playing) $('play').disabled = !valid;
}

function renderActions() {
  const node = $('actions');
  node.replaceChildren();
  if (state?.phase === 'bid') {
    const options = bidOptions(state);
    for (const value of [0, 1, 2, 3]) {
      node.append(button(bidLabel(value), () => advance(bid(state, 0, value)), value ? 'primary' : 'secondary', !humanTurn() || !options.includes(value)));
    }
  } else if (state?.phase === 'play') {
    const human = humanTurn();
    node.append(button('不出', () => advance(move(state, 0, [])), 'secondary', !human || !state.target),
      button(hints.length ? '提示' : '无牌可压', () => {
        selected = new Set(hints[hintIndex++ % hints.length].cards);
        checkpoint();
        updateSelection();
      }, 'secondary', !human || !hints.length));
    const play = button('出牌', () => advance(move(state, 0, [...selected])), 'primary', true);
    play.id = 'play';
    node.append(play);
  }
}

function render() {
  $('opponents').disabled = restoring || restoreError;
  $('opponents').title = '可随时更换模型';
  $('autopilot').disabled = !configured() || !state || !['bid', 'play'].includes(state.phase);
  $('round-controls').hidden = !state;
  $('round-number').textContent = state ? String(roundNumber).padStart(2, '0') : '—';
  $('multiplier').textContent = `×${state?.multiplier ?? 1}`;
  row($('bottom'), state?.landlord == null ? [null, null, null] : state.bottom);
  $('bottom').setAttribute('aria-label', state?.landlord == null ? '底牌未公开' : '已公开底牌');
  renderSeat(1);
  renderSeat(2);
  renderCenter();
  $('self').classList.toggle('active', state?.turn === 0);
  $('self').replaceChildren(element('strong', '你'), element('small', state ? `${state.hands[0].length} 张` : ''));
  const selfHeader = $('self-header');
  const badge = roleBadge(0);
  selfHeader.replaceChildren(...(badge ? [badge] : []), $('self'));
  $('autopilot').textContent = autopilot ? '取消托管' : '托管';
  const autopilotStatus = $('autopilot-status');
  autopilotStatus.replaceChildren(...(autopilot ? [element('strong', `托管模型：${driverName(0)}`)] : []));
  const playable = state?.phase === 'play' && humanTurn();
  row($('hand'), state?.hands[0] ?? [], playable);
  renderActions();
  updateSelection();
}

function startRound(starter) {
  if (!configured() || restoring || restoreError || settings.open || autopilotSettings.open) return;
  roundNumber++;
  advance(deal(Math.random, starter));
}

function advance(next) {
  if (!next) return;
  clearTimeout(timer);
  state = next;
  modelError = undefined;
  if (state.phase === 'finished') autopilot = null;
  selected = new Set();
  hintIndex = 0;
  checkpoint();
  hints = availableHints();
  render();
  scheduleTurn();
}

function scheduleTurn() {
  clearTimeout(timer);
  if (!state || !configured() || restoring || restoreError || !pageVisible || settings.open || autopilotSettings.open || roundConfirm.open || pendingModel || modelError) return;
  if ((state.phase === 'bid' || state.phase === 'play') && !humanTurn()) timer = setTimeout(runModelTurn, 650);
}

async function runModelTurn() {
  const current = state;
  const seat = current.turn;
  const bidding = current.phase === 'bid';
  const apply = (action) => (bidding ? bid : move)(current, seat, action);
  const model = modelFor(seat);
  if (!model) return;
  const spec = decisionFor(current, seat);
  if (spec.choices.length === 1) return advance(apply(spec.choices[0]));
  const controller = new AbortController();
  const request = { controller, seat, model, startedAt: performance.now() };
  pendingModel = request;
  renderCenter();
  const result = await requestModel('choose', { modelKey: model.modelKey, spec }, controller.signal);
  if (state !== current || pendingModel !== request) return;
  pendingModel = null;
  const index = result?.index;
  const next = Number.isInteger(index) && index >= 0 && index < spec.choices.length ? apply(spec.choices[index]) : null;
  if (next) return advance(next);
  modelError = { unavailable: '模型不可用', cancelled: '本手已暂停' }[result?.error] ?? '模型未提交有效动作';
  renderCenter();
}

const modelOption = (model) => new Option(
  `${model.name} · ${model.providerName}${model.instant ? ' · 快速' : ''}`, model.modelKey);
const sortModels = (models) => [...(models ?? [])].sort((a, b) => Number(Boolean(b.instant)) - Number(Boolean(a.instant)));
const settings = $('opponent-settings');
const opponentModelFor = (seat, key) => catalog.find((model) => model.modelKey === key)
  ?? (opponents[seat]?.modelKey === key ? opponents[seat] : null);
async function openOpponentSettings() {
  if (settings.open) return;
  const ticket = ++catalogRequest;
  catalog = [];
  const fill = () => {
    for (const seat of [1, 2]) {
      const select = $(`model-${seat}`);
      const current = opponents[seat];
      const entries = [...catalog];
      if (current && !entries.some(({ modelKey }) => modelKey === current.modelKey)) entries.push(current);
      select.replaceChildren(...entries.map(modelOption));
      select.value = current?.modelKey ?? entries[0]?.modelKey ?? '';
    }
  };
  fill();
  settings.returnValue = '';
  $('model-status').textContent = requestModel ? '读取 Finch 模型列表…' : '在 Finch 内打开才能选择模型。';
  settings.showModal();
  scheduleTurn();
  $('apply-models').disabled = true;
  for (const seat of [1, 2]) $(`model-${seat}`).disabled = true;
  const result = await requestModel('list');
  if (!settings.open || ticket !== catalogRequest) return;
  catalog = sortModels(result?.models);
  fill();
  for (const seat of [1, 2]) $(`model-${seat}`).disabled = !catalog.length;
  $('apply-models').disabled = !catalog.length;
  $('model-status').textContent = result?.error ? '无法读取模型。请检查小程序的会话权限。'
    : catalog.length ? '使用 Finch 里已启用的模型，两席可选同一个。' : 'Finch 里还没有可用模型。';
}
$('opponents').addEventListener('click', openOpponentSettings);
settings.addEventListener('close', () => {
  catalogRequest++;
  if (settings.returnValue === 'apply' && !$('apply-models').disabled) {
    const updated = [null, ...[1, 2].map((seat) => opponentModelFor(seat, $(`model-${seat}`).value))];
    if (updated[1] && updated[2]) {
      if (state?.turn > 0 && updated[state.turn].modelKey !== opponents[state.turn]?.modelKey) modelError = undefined;
      opponents = updated;
      checkpoint();
    }
  }
  render();
  scheduleTurn();
});
const autopilotSettings = $('autopilot-settings');
const autopilotSelect = $('autopilot-model');
let autopilotModels = [];
let autopilotTicket = 0;
$('autopilot').addEventListener('click', async () => {
  if (autopilot) {
    autopilot = null;
    if (state?.turn === 0) {
      interruptModel();
      modelError = undefined;
    }
    checkpoint();
    render();
    scheduleTurn();
    return;
  }
  const ticket = ++autopilotTicket;
  autopilotModels = [];
  autopilotSelect.replaceChildren();
  $('enable-autopilot').disabled = true;
  autopilotSettings.returnValue = '';
  $('autopilot-model-status').textContent = '正在读取 Finch 模型…';
  autopilotSettings.showModal();
  scheduleTurn();
  if (!requestModel) return;
  const result = await requestModel('list');
  if (!autopilotSettings.open || ticket !== autopilotTicket) return;
  autopilotModels = sortModels(result?.models);
  autopilotSelect.append(...autopilotModels.map(modelOption));
  $('enable-autopilot').disabled = !autopilotModels.length;
  $('autopilot-model-status').textContent = autopilotModels.length ? '' : '暂无可用模型。';
});
autopilotSettings.addEventListener('close', () => {
  autopilotTicket++;
  if (autopilotSettings.returnValue === 'enable') {
    const model = autopilotModels.find(({ modelKey }) => modelKey === autopilotSelect.value);
    if (model) {
      autopilot = model;
      selected.clear();
      hintIndex = 0;
      checkpoint();
    }
  }
  render();
  scheduleTurn();
});
// Use the App View guest lifecycle, not a side-panel visibility snapshot.
let pageVisible = !document.hidden;
function interruptModel() {
  const interrupted = pendingModel;
  pendingModel = null;
  interrupted?.controller.abort();
}
const syncVisibility = () => {
  if (!pageVisible && pendingModel) {
    interruptModel();
    renderCenter();
  }
  scheduleTurn();
};
document.addEventListener('visibilitychange', () => { pageVisible = !document.hidden; syncVisibility(); });
window.addEventListener('pageshow', () => { pageVisible = !document.hidden; syncVisibility(); });
window.addEventListener('pagehide', () => {
  pageVisible = false;
  syncVisibility();
});

const roundConfirm = $('round-confirm');
let roundCommand;
function confirmRound(command) {
  if (!state || roundConfirm.open) return;
  roundCommand = command;
  const restart = command === 'restart';
  const label = restart ? '重新开始' : '退出对局';
  $('round-confirm-title').textContent = label;
  $('round-confirm-action').textContent = label;
  $('round-confirm-detail').textContent = restart
    ? '当前牌局将结束，并重新发牌。对手设置会保留。'
    : '当前牌局将结束，无法继续这局。对手设置会保留。';
  roundConfirm.returnValue = '';
  roundConfirm.showModal();
  scheduleTurn();
}
$('restart-round').addEventListener('click', () => confirmRound('restart'));
$('exit-round').addEventListener('click', () => confirmRound('exit'));
roundConfirm.addEventListener('close', () => {
  const command = roundCommand;
  roundCommand = undefined;
  if (roundConfirm.returnValue !== 'confirm' || !command) return scheduleTurn();
  clearTimeout(timer);
  interruptModel();
  autopilot = null;
  if (command === 'restart') return startRound();
  state = null;
  roundNumber = 0;
  selected.clear();
  hintIndex = 0;
  hints = [];
  modelError = undefined;
  checkpoint();
  render();
  $('center-content').querySelector('button')?.focus();
});

async function restoreTable() {
  restoring = true;
  restoreError = false;
  render();
  const result = await requestModel?.('load');
  const saved = result?.snapshot === null ? loadTable() : decodeTable(result?.snapshot);
  if (!result || result.error || (result.snapshot !== null && !saved)) {
    restoring = false;
    restoreError = true;
    render();
    return;
  }
  state = saved?.state ?? null;
  roundNumber = saved?.roundNumber ?? 0;
  selected = new Set(saved?.selected);
  hintIndex = saved?.hintIndex ?? 0;
  opponents = saved?.opponents ?? [null, null, null];
  hints = availableHints();
  if (saved && result.snapshot === null) checkpoint();
  if (!configured()) {
    const { models } = await requestModel('list') ?? {};
    const [defaultModel] = sortModels(models);
    if (defaultModel) {
      opponents[1] ??= defaultModel;
      opponents[2] ??= defaultModel;
      checkpoint();
    }
  }
  restoring = false;
  render();
  syncVisibility();
}

$('save-error').addEventListener('click', checkpoint);
$('help').addEventListener('click', () => $('rules').showModal());
void restoreTable();
