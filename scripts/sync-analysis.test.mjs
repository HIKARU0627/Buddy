import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  abandonScan,
  analysisReadiness,
  analysisStillCurrent,
  autoCreationReasons,
  autoOperationReasons,
  candidateCommonReasons,
  publishScan,
  requestScan,
  resolveEntityState,
  scanCurrentReasons,
  toDeadline,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// ビルド後の domain を、手書きの期待値（fixtures）で検査する。
const { validators } = await loadContracts();
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));

test('sync scans are exclusive and publish only through compare-and-swap', async () => {
  const spec = await read('packages/contracts/fixtures/sync-scenarios.json');
  for (const scenario of spec.scenarios) {
    let scope = structuredClone(spec.initial_scope);
    const batches = new Map();
    for (const [number, step] of scenario.steps.entries()) {
      const label = `${scenario.id} #${number + 1} ${step.op}`;
      if (step.op === 'request') {
        const result = requestScan(scope, {
          scanId: step.scan,
          kind: step.kind,
          now: step.now,
        });
        if (result.action === 'held')
          assert.deepEqual(result, step.expected, label);
        else {
          assert.equal(result.action, step.expected.action, label);
          scope = result.scope;
          if (result.action === 'started') batches.set(step.scan, result.batch);
        }
      } else if (step.op === 'abandon') {
        const result = abandonScan(scope, batches.get(step.scan));
        scope = result.scope;
        batches.set(step.scan, result.batch);
      } else if (step.op === 'validate') {
        batches.set(step.scan, {
          ...batches.get(step.scan),
          status: 'validated',
        });
      } else if (step.op === 'set_scope') {
        scope = { ...scope, ...step.changes };
      } else if (step.op === 'check') {
        assert.deepEqual(
          scanCurrentReasons(scope, batches.get(step.scan)),
          step.expected,
          label,
        );
      } else if (step.op === 'publish') {
        const result = publishScan(scope, batches.get(step.scan), {
          diffCount: step.diff,
          providerCursor: step.cursor,
          completedAt: step.completedAt,
        });
        assert.deepEqual(
          result.ok ? { ok: true } : { ok: false, reasons: result.reasons },
          step.expected,
          label,
        );
        scope = result.scope;
        batches.set(step.scan, result.batch);
      } else throw new Error(`unknown op ${step.op}`);
      for (const [key, value] of Object.entries(step.scope ?? {}))
        assert.equal(scope[key], value, `${label} scope.${key}`);
      for (const [key, value] of Object.entries(step.batch ?? {}))
        assert.equal(
          batches.get(step.scan)[key],
          value,
          `${label} batch.${key}`,
        );
    }
  }
});

test('related analysis is not ready before enumeration and required analysis finish', async () => {
  const spec = await read('packages/contracts/fixtures/analysis-cases.json');
  for (const entry of spec.readiness) {
    const analysis = {
      ...structuredClone(spec.base_analysis),
      ...entry.changes,
    };
    if (entry.source) {
      const { index, ...change } = entry.source;
      analysis.sources[index] = { ...analysis.sources[index], ...change };
    }
    assert.deepEqual(
      analysisReadiness(analysis, spec.current_published_generation),
      entry.expected,
      entry.id,
    );
  }
  const base = spec.base_analysis;
  assert(analysisStillCurrent(base, base, spec.current_published_generation));
  assert(
    !analysisStillCurrent(
      { ...base, analysis_revision: '2' },
      base,
      spec.current_published_generation,
    ),
  );
  assert(
    !analysisStillCurrent(
      base,
      { ...base, sources: [{ state: 'pending', rule_id: null }] },
      spec.current_published_generation,
    ),
  );
});

test('cancellation wins regardless of analysis order and blocks recreation', async () => {
  const spec = await read('packages/contracts/fixtures/analysis-cases.json');
  const { entity_id, change_sets } = spec.order_independence;
  for (const set of change_sets) {
    assert.equal(
      resolveEntityState(entity_id, 'active', set.changes),
      set.expected,
      set.id,
    );
    assert.equal(
      resolveEntityState(entity_id, 'active', [...set.changes].reverse()),
      set.expected,
      `${set.id} reversed`,
    );
  }
  for (const entry of spec.auto_creation) {
    const entity = {
      request_entity_id: entity_id,
      state: entry.entity.state,
      recreation_suppressed: entry.entity.recreation_suppressed,
      created_operations: entry.entity.created,
    };
    assert.deepEqual(
      autoCreationReasons(entity, entry.changes, entry.operation),
      entry.expected,
      entry.id,
    );
  }
});

test('unknown years and mismatched evidence are never filled in by guessing', async () => {
  const spec = await read('packages/contracts/fixtures/extraction-cases.json');
  for (const entry of spec.cases) {
    const request = { ...structuredClone(spec.base_request), ...entry.request };
    const completeness = entry.completeness ?? {
      unread_source_ids: [],
      truncated_source_ids: [],
    };
    const context = { ...spec.base_context, ...entry.context };
    const received = entry.received_at_local ?? spec.received_at_local;
    for (const [key, expected] of Object.entries(entry.expected))
      assert.deepEqual(
        key === 'common'
          ? candidateCommonReasons(request, completeness, received)
          : autoOperationReasons(key, request, context),
        expected,
        `${entry.id} ${key}`,
      );
  }
  for (const entry of spec.deadlines) {
    const deadline = toDeadline(entry.wire, spec.zone);
    assert.deepEqual(deadline, entry.expected, entry.id);
    if (deadline) assert(validators.Deadline(deadline), entry.id);
  }
});

test('extraction wire output cannot claim completeness, positions or request IDs', () => {
  const wire = {
    language: 'ja',
    requests: [
      {
        kind: 'reply_required',
        summary: '参加可否の返信',
        deadline: {
          resolution: 'relative_unresolved',
          local_datetime: null,
          local_date: null,
          original_text: '10月7日まで',
          unresolved_reason: 'missing_year',
        },
        evidence: [
          {
            part: 'body',
            source_id: 'body',
            source_revision: 'r1',
            quote: '10月7日までに参加可否を返信してください',
          },
        ],
        in_quoted_text: false,
        confidence: 'medium',
      },
    ],
    changes: [],
  };
  assert(validators.ExtractionWire(wire));
  for (const extra of [
    { unread_sources: [] },
    { unread_truncated: false },
    { completeness: {} },
  ])
    assert(
      !validators.ExtractionWire({ ...wire, ...extra }),
      JSON.stringify(extra),
    );
  const request = wire.requests[0];
  for (const extra of [{ request_entity_id: 'x' }, { addressed_to_me: true }])
    assert(
      !validators.ExtractionWire({
        ...wire,
        requests: [{ ...request, ...extra }],
      }),
      JSON.stringify(extra),
    );
  assert(
    !validators.ExtractionWire({
      ...wire,
      requests: [
        {
          ...request,
          evidence: [{ ...request.evidence[0], start: 0, end: 5 }],
        },
      ],
    }),
  );
  assert.deepEqual(
    semanticErrors('SourceRef', {
      source_id: 'body',
      source_revision: 'r1',
      quote: 'x',
      start: 5,
      end: 5,
    }),
    ['quote_range'],
  );
});
