export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王'];
export const SUITS = ['♣', '♦', '♠', '♥'];
export const DECK = Object.freeze(Array.from({ length: 54 }, (_, id) => id));
export const rankOf = (id) => id < 52 ? Math.floor(id / 4) : id - 39;
export const descending = (cards) => [...cards].sort((a, b) => b - a);

export function shuffle(random = Math.random) {
  const cards = [...DECK];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export const TYPE_NAMES = {
  single: '单张', pair: '对子', triple: '三张', tripleSingle: '三带一', triplePair: '三带二',
  straight: '顺子', pairRun: '连对', plane: '飞机', planeSingles: '飞机带单', planePairs: '飞机带对',
  fourSingles: '四带二单', fourPairs: '四带二对', bomb: '炸弹', rocket: '王炸',
};

// Pieces are [rank, quantity]. Wing selection works on rank counts, not suits.
function* attachments(counts, core, units, width, distinct) {
  const available = counts.map((count, rank) => core.some(([r]) => r === rank) ? 0 : count);
  function* pick(start, remaining, pieces) {
    if (!remaining) {
      yield [...core, ...pieces];
      return;
    }
    for (let rank = start; rank < available.length; rank++) {
      if (available[rank] < width) continue;
      available[rank] -= width;
      yield* pick(distinct ? rank + 1 : rank, remaining - 1, [...pieces, [rank, width]]);
      available[rank] += width;
    }
  }
  yield* pick(0, units, []);
}

// Both selected-card validation and move generation use these same shapes.
function* shapes(counts, size) {
  function* emit(type, main, core, units = 0, width = 1, distinct = true) {
    const length = core.reduce((sum, [, n]) => sum + n, 0) + units * width;
    if (size !== undefined && size !== length) return;
    for (const pieces of attachments(counts, core, units, width, distinct)) {
      yield { type, main, length, pieces };
    }
  }

  for (let rank = 0; rank < counts.length; rank++) {
    const count = counts[rank];
    if (count >= 1) yield* emit('single', rank, [[rank, 1]]);
    if (count >= 2) yield* emit('pair', rank, [[rank, 2]]);
    if (count >= 3) {
      const core = [[rank, 3]];
      yield* emit('triple', rank, core);
      yield* emit('tripleSingle', rank, core, 1);
      yield* emit('triplePair', rank, core, 1, 2);
    }
    if (count === 4) {
      const core = [[rank, 4]];
      yield* emit('bomb', rank, core);
      yield* emit('fourSingles', rank, core, 2, 1, false);
      yield* emit('fourPairs', rank, core, 2, 2);
    }
  }
  if (counts[13] && counts[14]) yield* emit('rocket', 14, [[13, 1], [14, 1]]);

  for (const [width, min, type] of [[1, 5, 'straight'], [2, 3, 'pairRun'], [3, 2, 'plane']]) {
    for (let start = 0; start < 12; start++) {
      const core = [];
      for (let end = start; end < 12 && counts[end] >= width; end++) {
        core.push([end, width]);
        if (core.length < min) continue;
        yield* emit(type, end, core);
        if (type === 'plane') {
          yield* emit('planeSingles', end, core, core.length, 1, false);
          yield* emit('planePairs', end, core, core.length, 2);
        }
      }
    }
  }
}

function group(cards) {
  const byRank = Array.from({ length: RANKS.length }, () => []);
  for (const id of cards) byRank[rankOf(id)].push(id);
  return byRank;
}

export function classify(cards) {
  if (!cards.length || new Set(cards).size !== cards.length || cards.some((id) => !Number.isInteger(id) || id < 0 || id >= 54)) return null;
  const counts = group(cards).map((pile) => pile.length);
  let best = null;
  for (const { type, main, length } of shapes(counts, cards.length)) {
    // A pure plane takes precedence over a shorter body with wings.
    // If multiple winged bodies fit, use the highest one.
    if (!best || (type === 'plane' && best.type !== 'plane') || (type === best.type && main > best.main)) {
      best = { type, main, length };
    }
  }
  return best;
}

export const isBomb = (play) => play.type === 'bomb' || play.type === 'rocket';

export function beats(play, target) {
  if (!play) return false;
  if (!target) return true;
  if (target.type === 'rocket') return false;
  if (play.type === 'rocket') return true;
  if (play.type === 'bomb' && target.type !== 'bomb') return true;
  return play.type === target.type && play.length === target.length && play.main > target.main;
}

export function legalMoves(hand, target = null) {
  const byRank = group(hand);
  const seen = new Set();
  const moves = [];
  for (const { pieces } of shapes(byRank.map((pile) => pile.length))) {
    const used = Array(RANKS.length).fill(0);
    for (const [rank, count] of pieces) used[rank] += count;
    const key = used.join('');
    if (seen.has(key)) continue;
    seen.add(key);
    const cards = descending(byRank.flatMap((pile, rank) => pile.slice(0, used[rank])));
    const play = classify(cards);
    if (beats(play, target)) moves.push({ ...play, cards });
  }
  return moves;
}
