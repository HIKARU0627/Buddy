import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import {
  ROUTE_CHECKS,
  admitRequest,
  apiCompatibility,
  applyEvents,
  checkPairingCode,
  ioStopProgress,
  leaseReasons,
  replayDecision,
  tokenPickup,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// OpenAPI（形式）と domain の経路検査（認可・状態）を、手書きの期待値で照合する。
const { schema, validators } = await loadContracts();
const openapiPath = fileURLToPath(
  new URL('packages/contracts/openapi.yaml', root),
);
const spec = await SwaggerParser.parse(openapiPath);
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));
const cases = await read('packages/contracts/fixtures/api-cases.json');
const scenarios = await read('packages/contracts/fixtures/api-scenarios.json');
const SCHEMA_REF = './schemas/buddy.schema.json#/$defs/';

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => ['get', 'post', 'put', 'delete'].includes(method))
    .map(([method, operation]) => ({ path, method, ...operation })),
);
const refName = (ref) => {
  assert(ref.startsWith(SCHEMA_REF), ref);
  return ref.slice(SCHEMA_REF.length);
};
const resolveParameter = (parameter) =>
  parameter.$ref
    ? spec.components.parameters[parameter.$ref.split('/').pop()]
    : parameter;

test('every OpenAPI reference resolves to a schema definition or component', async () => {
  await SwaggerParser.dereference(openapiPath, { resolve: { http: false } });
  const refs = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object')
      for (const [key, value] of Object.entries(node))
        if (key === '$ref') refs.push(value);
        else walk(value);
  };
  walk(spec);
  assert(refs.length > 100);
  for (const ref of refs) {
    if (ref.startsWith('#/components/')) {
      const [, , kind, name] = ref.split('/');
      assert(spec.components[kind]?.[name], ref);
    } else assert(schema.$defs[refName(ref)], ref);
  }
});

test('route checks in OpenAPI and domain are the same table', () => {
  const ids = operations.map((operation) => operation.operationId).sort();
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, Object.keys(ROUTE_CHECKS).sort());
  for (const operation of operations)
    assert.deepEqual(
      operation['x-buddy-core-checks'],
      [...ROUTE_CHECKS[operation.operationId]],
      operation.operationId,
    );
  // 認証前の経路だけが端末トークンを求めない。秘密を URL クエリーに置かない。
  assert.deepEqual(
    operations
      .filter((operation) => Array.isArray(operation.security))
      .map((operation) => operation.operationId)
      .sort(),
    ['claimPairing', 'pickupPairingToken'],
  );
  for (const operation of operations)
    for (const parameter of (operation.parameters ?? []).map(resolveParameter))
      if (parameter.in === 'query')
        assert.equal(parameter.name, 'cursor', operation.operationId);
});

const REQUIRED_REJECTIONS = {
  device_token: [401, 'unauthenticated'],
  claim_secret: [401, 'unauthenticated'],
  home_network: [403, 'outside_home_network'],
  command_scope: [410, 'expired_scope'],
  unlocked: [403, 'device_locked'],
  screen_operation: [403, 'screen_operation_required'],
  hub_screen: [403, 'hub_screen_required'],
  audio_owner: [409, 'audio_owned_elsewhere'],
  expected_revision: [409, 'conflict'],
};

test('each endpoint has a valid request and response and rejects missing auth, stale scope and stale versions', () => {
  const ok = cases.contexts.ok;
  const context = (name) => ({ ...ok, ...cases.contexts[name] });
  const codes = new Set(schema.$defs.ApiError.properties.code.enum);
  for (const operation of operations) {
    const id = operation.operationId;
    const entry = cases.operations[id];
    assert(entry, `missing fixture for ${id}`);
    for (const parameter of (operation.parameters ?? []).map(
      resolveParameter,
    )) {
      if (parameter.in === 'header') continue;
      const value = entry.params?.[parameter.name];
      assert(value !== undefined, `${id} ${parameter.name}`);
      assert(validators[refName(parameter.schema.$ref)](value), `${id} param`);
    }
    const requestRef =
      operation.requestBody?.content['application/json'].schema.$ref;
    if (requestRef) {
      const validate = validators[refName(requestRef)];
      assert(
        validate(entry.request),
        `${id}: ${JSON.stringify(validate.errors)}`,
      );
      assert.deepEqual(
        semanticErrors(refName(requestRef), entry.request),
        [],
        id,
      );
      assert(entry.invalid_bodies?.length > 0, `${id} has no invalid body`);
      for (const invalid of entry.invalid_bodies)
        assert(!validate(invalid), `${id} accepted ${JSON.stringify(invalid)}`);
      assert(operation.responses['422'], id);
    } else assert.equal(entry.request, undefined, id);
    const [status, success] = Object.entries(operation.responses).find(
      ([code]) => code.startsWith('1') || code.startsWith('2'),
    );
    if (status === '101') {
      const validate =
        validators[refName(operation['x-buddy-websocket-message'].$ref)];
      for (const message of entry.messages) assert(validate(message), id);
      for (const message of entry.invalid_messages)
        assert(!validate(message), id);
    } else {
      const name = refName(success.content['application/json'].schema.$ref);
      assert(
        validators[name](entry.response),
        `${id}: ${JSON.stringify(validators[name].errors)}`,
      );
      assert.deepEqual(semanticErrors(name, entry.response), [], id);
    }
    assert.deepEqual(admitRequest(id, ok), { ok: true }, id);
    for (const name of entry.accepted_contexts ?? [])
      assert.deepEqual(
        admitRequest(id, context(name)),
        { ok: true },
        `${id} ${name}`,
      );
    for (const [name, expectedStatus, code] of entry.rejections) {
      assert.deepEqual(
        admitRequest(id, context(name)),
        { ok: false, status: expectedStatus, code },
        `${id} ${name}`,
      );
      assert(
        operation.responses[String(expectedStatus)],
        `${id} does not declare ${expectedStatus}`,
      );
      assert(codes.has(code), code);
    }
    for (const check of ROUTE_CHECKS[id]) {
      const [expectedStatus, code] = REQUIRED_REJECTIONS[check];
      assert(
        entry.rejections.some(([, s, c]) => s === expectedStatus && c === code),
        `${id} lacks a ${check} rejection`,
      );
    }
  }
});

test('local invariants of API responses are checked semantically', () => {
  const snapshot = cases.operations.getSnapshot.response;
  assert.deepEqual(
    semanticErrors('Snapshot', { ...snapshot, view: 'management_only' }),
    ['content_in_management_view'],
  );
  const stop = cases.operations.stopIo.response;
  assert.deepEqual(
    semanticErrors('IoStopResult', { ...stop, all_confirmed: true }),
    ['all_confirmed_mismatch'],
  );
});

test('replays, event order, leases and stop acknowledgements follow the reconnect rules', () => {
  for (const entry of scenarios.replay.cases)
    assert.equal(
      replayDecision(scenarios.replay.receipts, entry.request),
      entry.expected,
      entry.id,
    );
  const { snapshot, ...eventCases } = scenarios.events;
  for (const [id, entry] of Object.entries(eventCases)) {
    const result = applyEvents(snapshot, entry.events);
    assert.deepEqual(result.applied, entry.expected.applied, id);
    assert.deepEqual(result.ignored, entry.expected.ignored, id);
    assert.deepEqual(result.view.revisions, entry.expected.revisions, id);
    assert.equal(result.resnapshot, entry.expected.resnapshot, id);
  }
  for (const entry of scenarios.lease.cases)
    assert.deepEqual(
      leaseReasons(scenarios.lease.lease, entry.current),
      entry.expected,
      entry.id,
    );
  for (const entry of scenarios.io_stop)
    assert.deepEqual(
      ioStopProgress(entry.devices, entry.now_mono_ms),
      entry.expected,
      entry.id,
    );
});

test('pairing codes expire, count failures and hand out the token once', () => {
  const { initial, steps, exhaustion, expiry } = scenarios.pairing;
  let pairing = initial;
  for (const [index, step] of steps.entries()) {
    const result = checkPairingCode(pairing, step.code, step.now);
    const label = `#${index + 1}`;
    assert.equal(result.ok, step.expected.ok, label);
    assert.equal(result.reason, step.expected.reason, label);
    assert.equal(
      result.pairing.attempts_left,
      step.expected.attempts_left,
      label,
    );
    pairing = result.pairing;
  }
  pairing = initial;
  for (let i = 0; i < exhaustion.wrong_attempts; i += 1)
    pairing = checkPairingCode(
      pairing,
      '99999999',
      exhaustion.then.now,
    ).pairing;
  const exhausted = checkPairingCode(
    pairing,
    exhaustion.then.code,
    exhaustion.then.now,
  );
  assert.equal(exhausted.ok, exhaustion.expected.ok);
  assert.equal(exhausted.reason, exhaustion.expected.reason);
  assert.equal(
    exhausted.pairing.attempts_left,
    exhaustion.expected.attempts_left,
  );
  const expired = checkPairingCode(initial, expiry.code, expiry.now);
  assert.equal(expired.reason, expiry.expected.reason);
  assert.equal(expired.pairing.attempts_left, expiry.expected.attempts_left);
  for (const entry of scenarios.token_pickup)
    assert.deepEqual(
      tokenPickup(entry.claim, entry.secret_matches, entry.now),
      entry.expected,
      entry.id,
    );
  for (const entry of scenarios.api_compatibility)
    assert.equal(
      apiCompatibility(entry.server, entry.client_majors),
      entry.expected,
    );
});
