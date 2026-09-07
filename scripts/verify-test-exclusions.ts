/**
 * Tracked test-suite exclusion ratchet.
 *
 * A handful of legacy test suites were written against APIs that drifted
 * during refactors and never passed in CI (their failures were part of why CI
 * was historically red). Excluding them silently would recreate #895 — suites
 * that never run and nobody notices. This script makes every exclusion
 * *visible and bounded*, mirroring the ratchet pattern used by
 * scripts/lint-budget.ts / scripts/typecheck-budget.ts / scripts/validate-routes.ts:
 *
 *   1. Every entry in vitest.config.ts's `test.exclude` (except the orphaned-
 *      router integration harness, which is governed by validate-routes) MUST
 *      have a matching record in the EXCLUDED_SUITES registry below, stating
 *      why it is excluded and what re-enabling requires.
 *   2. Every registry record MUST point at a real test file that is still
 *      collected by vitest's include globs — a registry entry for a deleted or
 *      re-enabled file fails CI, so the registry cannot rot.
 *   3. The number of excluded suites cannot exceed MAX_EXCLUDED_SUITES, so a
 *      new exclusion needs an explicit, deliberate decision to raise it (the
 *      same pressure the other ratchets apply to their budgets).
 *
 * Re-enabling a suite: make it pass (`npx vitest run <file>`), delete its
 * record here, and remove the path from vitest.config.ts's exclude list. The
 * suite is then part of the default run again.
 *
 * Usage:
 *   npx ts-node scripts/verify-test-exclusions.ts
 *   npm run test:exclusions
 */

import * as path from 'path';
import * as glob from 'glob';
import vitestConfig from '../vitest.config';

// Pre-existing exclusion that is NOT tracked as debt — it is an integration
// harness driven by scripts/validate-routes.ts instead of the default suite.
const NON_DEBT_EXCLUSIONS = new Set(['tests/orphaned-routers-integration.test.ts']);

// Ceiling on tracked debt exclusions. Lower it as suites are re-enabled.
// Raising it requires a deliberate decision documented in
// docs/test-suite-debt-tracking.md.
const MAX_EXCLUDED_SUITES = 9;

/**
 * Registry of deliberately excluded test suites. `path` must match exactly the
 * vitest.config.ts exclude entry (relative to repo root).
 */
const EXCLUDED_SUITES: Array<{ path: string; reason: string; reEnable: string }> = [
  {
    path: 'tests/verification-engine.test.ts',
    reason:
      '32-test suite written against verification APIs that drifted during the class-based ' +
      'refactor of src/verification: BadgeSystem.evaluateBadge, SymbolicExecutor()/execute(wasmFunc), ' +
      'SpecCompiler.compile(spec)/decompile, plus Differential/Gas/Exploit/Reentrancy suites ' +
      'exercising behavior the shipped classes do not expose.',
    reEnable:
      'Rewrite each describe block against the real exported classes (SmtSolver.solve, ' +
      'SpecCompiler.compileProperty, BadgeSystem.issueBadge, ReentrancyAnalyzer.analyze, ...) and ' +
      'drop the z3 install step only after no suite shells out to a solver.',
  },
  {
    path: 'tests/graph-database.test.ts',
    reason:
      'Neo4j-backed graph performance suite (~40 tests) that requires a live graph database; CI ' +
      'provides Postgres only, and several fixtures use invalid strkeys / expect APIs the graph ' +
      'backend does not implement.',
    reEnable:
      'Either add a Neo4j service to the CI test job and validate fixtures, or convert the suite to ' +
      'drive the in-memory/prisma graph backend with the real exported template/analytics functions.',
  },
  {
    path: 'tests/health-endpoints.test.ts',
    reason:
      'Mocks were written before health checks grew live probes for rpc/indexer/worker/p2p, cache ' +
      'pingRedis/cacheBackendType, staleness gates (fee-aggregator/gasAnalyticsEngine) and the ' +
      'readiness dependency set expanded from 4 to 7 keys (rpc/p2p/worker added).',
    reEnable:
      'Extend the vi.mock set to the modules src/health.ts actually imports and update the ' +
      'readiness toEqual assertions to the 7-key dependency set.',
  },
  {
    path: 'tests/indexer/reorg.test.ts',
    reason:
      'IndexerState persistence moved to optimistic-concurrency findFirst/updateMany writes, but ' +
      'the suite mocks the old upsert-only API and drives syncToLatest with a static mock queue, ' +
      'so getLastIndexedLedger/setLastIndexedLedger never resolve as the tests assume.',
    reEnable:
      'Rewire the suite mocks around findFirst + updateMany (a mutable last-ledger stub) so the ' +
      'sync/backfill loop converges to the asserted ledger sequence.',
  },
  {
    path: 'tests/i18n.test.ts',
    reason:
      'Asserts specific translation keys/counts/default-language behavior that drifted from the ' +
      'shipped locale dictionaries (missing general.ok-style keys, keyCount mismatches, fr/en ' +
      'fallback differences).',
    reEnable:
      'Audit the locale dictionaries against the test expectations and reconcile either the ' +
      'dictionaries or the assertions to the real supported-language contract.',
  },
  {
    path: 'tests/playground-session.test.ts',
    reason:
      'Mocks for @stellar/stellar-sdk and the sandbox runtime drifted: the suite builds simulated ' +
      'transactions whose error strings/objects no longer match the sandbox output and stubs SDK ' +
      'types without the methods the transaction builder now calls.',
    reEnable:
      'Update the SDK/sandbox mocks to the current runtime contract (valid XDR fixtures, ' +
      'simulation result shape) and align asserted error messages with sandbox output.',
  },
  {
    path: 'tests/predictive.test.ts',
    reason:
      'Route handlers return 500 under the current forecasting/ensemble engine (the suite mocks a ' +
      'db shape the handlers no longer read through, and the ensemble/anomaly handlers depend on ' +
      'internal state that is absent in tests).',
    reEnable:
      'Re-derive the handler dependencies from src/api/predict and mock the exact model registry ' +
      'the handlers use, then assert real forecast payloads.',
  },
  {
    path: 'tests/ws-broadcasters.test.ts',
    reason:
      'Broadcaster tests expect subscriber/ack counts and pub-sub delivery semantics that drifted ' +
      'from the current WebSocket broadcaster implementations (also no Redis service in CI).',
    reEnable:
      'Reconcile the assertions with the broadcaster implementation (or supply an in-process ' +
      'pub-sub backend) so delivery/ack counts match real behavior.',
  },
  {
    path: 'tests/api/error-scenarios.test.ts',
    reason:
      'Three assertions drift from the shipped API surface: too-short account addresses return 200 ' +
      '(no query-param validation), non-numeric pagination params are accepted, and contract ' +
      'registration conflict bodies no longer contain the word "conflict".',
    reEnable:
      'Add query-param validation to the transactions route (400 for malformed account/page/limit), ' +
      'and assert the actual 409 conflict body wording.',
  },
];

const ROOT = path.join(__dirname, '..');

function main(): void {
  const errors: string[] = [];
  const testConfig = vitestConfig.test ?? {};
  const include = (testConfig.include as string[] | undefined) ?? [];
  const exclude = (testConfig.exclude as string[] | undefined) ?? [];

  const debtExcluded = exclude.filter((f) => !NON_DEBT_EXCLUSIONS.has(f));
  const registryPaths = new Set(EXCLUDED_SUITES.map((e) => e.path));

  // 1. Every debt exclusion in vitest.config.ts must be registered.
  for (const file of debtExcluded) {
    if (!registryPaths.has(file)) {
      errors.push(
        `vitest.config.ts excludes "${file}" but it has no record in EXCLUDED_SUITES ` +
          `(scripts/verify-test-exclusions.ts). Add a record with a reason and re-enable ` +
          `criteria, or remove the exclusion.`,
      );
    }
  }

  // 2. Every registry entry must be a real, still-collected test file that is
  //    actually excluded (no dead or prematurely re-enabled records).
  const collected = new Set<string>();
  for (const pattern of include) {
    for (const f of glob.sync(pattern, { cwd: ROOT, nodir: true })) collected.add(f);
  }
  for (const entry of EXCLUDED_SUITES) {
    if (!collected.has(entry.path)) {
      errors.push(
        `EXCLUDED_SUITES references "${entry.path}" which is no longer collected by vitest's ` +
          `include globs. Delete the record (the file was removed or re-enabled).`,
      );
      continue;
    }
    if (!exclude.includes(entry.path)) {
      errors.push(
        `EXCLUDED_SUITES has "${entry.path}" but vitest.config.ts no longer excludes it. ` +
          `If the suite now passes, remove the record too — otherwise restore the exclusion.`,
      );
    }
  }

  // 3. Ceiling on the debt pile.
  if (debtExcluded.length > MAX_EXCLUDED_SUITES) {
    errors.push(
      `${debtExcluded.length} tracked test-suite exclusions exceed MAX_EXCLUDED_SUITES ` +
        `(${MAX_EXCLUDED_SUITES}). Raising the ceiling requires a documented decision in ` +
        `docs/test-suite-debt-tracking.md — prefer re-enabling suites instead.`,
    );
  }

  if (errors.length > 0) {
    console.error(`\n${errors.join('\n\n')}\n`);
    process.exit(1);
  }

  const remainingBudget = MAX_EXCLUDED_SUITES - debtExcluded.length;
  console.log(
    `Tracked test-suite exclusions: ${debtExcluded.length}/${MAX_EXCLUDED_SUITES} ` +
      `(budget remaining: ${remainingBudget}).`,
  );
  console.log('Registry is in sync with vitest.config.ts. OK');
}

main();
