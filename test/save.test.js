import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bid, deal, move, playerView } from '../src/table/round.js';
import { computerMove } from '../src/table/computer.js';
import { decodeTable, encodeTable, loadTable } from '../src/table/save.js';

const saveTable = (table, storage) => storage.setItem('finch-quedou:table', encodeTable(table));

function fixture() {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const table = {
    roundNumber: 7, state: deal(() => 0.42, 0), selected: new Set(), hintIndex: 0,
    opponents: [null, { modelKey: 'demo:fast', name: 'Fast', providerName: 'Demo', instant: true }, null],
    fallback: [null, null, '模型超时'],
  };
  return { data, storage, table };
}

test('snapshots restore bidding, every move of a full game, and the final score', () => {
  const { storage, table } = fixture();
  for (const next of [table.state, bid(table.state, 0, 1)]) {
    table.state = next;
    saveTable(table, storage);
    assert.deepEqual(loadTable(storage).state, next);
  }
  table.state = bid(bid(table.state, 1, 0), 2, 0);
  table.selected.add(table.state.hands[0][0]);
  table.hintIndex = 2;
  saveTable(table, storage);
  const restored = loadTable(storage);
  assert.deepEqual(restored.selected, [...table.selected]);
  assert.equal(restored.hintIndex, 2);
  assert.deepEqual(restored.opponents, table.opponents);
  assert.deepEqual(restored.fallback, table.fallback);
  assert.equal(restored.roundNumber, 7);
  table.selected.clear();
  table.hintIndex = 0;
  for (let i = 0; i < 200 && table.state.phase === 'play'; i++) {
    const { turn } = table.state;
    table.state = move(table.state, turn, computerMove(playerView(table.state, turn)));
    saveTable(table, storage);
    assert.deepEqual(loadTable(storage).state, table.state);
    table.state = loadTable(storage).state;
  }
  assert.equal(table.state.phase, 'finished');
});

test('snapshots restore all-pass redeals and allow settings before a first round', () => {
  const { storage, table } = fixture();
  table.state = bid(bid(bid(table.state, 0, 0), 1, 0), 2, 0);
  saveTable(table, storage);
  assert.equal(loadTable(storage).state.phase, 'redeal');
  saveTable({ ...table, state: null, roundNumber: 0 }, storage);
  assert.equal(loadTable(storage).state, null);
  assert.deepEqual(loadTable(storage).opponents, table.opponents);
});

test('legacy snapshots keep the model choice but discard reasoning settings', () => {
  const { data, storage, table } = fixture();
  saveTable(table, storage);
  const key = [...data.keys()][0];
  const legacy = JSON.parse(data.get(key));
  Object.assign(legacy.opponents[1], { reasoningEffort: 'high', reasoningLevels: ['off', 'high'] });
  storage.setItem(key, JSON.stringify(legacy));
  const restored = loadTable(storage);
  assert.deepEqual(restored.opponents, table.opponents);
  assert.deepEqual(restored.state, table.state);
  saveTable(restored, storage);
  assert.deepEqual(JSON.parse(data.get(key)).opponents, table.opponents);
});

test('bad or unsupported snapshots are ignored and inaccessible storage is non-fatal', () => {
  const { data, storage, table } = fixture();
  assert.equal(loadTable(storage), null);
  saveTable(table, storage);
  const [[key, value]] = data;
  for (const invalid of ['{', value.replace('"version":1', '"version":2'), value.replace('"turn":0', '"turn":9')]) {
    data.set(key, invalid);
    assert.equal(loadTable(storage), null);
  }
  const unavailable = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
  assert.equal(loadTable(unavailable), null);
  assert.deepEqual(decodeTable(encodeTable(table)).state, table.state);
});
