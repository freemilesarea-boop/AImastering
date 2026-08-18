// track-metrics-selftest — the audio thread must not be able to drive React.
//
// A DAW session runs one chain per track and each posts metrics ten times a
// second. Twelve tracks is 120 messages a second arriving on the main thread
// from the audio thread's schedule.
//
// The history here is specific. An earlier realtime integration turned every
// worklet message into a `setState`. The re-render produced new callback
// identities, which invalidated the effect that owned the worklet, which
// re-attached it — producing more messages. The loop ran at audio rate and
// took the renderer process down, and realtime preview was hard-disabled in
// response.
//
// So the store's contract is not "be careful": ingesting must notify NOBODY,
// and the only thing that may notify is the timer. That is measurable, and
// this file measures it — including a control that shows the counter would
// have caught the old behaviour.
//
// Run:  pnpm --filter @aimaster/desktop test:track-metrics

import {
  ingestTrackMetrics, clearTrackMetrics, resetTrackMetrics,
  flushTrackMetrics, subscribeTrackMetrics,
  getTrackMetrics, getTrackMetricsMap, getTrackMetricsServer,
  trackMetricsNotifyCount, EMPTY_METRICS,
} from '../src/renderer/audio/track-metrics-store.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** A metrics message shaped like the one the worklet actually posts. */
function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'metrics',
    audioBlocks: 128,
    bypass: false,
    avgProcessMs: 0.4,
    peakProcessMs: 0.9,
    blockPeriodMs: 2.67,
    xruns: 0,
    safetyEvents: 0,
    limiterGrDb: 1.5,
    dynamicsGrDb: 3.25,
    multibandGrDb: [1, 2, 3, 4],
    deessGrDb: 0.5,
    dehumDepthDb: 6,
    dynamicEqGainsDb: [0, -1, 0, 0, 0, 0],
    impactMoveDb: 0.25,
    lowEndFocusMoveDb: -0.5,
    tonalCurveDb: [-20, -18, -16],
    denoiseProfileDb: [-60, -58],
    latencySamples: 2048,
    monitorActive: false,
    loudnessDeltaDb: 1.1,
    matchGainDb: 0,
    dryLufs: -18.2,
    wetLufs: -14.0,
    ...over,
  };
}

console.log('\n=== INGEST NEVER NOTIFIES ===\n');
{
  resetTrackMetrics();
  let notifications = 0;
  const unsubscribe = subscribeTrackMetrics(() => { notifications++; });

  const MESSAGES = 1000;
  for (let i = 0; i < MESSAGES; i++) {
    ingestTrackMetrics(`track-${i % 12}`, message({ dynamicsGrDb: i % 20 }));
  }
  check(
    'a thousand messages across twelve tracks notify nobody',
    notifications === 0,
    `알림 ${notifications}회 — 0이 아니면 오디오 스레드가 렌더를 몰고 있다`,
  );

  // Nothing is visible until a tick, which is the other half of the same
  // guarantee: React reads a snapshot, not a moving object.
  check(
    'and nothing is visible before the first tick',
    getTrackMetricsMap().size === 0,
    `스냅샷 ${getTrackMetricsMap().size}개`,
  );

  flushTrackMetrics();
  check(
    'one tick publishes all twelve at once',
    notifications === 1 && getTrackMetricsMap().size === 12,
    `알림 ${notifications}회, 트랙 ${getTrackMetricsMap().size}개 — 메시지 ${MESSAGES}개당 렌더 1회`,
  );

  // The control: if the counter could not see notifications, the check above
  // would pass for the wrong reason.
  const before = notifications;
  ingestTrackMetrics('track-0', message());
  flushTrackMetrics();
  check(
    'control — the counter does move when the store publishes',
    notifications === before + 1,
    `${before} → ${notifications}`,
  );

  unsubscribe();
}

console.log('\n=== A QUIET TICK IS NOT A RENDER ===\n');
{
  resetTrackMetrics();
  let notifications = 0;
  const unsubscribe = subscribeTrackMetrics(() => { notifications++; });
  ingestTrackMetrics('a', message());
  flushTrackMetrics();
  const afterFirst = notifications;

  for (let i = 0; i < 50; i++) flushTrackMetrics();
  check(
    'fifty ticks with nothing new notify nobody',
    notifications === afterFirst,
    `알림 ${notifications}회 — 조용한 세션은 UI를 깨우지 않는다`,
  );
  unsubscribe();
}

console.log('\n=== SNAPSHOT IDENTITY ===\n');
{
  resetTrackMetrics();
  ingestTrackMetrics('a', message());
  flushTrackMetrics();
  const first = getTrackMetricsMap();
  flushTrackMetrics();
  check(
    'a tick with no changes keeps the same snapshot object',
    getTrackMetricsMap() === first,
    'useSyncExternalStore가 같은 스냅샷을 보면 리렌더하지 않는다',
  );

  ingestTrackMetrics('a', message({ dynamicsGrDb: 9 }));
  flushTrackMetrics();
  check(
    'and a change replaces it',
    getTrackMetricsMap() !== first,
    '새 객체 — 제자리 수정이면 변화를 놓친다',
  );
}

console.log('\n=== PER TRACK ===\n');
{
  resetTrackMetrics();
  ingestTrackMetrics('kick', message({ dynamicsGrDb: 6, limiterGrDb: 0 }));
  ingestTrackMetrics('vocal', message({ dynamicsGrDb: 1.5, deessGrDb: 4 }));
  flushTrackMetrics();

  const kick = getTrackMetrics('kick');
  const vocal = getTrackMetrics('vocal');
  check(
    'each track keeps its own reading',
    kick.dynamicsGrDb === 6 && vocal.dynamicsGrDb === 1.5 && vocal.deessGrDb === 4,
    `kick ${kick.dynamicsGrDb} dB GR, vocal ${vocal.dynamicsGrDb} dB GR / ${vocal.deessGrDb} dB de-ess`,
  );
  check(
    'arrays survive the crossing intact',
    kick.multibandGrDb.length === 4 && kick.multibandGrDb[3] === 4
      && kick.tonalCurveDb.length === 3 && kick.denoiseProfileDb.length === 2,
    `multiband ${kick.multibandGrDb.join('/')}, tonal ${kick.tonalCurveDb.length} bands`,
  );
  check(
    '-Infinity survives, because silence is a real reading',
    getTrackMetrics('kick').dryLufs === -18.2
      && parseWorkletSilence() === Number.NEGATIVE_INFINITY,
    '무음을 0으로 바꾸면 라우드니스 표시가 거짓말을 한다',
  );

  const unknown = getTrackMetrics('a-track-that-never-reported');
  check(
    'a track that never reported reads as empty, by identity',
    unknown === EMPTY_METRICS,
    '같은 객체 — 조용한 트랙의 패널은 매 틱마다 리렌더되지 않는다',
  );
  check('and as not running', unknown.running === false, 'running=false → 뷰가 유휴 상태를 그린다');
  check('a null id is empty too', getTrackMetrics(null) === EMPTY_METRICS, '선택된 트랙이 없을 때');
}

function parseWorkletSilence(): number {
  resetTrackMetrics();
  ingestTrackMetrics('silent', message({ dryLufs: Number.NEGATIVE_INFINITY }));
  flushTrackMetrics();
  const v = getTrackMetrics('silent').dryLufs;
  // Put the fixture back for anything after this.
  resetTrackMetrics();
  ingestTrackMetrics('kick', message({ dynamicsGrDb: 6, limiterGrDb: 0 }));
  flushTrackMetrics();
  return v;
}

console.log('\n=== TEARDOWN ===\n');
{
  resetTrackMetrics();
  ingestTrackMetrics('a', message());
  ingestTrackMetrics('b', message());
  flushTrackMetrics();
  check('two tracks are published', getTrackMetricsMap().size === 2, '2개');

  clearTrackMetrics('a');
  flushTrackMetrics();
  check(
    'removing one track drops only that one',
    getTrackMetricsMap().size === 1 && getTrackMetrics('a') === EMPTY_METRICS,
    `남은 트랙 ${getTrackMetricsMap().size}개`,
  );

  // Clearing a track that was never there must not mark the store dirty —
  // otherwise a teardown loop over a dozen ids would publish a dozen times.
  const before = trackMetricsNotifyCount();
  clearTrackMetrics('never-existed');
  flushTrackMetrics();
  check(
    'clearing an absent track publishes nothing',
    trackMetricsNotifyCount() === before,
    `알림 ${trackMetricsNotifyCount() - before}회`,
  );

  resetTrackMetrics();
  check('reset empties the store', getTrackMetricsMap().size === 0, '0개');

  const idle = trackMetricsNotifyCount();
  resetTrackMetrics();
  check(
    'and resetting an empty store publishes nothing',
    trackMetricsNotifyCount() === idle,
    '이미 비어 있으면 알림 없음',
  );
}

console.log('\n=== SERVER SNAPSHOT ===\n');
{
  check(
    'the server snapshot is constant',
    getTrackMetricsServer() === getTrackMetricsServer(),
    'useSyncExternalStore는 하이드레이션 때 이걸 부른다 — 매번 새 객체면 무한 루프',
  );
  check('and empty', getTrackMetricsServer().size === 0, '0개');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
