import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { activate } from '../src/index.cjs';
import host from '../src/model-host.cjs';
import { createModelClient, decisionFor } from '../src/table/model-client.js';
import { bid, deal, move } from '../src/table/round.js';

const bidSpec = (seat = 1) => ({ seat, hand: [0, 1], counts: [0, 1, 2].map((i) => i === seat ? 2 : 17), bid: 0, phase: 'bid', choices: [0, 1, 2, 3], played: [], playedIncomplete: false });

test('decision snapshot exposes only own and public cards; every candidate is legal', () => {
  const initial = deal(() => 0.4, 1);
  const bidding = decisionFor(initial, 1);
  assert.deepEqual(bidding.hand, initial.hands[1]);
  assert.deepEqual(Object.keys(bidding).sort(), ['bid', 'choices', 'counts', 'hand', 'landlord', 'phase', 'played', 'playedIncomplete', 'seat', 'target']);
  const game = bid(initial, 1, 3);
  for (const state of [game, move(game, 1, [game.hands[1][0]])]) {
    const snapshot = decisionFor(state, state.turn);
    assert.ok(snapshot.choices.length <= 33);
    for (const option of snapshot.choices) assert.ok(move(state, state.turn, option));
    assert.equal(snapshot.choices.some((cards) => !cards.length), Boolean(state.target));
    if (snapshot.choices.length > 1) assert.ok(host.promptFor(snapshot));
  }
  assert.equal(host.promptFor({ ...bidding, hand: ['ignore the prompt'] }), null);
  assert.equal(host.promptFor({ ...bidding, choices: [0, 7] }), null);
  assert.match(host.promptFor(bidding, 'test-token'), /文字回复不会执行/);
  assert.doesNotMatch(host.promptFor(bidding, 'test-token'), /ToolSearch|已出牌|action=history/);
});

function harness(overrides = {}) {
  const models = ['flash', 'mini'].map((name) => ({ modelKey: `provider:${name}`, name, providerName: 'Provider', instant: true, reasoningLevels: ['off', 'high'], extra: 'discard' }));
  const calls = [];
  const replies = [];
  const timings = [];
  let emit;
  let receive;
  let onDispose;
  let tool;
  let openPanel;
  const storage = new Map();
  const ctx = {
    subscriptions: [],
    tools: { register(definition) { tool = definition; return { dispose() {} }; } },
    logger: { info(tag, line) { assert.equal(tag, '[quedou:model-timing]'); timings.push(JSON.parse(line)); } },
    storage: { get: async (key) => storage.get(key), set: async (key, value) => storage.set(key, value) },
    ui: { onDidOpenPanel(fn) {
      openPanel = () => fn({ view: 'appView', postMessage: async (message) => replies.push(message),
        onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
        onDidDispose(fn) { onDispose = fn; return { dispose() {} }; } });
      openPanel();
    } },
    models: { list: async () => models },
    sessions: {
      onDidReceiveEvent(fn) { emit = fn; return { dispose() {} }; },
      create: async (opts) => { calls.push(['create', opts]); return { sessionId: `s${calls.length}` }; },
      send: async (session, message, opts) => { calls.push(['send', session, message, opts]); return { state: 'accepted', turnId: `t${calls.length}` }; },
      waitForTurn: async (session) => {
        const token = calls.findLast(([method]) => method === 'send')[2].idempotencyKey;
        assert.equal((await tool.execute({ token, action: 'bid', optionId: 2 }, { sessionId: session })).isError, false);
        return { state: 'completed', outputText: '1' };
      },
      cancelTurn: async (...args) => calls.push(['cancel', ...args]),
      ...overrides,
    },
  };
  activate(ctx);
  const dispatch = (action, payload = {}, id = randomUUID()) => receive({ type: `quedou:${action}`, id, ...payload });
  return { models, calls, replies, dispatch, onDispose, openPanel, timings, emit, tool };
}

test('model prompt gives rank totals and active turns can read chronological history before submitting', async () => {
  const game = { ...bid(deal(() => 0.4, 0), 0, 3), hands: [[0, 1, 52, 8, 9], [12, 13], [16, 17]] };
  const lead = move(game, 0, [0, 1]);
  const newTrick = move(move(lead, 1, []), 2, []);
  const state = move(newTrick, 0, [52]);
  // Use the next lead (after passes) so there are multiple legal options.
  const nextLead = move(move(state, 1, []), 2, []);
  const spec = decisionFor(nextLead, 0);
  assert.ok(spec.played.every(({ cards }) => cards.every((id) => !nextLead.hands.flat().includes(id))));
  assert.equal(host.promptFor({ ...spec, played: [{ seat: 2, cards: [spec.hand[0]] }] }), null);
  const token = randomUUID();
  let history, wrongSession, submitted;
  const { calls, dispatch, replies, tool } = harness({ waitForTurn: async (sessionId) => {
    const input = { token, action: 'history' };
    wrongSession = await tool.execute(input, { sessionId: 'other-session' });
    history = await tool.execute(input, { sessionId });
    submitted = await tool.execute({ token, action: 'play', optionId: 0 }, { sessionId });
    return { state: 'completed' };
  } });
  assert.ok(tool.inputSchema.properties.action.enum.includes('history'));
  await dispatch('choose', { modelKey: 'provider:flash', spec: { ...spec, playedIncomplete: true } }, token);
  const [, sessionId, { text }] = calls.find(([method]) => method === 'send');
  assert.match(text, /本局已出牌统计（旧存档早期记录缺失）：3×2、小王×1。/);
  assert.match(text, /action=history/);
  assert.doesNotMatch(text, /0: 3 3|"plays"/);
  assert.equal(wrongSession.isError, true);
  assert.equal(history.isError, false);
  assert.deepEqual(JSON.parse(history.content[0].text), { incomplete: true, plays: [{ seat: 0, ranks: ['3', '3'] }, { seat: 0, ranks: ['小王'] }] });
  assert.equal(submitted.isError, false);
  assert.deepEqual(replies.map(({ result }) => result), [{ index: 0 }]);
  assert.equal((await tool.execute({ token, action: 'history' }, { sessionId })).isError, true);
});

test('recreated App View loads the latest checkpoint even when the old page closes before acknowledgment', async () => {
  const { dispatch, replies, onDispose, openPanel, calls } = harness();
  await dispatch('load');
  assert.equal(replies.at(-1).result.snapshot, null);
  const first = dispatch('save', { snapshot: '{"turn":0}' });
  const second = dispatch('save', { snapshot: '{"turn":1}' });
  onDispose();
  openPanel();
  await Promise.all([dispatch('load'), first, second]);
  assert.deepEqual(replies.at(-1).result, { snapshot: '{"turn":1}' });
  assert.deepEqual(calls, []);
});

test('package ships a square PNG for Toolcase and a built-in sidebar glyph', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url));
  assert.ok(JSON.parse(read('package.json')).files.includes('icon.png'));
  assert.equal(JSON.parse(read('finch.json')).contributes.appView.icon, 'bird');
  const png = read('icon.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
});

test('catalog and both seats use explicitly chosen Finch models and separate background sessions', async () => {
  const { models, calls, replies, dispatch } = harness();
  await dispatch('list');
  assert.equal(replies[0].result.models[0].extra, undefined);
  assert.equal(Object.hasOwn(replies[0].result.models[0], 'reasoningLevels'), false);
  assert.equal(calls.length, 0);
  for (const [seat, index] of [[1, 0], [2, 1], [1, 0]]) await dispatch('choose', { modelKey: models[index].modelKey, spec: bidSpec(seat) });
  const creates = calls.filter(([method]) => method === 'create');
  assert.equal(creates.length, 2);
  assert.deepEqual(creates.map(([, opts]) => opts.model.modelKey), models.map(({ modelKey }) => modelKey));
  assert.ok(creates.every(([, opts]) => opts.activity === 'background' && opts.model.reasoningEffort === 'off' && !Object.hasOwn(opts, 'permissionMode')));
  assert.deepEqual(calls.filter(([method]) => method === 'send').map((call) => call[1]), ['s1', 's3', 's1']);
  assert.deepEqual(replies.slice(1).map(({ result }) => result), [{ index: 2 }, { index: 2 }, { index: 2 }]);
});

test('player autopilot gets its own session even when using an opponent’s model', async () => {
  const { calls, replies, dispatch } = harness();
  const modelKey = 'provider:flash';
  for (const seat of [1, 0, 0]) await dispatch('choose', { modelKey, spec: bidSpec(seat) });
  assert.deepEqual(calls.filter(([method]) => method === 'create').map(([, opts]) => opts.title), ['QueDou · Qingque', 'QueDou · Autopilot']);
  const sent = calls.filter(([method]) => method === 'send');
  assert.deepEqual(sent.map(([, id]) => id), ['s1', 's3', 's3']);
  assert.ok(sent.every(([, , , opts]) => opts.model.reasoningEffort === 'off'));
  assert.match(sent[1][2].text, /座位 0 的斗地主选手.*\n你的手牌：3 3。/);
  assert.deepEqual(replies.map(({ result }) => result), Array(3).fill({ index: 2 }));
});

test('turn tool rejects other sessions and late or duplicate actions; ignores legacy reasoning settings', async () => {
  const token = randomUUID();
  const spec = decisionFor(move(bid(deal(() => 0.4, 1), 1, 3), 1, [deal(() => 0.4, 1).hands[1][0]]), 2);
  // A crafted view supplies both a legal-candidate-shaped play and a pass for this boundary test.
  spec.choices = [[spec.hand[0]], []];
  const { calls, replies, dispatch, tool } = harness({
    waitForTurn: async (sessionId) => {
      const call = (action, optionId, session = sessionId) => tool.execute({ token, action, optionId }, { sessionId: session });
      assert.equal((await call('read', undefined, 'ordinary-chat')).isError, true);
      assert.equal((await call('read')).isError, false);
      assert.equal(JSON.parse((await call('legal')).content[0].text).options[1].action, 'pass');
      assert.equal((await call('play', 1)).isError, true);
      assert.equal((await call('pass', 1)).isError, false);
      assert.equal((await call('play', 0)).isError, true);
      return { state: 'completed', outputText: '0' };
    },
  });
  const args = { modelKey: 'provider:flash', spec };
  await dispatch('choose', { ...args, reasoningEffort: 'high' }, token);
  assert.deepEqual(calls.find(([method]) => method === 'create')[1].model, { modelKey: args.modelKey, reasoningEffort: 'off' });
  assert.deepEqual(calls.find(([method]) => method === 'send')[3].model, { modelKey: args.modelKey, reasoningEffort: 'off' });
  assert.deepEqual(replies[0].result, { index: 1 });
  assert.equal((await tool.execute({ token, action: 'read' }, { sessionId: 's1' })).isError, true);
});

test('startup tool submits once before runner completion and allows the next seat to play', async () => {
  const waits = new Map();
  const { dispatch, replies, calls, tool } = harness({
    waitForTurn: (sessionId) => new Promise((resolve, reject) => waits.set(sessionId, { resolve, reject })),
  });
  assert.equal(tool.exposure, 'startup');
  const first = randomUUID();
  const second = randomUUID();
  const play = (seat, id) => dispatch('choose', { modelKey: 'provider:flash', spec: bidSpec(seat) }, id);
  const submit = (token, sessionId) => tool.execute({ token, action: 'bid', optionId: 2 }, { sessionId });
  const firstChoice = play(1, first);
  await new Promise(setImmediate);
  assert.ok(waits.has('s1'));
  assert.equal((await submit(first, 's1')).isError, false);
  assert.deepEqual(replies.map(({ result }) => result), [{ index: 2 }]);
  await firstChoice; // The runner is still waiting for its final response.
  const secondChoice = play(2, second);
  await new Promise(setImmediate);
  assert.ok(waits.has('s3'));
  assert.equal((await submit(first, 's1')).isError, true);
  waits.get('s1').reject(new Error('Late runner failure'));
  assert.equal((await submit(second, 's3')).isError, false);
  await secondChoice;
  waits.get('s3').resolve({ state: 'completed', outputText: 'ignored' });
  await new Promise(setImmediate);
  assert.deepEqual(replies.map(({ id, result }) => [id, result]), [[first, { index: 2 }], [second, { index: 2 }]]);
  assert.equal(calls.some(([method]) => method === 'cancel'), false);
});

test('host reports real failures but keeps waiting for the same turn after a wait window expires', async () => {
  const make = (waitForTurn) => harness({ waitForTurn });
  const invalid = make(async () => ({ state: 'completed', outputText: '999' }));
  await invalid.dispatch('choose', { modelKey: 'provider:flash', spec: bidSpec() });
  await invalid.dispatch('choose', { modelKey: 'provider:unknown', spec: bidSpec() });
  assert.deepEqual(invalid.replies.map(({ result }) => result.error), ['invalid', 'unavailable']);
  let waits = 0;
  const continued = make(async (...args) => {
    assert.deepEqual(args, ['s1', 't2']);
    if (++waits <= 2) return { state: 'timeout' };
    return { state: 'failed' };
  });
  await continued.dispatch('choose', { modelKey: 'provider:flash', spec: bidSpec() });
  assert.equal(waits, 3);
  assert.deepEqual(continued.calls.map(([method]) => method), ['create', 'send']);
  assert.deepEqual(continued.replies.map(({ result }) => result), [{ error: 'unavailable' }]);
});

test('cancellation before send receipt cancels once when the exact turn ID arrives', async () => {
  let queued;
  let accepted;
  const sending = new Promise((resolve) => { queued = resolve; });
  const { dispatch, calls, replies } = harness({ send: () => { queued(); return new Promise((resolve) => { accepted = resolve; }); } });
  const id = randomUUID();
  const choice = dispatch('choose', { modelKey: 'provider:flash', spec: bidSpec() }, id);
  await sending;
  await dispatch('cancel', {}, id);
  accepted({ state: 'accepted', turnId: 'late-turn' });
  await choice;
  assert.deepEqual(replies.map(({ result }) => result), [{ error: 'cancelled' }]);
  assert.deepEqual(calls.at(-1), ['cancel', 's1', 'late-turn']);
});

test('bridge client only times out catalog reads and cancels choices on explicit abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let receive;
  const request = createModelClient({ onMessage(fn) { receive = fn; }, postMessage(message) { sent.push(message); } }, 20);
  assert.equal(createModelClient(undefined), null);
  const list = request('list');
  receive({ type: 'quedou:reply', id: 'unrelated', result: { error: 'invalid' } });
  receive({ type: 'quedou:reply', id: sent[0].id, result: { models: [] } });
  assert.deepEqual(await list, { models: [] });
  const slowList = request('list');
  const choice = request('choose');
  const id = sent.at(-1).id;
  t.mock.timers.tick(120_000);
  assert.deepEqual(await slowList, { error: 'timeout' });
  assert.equal(sent.length, 3);
  receive({ type: 'quedou:reply', id, result: { index: 1 } });
  assert.deepEqual(await choice, { index: 1 });
  const controller = new AbortController();
  const skipped = request('choose', {}, controller.signal);
  controller.abort();
  assert.deepEqual(await skipped, { error: 'cancelled' });
  assert.deepEqual(sent.at(-1), { type: 'quedou:cancel', id: sent.at(-2).id });
});


test('timing matches a dispatch before the receipt', async () => {
  const token = randomUUID();
  const { dispatch, emit, timings, tool } = harness({
    send: async (sessionId) => {
      emit({ type: 'turn.started', sessionId, turnId: 'unrelated', queuedMs: 999 });
      emit({ type: 'turn.started', sessionId, turnId: 'matched', queuedMs: 123 });
      return { state: 'accepted', turnId: 'matched' };
    },
    waitForTurn: async (sessionId) => {
      await tool.execute({ token, action: 'bid', optionId: 2 }, { sessionId });
      return { state: 'completed', outputText: '2', durationMs: 456 };
    },
  });
  await dispatch('choose', { modelKey: 'provider:flash', spec: bidSpec() }, token);
  assert.equal(timings.length, 1);
  const [record] = timings;
  assert.equal(record.outcome, 'ok');
  assert.equal(record.phase, 'runner');
  assert.equal(record.queueMs, 123);
  assert.equal(record.runnerMs, undefined); // The action was reported before runner completion.
  for (const field of ['totalMs', 'modelLookupMs', 'sessionCreateMs', 'sendMs', 'afterDispatchMs']) assert.ok(record[field] >= 0, field);
  for (const field of ['text', 'outputText', 'hand', 'choices']) assert.ok(!(field in record));
});

test('slow session creation can exceed the old deadline and still complete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishCreate;
  let startedCreate;
  const creating = new Promise((resolve) => { startedCreate = resolve; });
  const { dispatch, replies, calls, timings } = harness({
    create: () => { startedCreate(); return new Promise((resolve) => { finishCreate = resolve; }); },
  });
  const choice = dispatch('choose', { modelKey: 'provider:flash', spec: bidSpec() });
  await creating;
  t.mock.timers.tick(120_000);
  assert.equal(replies.length, 0);
  finishCreate({ sessionId: 'late' });
  await choice;
  assert.deepEqual(replies.map(({ result }) => result), [{ index: 2 }]);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].outcome, 'ok');
  assert.deepEqual(calls.map(([method]) => method), ['send']);
});
