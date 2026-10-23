// 経路の表（api-routes.ts）が OpenAPI（packages/contracts/openapi.yaml）と同じであることの試験（ADR 0020）。
// OpenAPI の YAML を試験の中で読み、方法・パス・パスの値・クエリー・本文の定義名・Buddy-Input-Origin・101 を照合する。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import { DEVICE_TOKEN_PATTERN } from './api-auth.js';
import { ROUTE_CHECKS } from '@buddy/domain';
import { DECLARED_LOCK_STATES } from './api-environment.js';
import { API_ROUTES, matchRoute } from './api-routes.js';
import { API_VERSION, INPUT_ORIGINS } from './api-server.js';

const SCHEMA_REF = './schemas/buddy.schema.json#/$defs/';

interface Parameter {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: {
    readonly $ref?: string;
    readonly enum?: readonly string[];
  };
}
interface Operation {
  readonly operationId: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: {
    readonly content: Readonly<
      Record<string, { readonly schema: { readonly $ref: string } }>
    >;
  };
  readonly responses: Readonly<Record<string, unknown>>;
}
interface Spec {
  readonly info: { readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components: {
    readonly parameters: Readonly<Record<string, Parameter>>;
    readonly schemas?: unknown;
  };
}

const spec = parse(
  await readFile(
    new URL('../../../packages/contracts/openapi.yaml', import.meta.url),
    'utf8',
  ),
) as Spec;
const schema = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/contracts/schemas/buddy.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  $defs: Record<string, { properties?: Record<string, { pattern?: string }> }>;
};

const resolve = (parameter: Parameter): Parameter =>
  parameter.$ref
    ? (spec.components.parameters[parameter.$ref.split('/').pop() ?? ''] ?? {})
    : parameter;
const defName = (ref: string | undefined): string => {
  if (ref === undefined || !ref.startsWith(SCHEMA_REF))
    throw new Error(`unexpected schema reference: ${String(ref)}`);
  return ref.slice(SCHEMA_REF.length);
};

test(
  'the route table matches every OpenAPI operation',
  { timeout: 30_000 },
  () => {
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({
        path,
        method: method.toUpperCase(),
        operation,
      })),
    );
    assert.equal(operations.length, API_ROUTES.length);
    for (const { path, method, operation } of operations) {
      const route = API_ROUTES.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      assert(route, operation.operationId);
      const id = operation.operationId;
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      const parameters = (operation.parameters ?? []).map(resolve);
      const pathParams = Object.fromEntries(
        parameters
          .filter((parameter) => parameter.in === 'path')
          .map((parameter) => [
            parameter.name,
            defName(parameter.schema?.$ref),
          ]),
      );
      assert.deepEqual(route.pathParams, pathParams, id);
      const query = Object.fromEntries(
        parameters
          .filter((parameter) => parameter.in === 'query')
          .map((parameter) => {
            assert.equal(parameter.required, true, id);
            return [parameter.name, defName(parameter.schema?.$ref)];
          }),
      );
      assert.deepEqual(route.query, query, id);
      const inputOrigin = parameters.some(
        (parameter) =>
          parameter.in === 'header' && parameter.name === 'Buddy-Input-Origin',
      );
      assert.equal(route.inputOrigin, inputOrigin, id);
      const body =
        operation.requestBody?.content['application/json']?.schema.$ref;
      assert.equal(route.body, body === undefined ? null : defName(body), id);
      assert.equal(route.websocket, '101' in operation.responses, id);
    }
    // 要求の起点の値・API の版・端末トークンの形式も契約と同じ。
    assert.deepEqual(
      [...INPUT_ORIGINS],
      [...(spec.components.parameters['InputOrigin']?.schema?.enum ?? [])],
    );
    assert.equal(
      API_VERSION,
      spec.info.version.split('.').slice(0, 2).join('.'),
    );
    assert.equal(
      DEVICE_TOKEN_PATTERN.source,
      schema.$defs['DeviceCredential']?.properties?.['device_token']?.pattern,
    );
  },
);

test(
  'Buddy-Lock-State is optional and declared exactly on the routes that use the lock state (ADR 0025)',
  { timeout: 30_000 },
  () => {
    const lock = spec.components.parameters['LockState'];
    assert.equal(lock?.name, 'Buddy-Lock-State');
    assert.equal(lock?.in, 'header');
    assert.equal(lock?.required, false);
    assert.deepEqual(
      [...(lock?.schema?.enum ?? [])],
      [...DECLARED_LOCK_STATES],
    );
    // unknown は申告しない（送らない）値なので列挙にない。
    assert(!(lock?.schema?.enum ?? []).includes('unknown'));
    const declared = Object.values(spec.paths)
      .flatMap((item) => Object.values(item))
      .filter((operation) =>
        (operation.parameters ?? []).some(
          (parameter) => parameter.$ref === '#/components/parameters/LockState',
        ),
      )
      .map((operation) => operation.operationId)
      .sort();
    const expected = Object.entries(ROUTE_CHECKS)
      .filter(
        ([id, checks]) => checks.includes('unlocked') || id === 'getSnapshot',
      )
      .map(([id]) => id)
      .sort();
    assert.deepEqual(declared, expected);
    // 内容の表示用の読み取り（displayOperation、ADR 0031）・流れへの発言（postStreamTurn、ADR 0032）・キャンバスの
    // 読み取り（getCanvas、UI-03）で 3 つ、予算の 4 経路（ADR 0034）で 4 つ、キャンバスのユーザーの操作の記録
    // （postCanvasUserOp、UI-06）で 1 つ増えた。
    assert.equal(declared.length, 32);
  },
);

test(
  'route matching prefers literal segments and separates 404 from 405',
  { timeout: 30_000 },
  () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const ok = (method: string, path: string) => {
      const match = matchRoute(method, path);
      assert(match.ok, `${method} ${path}`);
      return match;
    };
    assert.equal(
      ok('POST', '/v1/connections/oauth/start').route.operationId,
      'startOAuth',
    );
    const disconnect = ok('POST', `/v1/connections/${id}/disconnect`);
    assert.equal(disconnect.route.operationId, 'disconnectConnection');
    assert.deepEqual(disconnect.params, { connection_id: id });
    assert.equal(
      ok('GET', '/v1/events/stream').route.operationId,
      'streamEvents',
    );
    assert.equal(ok('GET', '/v1/events').route.operationId, 'getEvents');
    assert.deepEqual(matchRoute('GET', '/v1/connections/oauth/start'), {
      ok: false,
      status: 405,
    });
    assert.deepEqual(matchRoute('GET', '/v1/nothing'), {
      ok: false,
      status: 404,
    });
    assert.deepEqual(matchRoute('GET', '/v1/operations/'), {
      ok: false,
      status: 404,
    });
    assert.deepEqual(matchRoute('GET', '/v1/bootstrap/'), {
      ok: false,
      status: 404,
    });
    // パスの値は復号しない（形式の検査で Id に合わず拒否される）。
    assert.equal(ok('GET', '/v1/operations/%2e%2e').params['id'], '%2e%2e');
  },
);
