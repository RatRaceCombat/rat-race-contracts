// The real time rules of the contracts (their production values: testMode() false) and the
// distributor's Limits, for the tests and the deploy scripts. A test deployment passes shorter ones.
const DAY = 86400;

/** RatRaceDistributor.Timings: its realTimings(). */
const REAL_DIST = Object.freeze({
  timelock: 3 * DAY,
  timelockRaise: 7 * DAY,
  timelockLong: 14 * DAY,
  executionWindow: 14 * DAY,
  pauseMax: 4 * DAY,
  pausePeriod: 30 * DAY,
});

/** RatRacePot.Timings: its real ones. */
const REAL_POT = Object.freeze({
  timelock: 3 * DAY,
  timelockLong: 14 * DAY,
  executionWindow: 14 * DAY,
  pauseMax: 4 * DAY,
  pausePeriod: 30 * DAY,
});

/** RatRaceSkins.RatSplit [potBps, referralBps]: a RAT purchase's 5% to the pot, 5% to the referrer. */
const REAL_SPLIT = Object.freeze([500, 500]);

/** A test deployment's time rules (TEST=1, the backoffice's TEST profile): an hour for a change, two for a
 *  raise or a guardian, a day to execute, two hours of pause; the real margins kept (pauseMax >= timelock
 *  + min(1 day, timelock), pausePeriod > pauseMax). */
const TEST_DIST = Object.freeze({ timelock: 3600, timelockRaise: 7200, timelockLong: 7200, executionWindow: DAY, pauseMax: 7200, pausePeriod: 14400 });
const TEST_POT = Object.freeze({ timelock: 3600, timelockLong: 7200, executionWindow: DAY, pauseMax: 7200, pausePeriod: 14400 });

/** RatRaceDistributor.Limits. */
const limits = (delay, maxStepWithdraw, maxStepSettle, maxBounty, outflowCap, burnCap) => ({ delay, maxStepWithdraw, maxStepSettle, maxBounty, outflowCap, burnCap });

/** FoundersSaleLock.Grid: its realGrid() ($0.025, +0.5% a level, 695 levels, released within 10% of the best bid,
 *  400,000 RAT, 10,000 a day, a change 14 days ahead then 7 days to apply it, at most 2,000 RAT an hour). */
const REAL_SALE = Object.freeze({ floorUsd8: 2_500_000, stepBps: 50, levels: 695, windowBps: 1000, total: 400_000n * 10n ** 18n, dayCap: 10_000n * 10n ** 18n, changeDelay: 3 * DAY, recoveryDelay: 30 * DAY, executionWindow: 7 * DAY, rateCap: 2_000n * 10n ** 18n, rateWindow: 3600 });
/** A TEST sale lock: a floor near today's price ($0.004) so releases show soon, 0.1% of the RAT (400, 10 a day),
 *  10 minutes for a change or a recovery, an hour to apply it, at most 2 RAT every 10 minutes. */
const TEST_SALE = Object.freeze({ floorUsd8: 400_000, stepBps: 50, levels: 695, windowBps: 1000, total: 400n * 10n ** 18n, dayCap: 10n * 10n ** 18n, changeDelay: 600, recoveryDelay: 600, executionWindow: 3600, rateCap: 2n * 10n ** 18n, rateWindow: 600 });

module.exports = { DAY, REAL_DIST, REAL_POT, REAL_SPLIT, TEST_DIST, TEST_POT, REAL_SALE, TEST_SALE, limits };
