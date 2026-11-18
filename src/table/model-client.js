import { orderedMoves } from './computer.js';
import { bidOptions, playerView } from './round.js';

export function decisionFor(state, seat) {
  const view = playerView(state, seat);
  const choices = state.phase === 'bid' ? bidOptions(state) : orderedMoves(view).slice(0, 32).map(({ cards }) => cards);
  if (state.phase === 'play' && view.target) choices.push([]);
  const played = state.played.map(({ seat, cards }) => ({ seat, cards: [...cards] }));
  const playedIncomplete = played.length < state.plays.reduce((total, count) => total + count, 0);
  return { ...view, phase: state.phase, choices, played, playedIncomplete };
}

export function createModelClient(bridge, listTimeoutMs = 9500) {
  if (typeof bridge?.onMessage !== 'function' || typeof bridge?.postMessage !== 'function') return null;
  const pending = new Map();
  bridge.onMessage((message) => {
    if (message?.type === 'quedou:reply') pending.get(message.id)?.(message.result);
  });
  return (action, data = {}, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve({ error: 'cancelled' });
    const id = globalThis.crypto.randomUUID();
    function finish(result) {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    }
    function cancel() {
      finish({ error: 'cancelled' });
      if (action === 'choose') {
        try { bridge.postMessage({ type: 'quedou:cancel', id }); } catch { /* Page may have closed. */ }
      }
    }
    const timer = action !== 'choose' ? setTimeout(() => finish({ error: 'timeout' }), listTimeoutMs) : undefined;
    pending.set(id, finish);
    signal?.addEventListener('abort', cancel, { once: true });
    try { bridge.postMessage({ type: `quedou:${action}`, id, ...data }); }
    catch { finish({ error: 'unavailable' }); }
  });
}
