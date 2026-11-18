const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2','小王','大王'];
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isCards = (cards, min = 0, max = 20) => Array.isArray(cards) && cards.length >= min && cards.length <= max
  && new Set(cards).size === cards.length && cards.every((id) => isInt(id, 0, 53));
const rankIndex = (id) => id < 52 ? Math.floor(id / 4) : id - 39;
const rankLabel = (id) => RANKS[rankIndex(id)];
const labels = (cards) => cards.map(rankLabel).join(' ');

function turnView(spec) {
  if (!spec || !isInt(spec.seat, 0, 2) || !isCards(spec.hand, 1) || !isInt(spec.bid, 0, 3)
    || !Array.isArray(spec.counts) || spec.counts.length !== 3 || !spec.counts.every((n) => isInt(n, 1, 20))
    || spec.hand.length !== spec.counts[spec.seat]) return null;
  const { seat, hand, counts, bid, phase, landlord, target, choices, played, playedIncomplete } = spec;
  if (!Array.isArray(played) || played.length > 54 || typeof playedIncomplete !== 'boolean') return null;
  const seen = new Set(hand);
  for (const action of played) {
    if (!isInt(action?.seat, 0, 2) || !isCards(action.cards, 1)) return null;
    for (const id of action.cards) {
      if (seen.has(id)) return null;
      seen.add(id);
    }
  }
  const context = [`你是座位 ${seat} 的斗地主选手，出牌按 0 → 1 → 2 → 0 逆时针轮转。`,
    `你的手牌：${labels(hand)}。座位 0/1/2 剩余张数：${counts.join('/')}。`];
  let options;
  let history;
  if (phase === 'bid') {
    if (played.length || playedIncomplete || !Array.isArray(choices) || choices.length < 2 || choices.length > 4 || new Set(choices).size !== choices.length
      || !choices.every((n) => n === 0 || isInt(n, bid + 1, 3))) return null;
    context.push(`现在叫地主，当前最高 ${bid} 分。`);
    options = choices.map((n) => n === 0 ? '不叫' : `叫 ${n} 分`);
  } else if (phase === 'play') {
    if (!isInt(landlord, 0, 2) || (target !== null && (!target || !isInt(target.seat, 0, 2) || !isCards(target.cards, 1)))
      || !Array.isArray(choices) || choices.length < 2 || choices.length > 33
      || !choices.every((cards) => isCards(cards) && cards.every((id) => hand.includes(id)) && (cards.length || target))) return null;
    context.push(`地主是座位 ${landlord}，两个农民同队。`, target ? `座位 ${target.seat} 当前出牌：${labels(target.cards)}。` : '这轮由你领出。');
    options = choices.map((cards) => cards.length ? labels(cards) : '过牌');
    const totals = RANKS.map(() => 0);
    for (const { cards } of played) for (const id of cards) totals[rankIndex(id)]++;
    const summary = RANKS.flatMap((rank, i) => totals[i] ? [`${rank}×${totals[i]}`] : []).join('、');
    context.push(`本局已出牌统计${playedIncomplete ? '（旧存档早期记录缺失）' : ''}：${summary || (playedIncomplete ? '暂无记录' : '无')}。`);
    history = { incomplete: playedIncomplete, plays: played.map(({ seat, cards }) => ({ seat, ranks: cards.map(rankLabel) })) };
  } else return null;
  return { context, history, options: options.map((label, optionId) => ({ optionId, label,
    action: phase === 'bid' ? 'bid' : spec.choices[optionId].length ? 'play' : 'pass' })) };
}

const TOOL = 'quedou_turn';
function promptFor(spec, token) {
  const view = turnView(spec);
  if (!view) return null;
  return [`直接调用 ${TOOL} 提交本手动作，不要搜索工具。`,
    `token 填 ${token}；从下方选一项，action 和整数 optionId 照填。`,
    '提交成功后结束，无需回复文字。文字回复不会执行。',
    ...view.context, ...(view.history ? ['仅当需要知道出牌座位或先后顺序时，用同一 token 调用 action=history（不填 optionId），看完再提交。'] : []),
    '合法选项：', JSON.stringify(view.options)].join('\n');
}

function registerTurnTool(ctx, jobs) {
  if (!ctx.tools?.register) return false;
  const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });
  ctx.subscriptions.push(ctx.tools.register({
    name: TOOL, title: 'QueDou Turn', exposure: 'startup', risk: 'low', defaultEnabled: true,
    description: `Only for an active QueDou turn. Use the current token for every action and optionId only to submit.
read: view your hand and public table.
legal: list legal candidates.
history: read recorded public plays in order (play phase only).
bid: submit a bid or no bid.
play: submit cards.
pass: pass.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['token', 'action'], properties: {
      token: { type: 'string' }, action: { type: 'string', enum: ['read', 'legal', 'history', 'bid', 'play', 'pass'] },
      optionId: { type: 'integer', minimum: 0, maximum: 32 },
    } },
    async execute(input, exec) {
      const job = jobs.get(input?.token);
      if (!job?.sessionId || job.sessionId !== exec.sessionId || job.stopped || exec.signal?.aborted) {
        return result({ error: 'No active turn' }, true);
      }
      if (input.action === 'read') return result({ table: job.view.context });
      if (input.action === 'legal') return result({ options: job.view.options });
      if (input.action === 'history') {
        return job.view.history ? result(job.view.history) : result({ error: 'History is only available during play' }, true);
      }
      const option = Number.isInteger(input.optionId) && job.view.options[input.optionId];
      if (!option || option.action !== input.action) return result({ error: 'Invalid option for this action' }, true);
      job.submit(option.optionId);
      return result({ accepted: true, optionId: option.optionId });
    },
  }));
  return true;
}

module.exports = { promptFor, turnView, registerTurnTool };
