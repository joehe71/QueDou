import { isBomb, legalMoves, rankOf } from './cards.js';

function rankCounts(cards) {
  const counts = Array(15).fill(0);
  for (const id of cards) counts[rankOf(id)]++;
  return counts;
}

export function explainBid({ hand, bid }) {
  const counts = rankCounts(hand);
  const strength = counts[14] * 3 + counts[13] * 2 + counts[12] * 1.4 + counts[11] * 0.6
    + counts.filter((count) => count === 4).length * 3 + (counts[13] && counts[14] ? 1 : 0);
  const ceiling = strength >= 9 ? 3 : strength >= 6 ? 2 : strength >= 3.5 ? 1 : 0;
  const action = ceiling > bid ? bid + 1 : 0;
  return { action, reason: `按大小王、2、A 和炸弹估算牌力 ${Number(strength.toFixed(1))}，叫分上限 ${ceiling} 分；当前最高 ${bid} 分，${action ? `选择叫 ${action} 分` : '选择不叫'}。` };
}

export function computerBid(view) {
  return explainBid(view).action;
}

export function orderedMoves({ hand, target }) {
  const counts = rankCounts(hand);
  function cost(play) {
    if (play.length === hand.length) return -10000;
    const used = rankCounts(play.cards);
    let split = 0;
    for (let i = 0; i < used.length; i++) {
      if (used[i] && used[i] < counts[i]) split += counts[i] === 4 ? 24 : counts[i] === 3 ? 5 : 3;
    }
    if (counts[13] && counts[14] && used[13] !== used[14]) split += 16;
    return (isBomb(play) ? 100 : 0) + split + play.main - (target ? 0 : 9 * play.length);
  }
  return legalMoves(hand, target).map((play) => ({ play, cost: cost(play) })).sort((a, b) => a.cost - b.cost).map(({ play }) => play);
}

export function explainMove(view) {
  const { seat, landlord, hand, target, counts } = view;
  const teammate = (other) => seat !== landlord && other !== landlord;
  const choices = orderedMoves(view);
  const best = choices[0];
  const decide = (action, reason) => ({ action, reason, candidates: choices.length });
  if (!best) return decide([], '没有能压过当前牌面的合法牌，过牌。');
  if (best.length === hand.length) return decide(best.cards, '这手能一次出完，直接取胜。');
  if (target && teammate(target.seat)) return decide([], '当前领先的是队友，选择过牌。');
  if (target && isBomb(best) && counts[target.seat] > 5 && hand.length > 5) return decide([], '双方还剩较多牌，先保留炸弹。');

  const nextSeat = (seat + 1) % 3;
  if (!target && counts[nextSeat] === 1 && !teammate(nextSeat) && best.type === 'single') {
    const multi = choices.find((play) => play.length > 1 && !isBomb(play));
    const pick = multi ?? choices.filter((play) => play.type === 'single').sort((a, b) => b.main - a.main)[0];
    return decide(pick.cards, multi ? '下家对手只剩一张，优先出多张组合。' : '下家对手只剩一张，用最大的单牌拦截。');
  }
  return decide(best.cards, target ? '选择代价最低的跟牌，尽量不拆组合、不耗炸弹。' : '领出时优先多出牌，尽量不拆组合、不耗炸弹。');
}

export function computerMove(view) {
  return explainMove(view).action;
}
