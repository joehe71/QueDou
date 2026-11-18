import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classify, beats, legalMoves, rankOf, RANKS } from '../src/table/cards.js';
import { bid, deal, move, playerView } from '../src/table/round.js';
import { computerBid, computerMove } from '../src/table/computer.js';

function cards(text) {
  const used = Array(15).fill(0);
  return text.split(' ').filter(Boolean).map((name) => {
    const rank = RANKS.indexOf(name);
    return rank < 13 ? rank * 4 + used[rank]++ : rank + 39;
  });
}
const type = (text) => classify(cards(text))?.type;

const patterns = {
  single: '2', pair: '2 2', triple: '2 2 2', tripleSingle: '3 3 3 4', triplePair: '3 3 3 4 4',
  straight: '10 J Q K A', pairRun: 'Q Q K K A A', plane: '3 3 3 4 4 4 5 5 5 6 6 6',
  planeSingles: '3 3 3 4 4 4 6 6', planePairs: '3 3 3 4 4 4 5 5 6 6',
  fourSingles: '3 3 3 3 4 4', fourPairs: '3 3 3 3 4 4 5 5', bomb: '3 3 3 3', rocket: '小王 大王',
};
for (const [name, example] of Object.entries(patterns)) test(`classifies ${name}`, () => assert.equal(type(example), name));

test('rejects invalid groups, 2 and jokers in sequences, and duplicate physical cards', () => {
  for (const invalid of ['J Q K A 2', 'Q K A 2 小王', 'K K A A 2 2', 'A A A 2 2 2', '3 3 3 3 4 4 4 4', '3 3 3 4 4 4 5 5 5 5']) {
    assert.equal(type(invalid), undefined, invalid);
  }
  assert.equal(classify([0, 0]), null);
  assert.equal(classify([54]), null);
  assert.equal(classify([]), null);
  assert.deepEqual(classify(cards('3 3 3 4 4 4 5 5 5 7 8 9')), { type: 'planeSingles', main: 2, length: 12 });
});

test('compares same type and length; bombs beat ordinary cards and rocket beats bombs', () => {
  const combo = (text) => classify(cards(text));
  assert.ok(beats(combo('4 5 6 7 8'), combo('3 4 5 6 7')));
  assert.ok(!beats(combo('4 5 6 7 8 9'), combo('3 4 5 6 7')));
  assert.ok(!beats(combo('2 2'), combo('3')));
  assert.ok(!beats(combo('4'), combo('4')));
  assert.ok(beats(combo('3 3 3 3'), combo('2 2')));
  assert.ok(beats(combo('4 4 4 4'), combo('3 3 3 3')));
  assert.ok(beats(combo('小王 大王'), combo('2 2 2 2')));
  assert.ok(!beats(combo('小王 大王'), combo('小王 大王')));
});

test('legal move enumeration matches brute-force subsets for a mixed hand', () => {
  const hand = cards('3 3 3 3 4 4 4 5 5 6 6 7 小王 大王');
  const key = (ids) => ids.map(rankOf).sort((a, b) => a - b).join(',');
  const subsets = Array.from({ length: (1 << hand.length) - 1 }, (_, i) => hand.filter((_, j) => ((i + 1) >> j) & 1));
  for (const target of [null, classify(cards('3 3')), classify(cards('3 3 3 3'))]) {
    const expected = new Set(subsets.filter((ids) => beats(classify(ids), target)).map(key));
    const actual = legalMoves(hand, target).map((play) => key(play.cards));
    assert.equal(actual.length, expected.size);
    assert.deepEqual(new Set(actual), expected);
  }
});

test('deals 54 unique cards, checks bid order, passes, and landlord assignment', () => {
  const initial = deal(() => 0.4, 1);
  assert.equal(new Set([...initial.hands.flat(), ...initial.bottom]).size, 54);
  assert.equal(bid(initial, 0, 1), null);
  assert.equal(bid(initial, 1, 4), null);
  const bidOne = bid(initial, 1, 1);
  assert.equal(bid(bidOne, 2, 1), null);
  const game = bid(bid(bidOne, 2, 0), 0, 2);
  assert.equal(game.landlord, 0);
  assert.equal(game.turn, 0);
  assert.deepEqual(game.hands.map((hand) => hand.length), [20, 17, 17]);
  assert.equal(bid(initial, 1, 3).phase, 'play');
  assert.equal(bid(bid(bid(initial, 1, 0), 2, 0), 0, 0).phase, 'redeal');
});

function fixture(hands) {
  return { ...bid(deal(() => 0.4, 0), 0, 3), hands };
}

test('table seats follow the counterclockwise turn order from the player', () => {
  const html = readFileSync(new URL('../src/table/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="arena">\s*<section id="seat-2"[\s\S]*?<section id="seat-1"[^>]*><\/section>\s*<\/div>\s*<div class="player">/);
  const state = fixture([[0, 1], [4, 5], [8, 9]]);
  const right = move(state, 0, [0]);
  assert.equal(right.turn, 1);
  const left = move(right, 1, [4]);
  assert.equal(left.turn, 2);
  assert.equal(move(left, 2, [8]).turn, 0);
});

test('two passes return the lead, and illegal actions leave state intact', () => {
  const state = fixture([[0, 4], [8], [12]]);
  assert.equal(move(state, 0, []), null);
  assert.equal(move(state, 0, [8]), null);
  assert.equal(move(state, 0, [0, 4]), null);
  const first = move(state, 0, [0]);
  const newLead = move(move(first, 1, []), 2, []);
  assert.equal(newLead.turn, 0);
  assert.equal(newLead.target, null);
  assert.equal(newLead.passes, 0);
  assert.deepEqual(state.hands[0], [0, 4]);
});

test('bomb and spring multiply settlement, or farmers win together with counter-spring', () => {
  const landlord = move(fixture([cards('3 3 3 3'), [8], [12]]), 0, cards('3 3 3 3'));
  assert.equal(landlord.turn, null);
  assert.equal(landlord.multiplier, 4);
  assert.deepEqual(landlord.result, { landlordWon: true, spring: true, scores: [24, -12, -12] });
  const farmer = move(move(fixture([[0, 1], [8], [12]]), 0, [0]), 1, [8]);
  assert.deepEqual(farmer.result, { landlordWon: false, spring: true, scores: [-12, 6, 6] });
  assert.equal(move(farmer, 2, [12]), null);
});

test('computer receives no private information about other hands or bottom cards', () => {
  const state = deal(() => 0.4, 0);
  const view = playerView(state, 1);
  assert.deepEqual(Object.keys(view).sort(), ['bid', 'counts', 'hand', 'landlord', 'seat', 'target']);
  assert.deepEqual(view.hand, state.hands[1]);
  assert.notEqual(view.hand, state.hands[1]);
  assert.deepEqual(view.counts, [17, 17, 17]);
});

test('200 seeded computer games finish using legal plays and conserve cards', () => {
  for (let seed = 1; seed <= 200; seed++) {
    let bits = seed;
    const random = () => ((bits = (Math.imul(bits, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    let state = deal(random);
    let redeals = 0;
    while (state.phase === 'bid' || state.phase === 'redeal') {
      if (state.phase === 'redeal') {
        assert.ok(++redeals < 20);
        state = deal(random);
      } else state = bid(state, state.turn, computerBid(playerView(state, state.turn)));
      assert.ok(state);
    }
    const spent = [];
    while (state.phase === 'play') {
      const chosen = computerMove(playerView(state, state.turn));
      state = move(state, state.turn, chosen);
      assert.ok(state, `invalid move in game ${seed}`);
      spent.push(...chosen);
      assert.equal(new Set([...state.hands.flat(), ...spent]).size, 54);
      assert.equal(state.hands.flat().length + spent.length, 54);
    }
    assert.equal(state.phase, 'finished');
    assert.equal(state.result.scores.reduce((sum, score) => sum + score, 0), 0);
  }
});
