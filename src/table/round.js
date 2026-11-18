import { beats, classify, descending, isBomb, shuffle } from './cards.js';

const next = (seat) => (seat + 1) % 3;

export function deal(random = Math.random, starter = Math.floor(random() * 3)) {
  const deck = shuffle(random);
  return {
    phase: 'bid', starter, turn: starter, hands: [0, 1, 2].map((i) => descending(deck.slice(i * 17, i * 17 + 17))),
    bottom: deck.slice(51), bids: [null, null, null], bid: 0, bidder: null, landlord: null,
    target: null, passes: 0, last: Array(3).fill(null), plays: [0, 0, 0], played: [], multiplier: 1, result: null,
  };
}

export const bidOptions = (state) => [0, ...[1, 2, 3].filter((value) => value > state.bid)];

export function bid(state, seat, value) {
  if (state.phase !== 'bid' || state.turn !== seat || !bidOptions(state).includes(value)) return null;
  const bids = state.bids.with(seat, value);
  const bidder = value ? seat : state.bidder;
  const high = value || state.bid;
  if (high !== 3 && bids.includes(null)) return { ...state, bids, bid: high, bidder, turn: next(seat) };
  if (bidder === null) return { ...state, bids, phase: 'redeal', turn: null };
  const hands = state.hands.with(bidder, descending([...state.hands[bidder], ...state.bottom]));
  return { ...state, bids, bid: high, bidder, hands, landlord: bidder, turn: bidder, phase: 'play' };
}

export function move(state, seat, cards) {
  if (state.phase !== 'play' || state.turn !== seat) return null;
  if (!cards.length) {
    if (!state.target) return null;
    const last = state.last.with(seat, { cards: [] });
    if (state.passes === 1) return { ...state, last, turn: state.target.seat, target: null, passes: 0 };
    return { ...state, last, passes: 1, turn: next(seat) };
  }

  const hand = state.hands[seat];
  const play = classify(cards);
  if (!cards.every((id) => hand.includes(id)) || !beats(play, state.target)) return null;
  const remaining = hand.filter((id) => !cards.includes(id));
  const hands = state.hands.with(seat, remaining);
  const target = { ...play, cards: descending(cards), seat };
  const last = (state.target ? state.last : Array(3).fill(null)).with(seat, target);
  const plays = state.plays.with(seat, state.plays[seat] + 1);
  const multiplier = state.multiplier * (isBomb(play) ? 2 : 1);
  const played = [...state.played, { seat, cards: target.cards }];
  const updated = { ...state, hands, target, last, plays, played, multiplier, passes: 0, turn: next(seat) };
  if (remaining.length) return updated;

  const landlordWon = seat === state.landlord;
  const spring = landlordWon ? plays.every((count, i) => i === state.landlord || count === 0) : plays[state.landlord] === 1;
  const finalMultiplier = multiplier * (spring ? 2 : 1);
  const unit = state.bid * finalMultiplier * (landlordWon ? 1 : -1);
  const scores = hands.map((_, i) => i === state.landlord ? unit * 2 : -unit);
  return { ...updated, phase: 'finished', turn: null, multiplier: finalMultiplier, result: { landlordWon, spring, scores } };
}

// Only this view is passed to a computer player. The bottom is not available until bidding ends.
export function playerView(state, seat) {
  return {
    seat, hand: [...state.hands[seat]], counts: state.hands.map((hand) => hand.length),
    target: state.target && { ...state.target, cards: [...state.target.cards] }, landlord: state.landlord, bid: state.bid,
  };
}
