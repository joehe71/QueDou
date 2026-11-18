import { classify } from './cards.js';

const KEY = 'finch-quedou:table';
const VERSION = 1;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const seat = (value) => integer(value, 0, 2);
const triple = (values, check) => Array.isArray(values) && values.length === 3 && values.every(check);
const cards = (values, max = 20) => Array.isArray(values) && values.length <= max &&
  values.every((value) => integer(value, 0, 53)) && new Set(values).size === values.length;
const play = (value) => {
  if (!seat(value?.seat) || !cards(value.cards)) return false;
  const pattern = classify(value.cards);
  return pattern && ['type', 'rank', 'length', 'chain'].every((key) => value[key] === pattern[key]);
};

function validRound(state) {
  if (!['bid', 'redeal', 'play', 'finished'].includes(state?.phase) || !seat(state.starter) ||
      !triple(state.hands, (hand) => cards(hand)) || !cards(state.bottom, 3) || state.bottom.length !== 3 ||
      !triple(state.bids, (value) => value === null || integer(value, 0, 3)) ||
      !integer(state.bid, 0, 3) || state.bid !== Math.max(...state.bids) ||
      (state.bid === 0 ? state.bidder !== null : !seat(state.bidder) || state.bids[state.bidder] !== state.bid) ||
      !integer(state.multiplier, 1, Number.MAX_SAFE_INTEGER) || !integer(state.passes, 0, 1) ||
      !triple(state.plays, (value) => integer(value, 0, 20)) ||
      !triple(state.last, (value, i) => value === null || (Array.isArray(value?.cards) &&
        (value.cards.length === 0 || (value.seat === i && play(value))))) ||
      (state.target !== null && !play(state.target))) return false;
  const hands = state.hands.flat();
  if (new Set(hands).size !== hands.length) return false;
  if (state.played !== undefined) {
    if (!Array.isArray(state.played) || state.played.length > 54) return false;
    const seen = new Set(hands);
    const recorded = [0, 0, 0];
    for (const action of state.played) {
      if (!seat(action?.seat) || !cards(action.cards) || !classify(action.cards) ||
          ++recorded[action.seat] > state.plays[action.seat]) return false;
      for (const id of action.cards) {
        if (seen.has(id)) return false;
        seen.add(id);
      }
    }
  }
  if (state.phase === 'bid' || state.phase === 'redeal') {
    if (state.played?.length) return false;
    return state.landlord === null && !state.target && state.result === null &&
      state.hands.every((hand) => hand.length === 17) && state.bottom.every((id) => !hands.includes(id)) &&
      (state.phase === 'bid' ? seat(state.turn) && state.bids[state.turn] === null
        : state.turn === null && state.bids.every((value) => value === 0));
  }
  if (!seat(state.landlord) || state.landlord !== state.bidder) return false;
  if (state.phase === 'play') return seat(state.turn) && state.result === null && state.hands.every((hand) => hand.length);
  const { landlordWon, spring, scores } = state.result ?? {};
  return state.turn === null && state.hands.some((hand) => !hand.length) &&
    typeof landlordWon === 'boolean' && typeof spring === 'boolean' && triple(scores, Number.isSafeInteger);
}

const model = (value) => value === null || (typeof value?.modelKey === 'string' &&
  value.modelKey.length > 0 && value.modelKey.length <= 256 && typeof value.name === 'string' &&
  typeof value.providerName === 'string');

const modelSelection = (value) => {
  if (value === null) return null;
  const { modelKey, name, providerName, instant } = value;
  return { modelKey, name, providerName, instant };
};

export function decodeTable(snapshot) {
  try {
    const saved = JSON.parse(snapshot);
    if (saved?.version !== VERSION || !integer(saved.roundNumber, 0, Number.MAX_SAFE_INTEGER - 1) ||
        (saved.state === null ? saved.roundNumber !== 0 : saved.roundNumber === 0 || !validRound(saved.state)) ||
        !triple(saved.opponents, model) || saved.opponents[0] !== null ||
        !triple(saved.fallback, (value) => value === null || typeof value === 'string')) return null;
    if (saved.state && saved.state.played === undefined) saved.state.played = [];
    const canSelect = saved.state?.phase === 'play' && saved.state.turn === 0;
    const selected = canSelect && cards(saved.selected) && saved.selected.every((id) => saved.state.hands[0].includes(id))
      ? saved.selected : [];
    return { ...saved, opponents: saved.opponents.map(modelSelection), selected, hintIndex: canSelect && integer(saved.hintIndex, 0, Number.MAX_SAFE_INTEGER - 1) ? saved.hintIndex : 0 };
  } catch { return null; }
}

export function encodeTable({ state, roundNumber, opponents, fallback = [null, null, null], selected, hintIndex }) {
  return JSON.stringify({ version: VERSION, state, roundNumber, opponents: opponents.map(modelSelection), fallback, selected: [...selected], hintIndex });
}

// Legacy WebView save, used only to migrate an existing game to Finch storage.
export function loadTable(storage) {
  try { return decodeTable((storage ?? globalThis.localStorage).getItem(KEY)); }
  catch { return null; }
}
