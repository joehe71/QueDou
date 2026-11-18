const { promptFor, turnView, registerTurnTool } = require('./model-host.cjs');
const TABLE_KEY = 'quedou.table.v1';
const ms = (value) => Math.max(0, Math.round(value));

exports.activate = function activate(ctx) {
  const jobs = new Map();
  // Persist each checkpoint in receive order, including across App View recreation.
  let tableWrites = Promise.resolve();
  const hasTurnTool = registerTurnTool(ctx, jobs);
  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    if (panel.view !== 'appView') return;
    const seats = new Map();
    let active;
    let disposed = false;
    const reply = async (id, result) => {
      if (disposed) return;
      try { await panel.postMessage({ type: 'quedou:reply', id, result }); } catch { /* Page may have navigated. */ }
    };
    const cancelTurn = (job) => {
      if (!job.turnId || job.cancelSent) return;
      job.cancelSent = true;
      void Promise.resolve().then(() => ctx.sessions.cancelTurn(job.sessionId, job.turnId)).catch(() => {});
    };
    let modelEvents;
    try {
      modelEvents = ctx.sessions.onDidReceiveEvent?.((event) => {
        const job = active;
        if (!job || event.type !== 'turn.started' || !job.sessionId || event.sessionId !== job.sessionId) return;
        if (job.turnId && event.turnId !== job.turnId) return;
        // Dispatch can arrive before the send receipt exposes the turn ID.
        if (job.starts.size < 8) job.starts.set(event.turnId, { at: performance.now(), queuedMs: event.queuedMs });
      });
    } catch { /* Timing is optional when the event stream is unavailable. */ }
    const nextStage = (job, stage) => {
      const now = performance.now();
      job.timing[`${job.stage}Ms`] = ms(now - job.stageAt);
      job.stage = stage;
      job.stageAt = now;
    };
    const logTiming = (job, outcome) => {
      const now = performance.now();
      const started = job.starts.get(job.turnId);
      const phase = job.stage === 'awaitTurn' ? (started ? 'runner' : 'awaitDispatchOrReply') : job.stage;
      const timing = { ...job.timing };
      if (started) {
        if (Number.isFinite(started.queuedMs)) timing.queueMs = ms(started.queuedMs);
        timing.afterDispatchMs = ms(now - started.at);
      }
      try {
        ctx.logger?.info('[quedou:model-timing]', JSON.stringify({
          requestId: job.id, seat: job.seat, action: job.action, modelKey: job.modelKey, outcome,
          phase, totalMs: ms(now - job.startedAt), phaseMs: ms(now - (phase === 'runner' ? started.at : job.stageAt)), ...timing,
        }));
      } catch { /* Logging must not affect play. */ }
    };
    const finish = (job, result) => {
      logTiming(job, result.error ?? 'ok');
      return reply(job.id, result);
    };
    const release = (job) => {
      if (jobs.get(job.id) === job) jobs.delete(job.id);
      if (active === job) active = undefined;
    };
    const stop = (job, error) => {
      if (job.stopped) return;
      job.stopped = true;
      release(job);
      if (seats.get(job.seat)?.sessionId === job.sessionId) seats.delete(job.seat);
      cancelTurn(job);
      void finish(job, { error });
    };
    async function choose({ id, modelKey, spec }) {
      const view = turnView(spec);
      if (!hasTurnTool || !view || typeof modelKey !== 'string' || modelKey.length > 256 || active || jobs.has(id)) return reply(id, { error: 'unavailable' });
      const startedAt = performance.now();
      const job = { id, seat: spec.seat, action: spec.phase, modelKey, startedAt, stageAt: startedAt,
        stage: 'setup', timing: {}, starts: new Map(), view };
      const submitted = new Promise((resolve) => {
        job.submit = (index) => {
          // Lock in the action before replying so no later tool call or runner result can change it.
          job.committed = true;
          release(job);
          resolve(finish(job, { index }));
        };
      });
      jobs.set(id, job);
      active = job;
      try {
        nextStage(job, 'modelLookup');
        const entry = (await ctx.models.list()).find((model) => model.modelKey === modelKey);
        if (job.stopped) return;
        if (!entry) return finish(job, { error: 'unavailable' });
        const model = { modelKey, reasoningEffort: 'off' };
        let session = seats.get(spec.seat);
        if (session?.modelKey !== modelKey) {
          nextStage(job, 'sessionCreate');
          const { sessionId } = await ctx.sessions.create({
            // Background sessions cannot present approval cards; use Finch's default mode.
            title: `QueDou · ${['Autopilot', 'Qingque', 'Lique'][spec.seat]}`, activity: 'background', model,
          });
          if (job.stopped) return;
          session = { modelKey, sessionId };
          seats.set(spec.seat, session);
        }
        job.sessionId = session.sessionId;
        nextStage(job, 'send');
        const receipt = await ctx.sessions.send(job.sessionId, { text: promptFor(spec, id), idempotencyKey: id }, { model });
        if (job.committed) return submitted;
        if (receipt.state === 'rejected' || !receipt.turnId) {
          if (!job.stopped) return finish(job, { error: 'unavailable' });
          return;
        }
        job.turnId = receipt.turnId;
        if (job.stopped) return cancelTurn(job);
        nextStage(job, 'awaitTurn');
        // A Finch wait window can expire while the same turn is still running.
        let result;
        do {
          result = await Promise.race([ctx.sessions.waitForTurn(job.sessionId, job.turnId), submitted]);
          if (job.committed) return submitted;
          if (job.stopped) return;
        } while (result.state === 'timeout');
        if (result.state === 'completed' && Number.isFinite(result.durationMs)) job.timing.runnerMs = ms(result.durationMs);
        if (result.state !== 'completed' || (result.modelKey && result.modelKey !== modelKey)) {
          return finish(job, { error: 'unavailable' });
        }
        return finish(job, { error: 'invalid' });
      } catch {
        if (job.committed) return submitted;
        if (!job.stopped) {
          cancelTurn(job);
          return finish(job, { error: 'unavailable' });
        }
      } finally {
        release(job);
      }
    }
    const messages = panel.onDidReceiveMessage(async (request) => {
      if (disposed || typeof request?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id)) return;
      if (request.type === 'quedou:load') {
        try {
          await tableWrites;
          await reply(request.id, { snapshot: (await ctx.storage.get(TABLE_KEY)) ?? null });
        } catch { await reply(request.id, { error: 'unavailable' }); }
      } else if (request.type === 'quedou:save') {
        if (typeof request.snapshot !== 'string' || request.snapshot.length > 32_768) return reply(request.id, { error: 'invalid' });
        const write = tableWrites.then(() => ctx.storage.set(TABLE_KEY, request.snapshot));
        tableWrites = write.catch(() => {});
        try { await write; await reply(request.id, { saved: true }); }
        catch { await reply(request.id, { error: 'unavailable' }); }
      } else if (request.type === 'quedou:list') {
        try {
          const models = (await ctx.models.list()).map((entry) => {
            const { modelKey, name, providerName, instant } = entry;
            return { modelKey, name, providerName, instant };
          });
          await reply(request.id, { models });
        } catch { await reply(request.id, { error: 'unavailable' }); }
      } else if (request.type === 'quedou:choose') await choose(request);
      else if (request.type === 'quedou:cancel' && active?.id === request.id) stop(active, 'cancelled');
    });
    const close = () => {
      if (disposed) return;
      disposed = true;
      if (active) stop(active, 'cancelled');
      messages.dispose();
      modelEvents?.dispose();
      disposal?.dispose();
    };
    const disposal = panel.onDidDispose(close);
    ctx.subscriptions.push({ dispose: close });
  }));
};
