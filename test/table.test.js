import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bid, deal } from '../src/table/round.js';
import { decodeTable, encodeTable } from '../src/table/save.js';

class Element extends EventTarget {
  children = [];
  dataset = {};
  style = { setProperty() {} };
  classList = { toggle() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  click() { this.dispatchEvent(new Event('click')); }
}

let instance = 0;
async function openTable(t, { snapshot = null, legacy = null, models = [], choose, hostVisible = true } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const listeners = [];
  const emit = (message) => listeners.forEach((listener) => listener(message));
  const sent = [];
  const window = new EventTarget();
  window.finch = {
    onMessage(listener) { listeners.push(listener); },
    postMessage(message) {
      sent.push(message);
      const result = {
        'quedou:load': () => ({ snapshot, visible: hostVisible }),
        'quedou:list': () => ({ models }),
        'quedou:save': () => ({ saved: true }),
        'quedou:choose': () => choose?.(message),
      }[message.type]?.();
      if (result) queueMicrotask(() => emit({ type: 'quedou:reply', id: message.id, result }));
    },
  };
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: get, createElement: () => new Element() });
  for (const [key, value] of Object.entries({ window, document, localStorage: { getItem: () => legacy } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  await import(`../src/table/table.js?test=${instance++}`);
  await new Promise(setImmediate);
  return { get, sent, emit, document };
}

const flash = { modelKey: 'demo:flash', name: 'Flash', providerName: 'Demo', instant: true };
const slow = { modelKey: 'demo:slow', name: 'Slow', providerName: 'Demo' };

test('no usable model means no start button and no model invocation', async (t) => {
  const { get, sent } = await openTable(t);
  assert.equal(get('status').textContent, '请选择模型对手');
  assert.deepEqual(sent.map(({ type }) => type), ['quedou:load', 'quedou:list']);
});

test('default fills both opponents from Finch without calling a model before a game', async (t) => {
  const { get, sent } = await openTable(t, { models: [slow, flash] });
  assert.ok(get('center-content').children.some((node) => node.textContent === '开始游戏'));
  const saved = decodeTable(sent.find(({ type }) => type === 'quedou:save').snapshot);
  assert.deepEqual(saved.opponents, [null, flash, flash]);
  assert.equal(saved.state, null);
  assert.ok(!sent.some(({ type }) => type === 'quedou:choose'));
});

test('restored round stays unchanged after a model error, and retry continues the same turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = bid(deal(() => 0.42, 0), 0, 1);
  const snapshot = encodeTable({ state, roundNumber: 7, opponents: [null, flash, flash], selected: [], hintIndex: 0 });
  let attempts = 0;
  const { get, sent } = await openTable(t, { snapshot, choose: () => ++attempts === 1 ? { error: 'unavailable' } : { index: 0 } });
  assert.equal(get('round-number').textContent, '07');
  assert.equal(get('hand').children.length, 17);
  t.mock.timers.tick(650);
  await new Promise(setImmediate);
  assert.match(get('status').textContent, /模型不可用 · 牌局已保留/);
  assert.ok(!sent.some(({ type }) => type === 'quedou:save'));
  t.mock.timers.tick(650);
  assert.equal(attempts, 1);
  get('center-content').children.find((node) => node.textContent === '重试本手').click();
  t.mock.timers.tick(650);
  await new Promise(setImmediate);
  const choices = sent.filter(({ type }) => type === 'quedou:choose');
  assert.deepEqual(choices[0].spec, choices[1].spec);
  const saved = decodeTable(sent.find(({ type }) => type === 'quedou:save').snapshot);
  assert.deepEqual(saved.state, bid(state, 1, 0));
});

test('a stale host visibility value does not block restored bidding or its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const state = bid(deal(() => 0.42, 0), 0, 0);
  const snapshot = encodeTable({ state, roundNumber: 1, opponents: [null, flash, flash], selected: [], hintIndex: 0 });
  const { get, sent, document, emit } = await openTable(t, { snapshot, hostVisible: false });
  const requests = () => sent.filter(({ type }) => type === 'quedou:choose');
  assert.equal(get('status').textContent, '等待青雀叫分');
  t.mock.timers.tick(650);
  assert.equal(requests().length, 1);
  assert.match(get('status').textContent, /正在叫分/);
  assert.equal(get('model-wait').hidden, false);
  assert.equal(get('model-wait').textContent, '已等待 0 秒');
  now = 20_000;
  t.mock.timers.tick(1000);
  assert.equal(get('model-wait').textContent, '已等待 20 秒');
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(get('model-wait').hidden, true);
  assert.equal(sent.at(-1).type, 'quedou:cancel');
  emit({ type: 'quedou:reply', id: requests()[0].id, result: { index: 3 } });
  t.mock.timers.tick(1000);
  assert.equal(requests().length, 1);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(650);
  assert.equal(requests().length, 2);
  assert.deepEqual(requests()[0].spec, requests()[1].spec);
  assert.equal(get('model-wait').textContent, '已等待 0 秒');
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
});

test('legacy save is migrated without replacing the hand, bid or round number', async (t) => {
  const state = bid(bid(deal(() => 0.42, 1), 1, 1), 2, 0);
  const legacy = encodeTable({ state, roundNumber: 4, opponents: [null, null, null], selected: [], hintIndex: 0 });
  const { get, sent } = await openTable(t, { legacy, models: [flash] });
  assert.equal(get('status').textContent, '轮到你叫地主');
  const saved = decodeTable(sent.findLast(({ type }) => type === 'quedou:save').snapshot);
  assert.deepEqual(saved.state, state);
  assert.equal(saved.roundNumber, 4);
  assert.deepEqual(saved.opponents, [null, flash, flash]);
});
