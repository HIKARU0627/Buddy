import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalJson,
  contentHash,
  loadContracts,
  parseStrictJson,
  root,
  semanticErrors,
} from './contract-tools.mjs';

const { schema, validators } = await loadContracts();
const defs = schema.$defs;
const read = async (path) =>
  parseStrictJson(await readFile(new URL(path, root), 'utf8'));

// ADR 0003: プロパティ名ごとの版の型。新しい版のフィールドはここへ追加する。
const VERSION_FIELDS = {
  request_revision: 'RequestRevision',
  transcript_revision: 'TranscriptRevision',
  content_version: 'ContentVersion',
  state_revision: 'StateRevision',
  expected_state_revision: 'StateRevision',
  committed_state_revision: 'StateRevision',
  policy_version: 'PolicyVersion',
  permission_revision: 'PermissionRevision',
  forgetting_generation: 'ForgettingGeneration',
  scope_revision: 'ScopeRevision',
  analysis_revision: 'AnalysisRevision',
  published_generation: 'PublishedGeneration',
  io_epoch: 'IoEpoch',
  audio_epoch: 'AudioEpoch',
  output_epoch: 'OutputEpoch',
  control_epoch: 'ControlEpoch',
  session_epoch: 'SessionEpoch',
  source_revision: 'SourceRevision',
  store_generation: 'StoreGeneration',
  sequence: 'Sequence',
  first_frame_seq: 'Sequence',
  last_frame_seq: 'Sequence',
  start_sample: 'Sequence',
  end_sample: 'Sequence',
};
// 型の決定を後続 Issue に残す版。決めたら VERSION_FIELDS へ移す。
const PENDING_VERSION_FIELDS = new Set([
  'price_version', // 単価の版は B00-05（#20）で決める
]);
// 抽出した依頼の版を使う定義。RequestEntity 等を追加した時点で登録する（U04）。
const REQUEST_ENTITY_DEFS = new Set();
const DECIMAL_KINDS = [
  'RequestRevision',
  'RequestEntityRevision',
  'TranscriptRevision',
  'ContentVersion',
  'StateRevision',
  'PolicyVersion',
  'PermissionRevision',
  'ForgettingGeneration',
  'ScopeRevision',
  'AnalysisRevision',
  'PublishedGeneration',
  'IoEpoch',
  'AudioEpoch',
  'OutputEpoch',
  'ControlEpoch',
  'SessionEpoch',
  'Sequence',
];

function propertyObjects(node, owner, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) propertyObjects(item, owner, found);
  } else if (node && typeof node === 'object') {
    if (node.properties) found.push({ owner, properties: node.properties });
    for (const value of Object.values(node))
      propertyObjects(value, owner, found);
  }
  return found;
}

function refsOf(node) {
  const branches = node.anyOf ?? node.oneOf ?? [node];
  return branches
    .filter((branch) => branch.type !== 'null')
    .map((branch) => branch.$ref ?? JSON.stringify(branch));
}

const objects = Object.entries(defs).flatMap(([name, value]) =>
  propertyObjects(value, name),
);

test('version fields use their own revision type and never the shared base', () => {
  for (const { owner, properties } of objects)
    for (const [field, value] of Object.entries(properties)) {
      const refs = refsOf(value);
      assert(
        !refs.includes('#/$defs/NonNegativeDecimal'),
        `${owner}.${field} must use a purpose-specific type`,
      );
      if (/_(?:revision|version|generation|epoch)$/u.test(field))
        assert(
          field in VERSION_FIELDS || PENDING_VERSION_FIELDS.has(field),
          `${owner}.${field} has no assigned version type`,
        );
      if (!(field in VERSION_FIELDS)) continue;
      const expected =
        field === 'request_revision' && REQUEST_ENTITY_DEFS.has(owner)
          ? 'RequestEntityRevision'
          : VERSION_FIELDS[field];
      for (const ref of refs)
        assert.equal(ref, `#/$defs/${expected}`, `${owner}.${field}`);
    }
});

test('the two request revisions never share one object', () => {
  for (const { owner, properties } of objects) {
    const kinds = new Set(Object.values(properties).flatMap(refsOf));
    assert(
      !(
        kinds.has('#/$defs/RequestRevision') &&
        kinds.has('#/$defs/RequestEntityRevision')
      ),
      owner,
    );
  }
});

test('revision types share one decimal representation; store generation stays an opaque ID', () => {
  for (const name of DECIMAL_KINDS) {
    assert.equal(defs[name].pattern, defs.NonNegativeDecimal.pattern, name);
    assert.equal(defs[name].type, 'string', name);
  }
  assert.equal(defs.StoreGeneration.pattern, defs.Id.pattern);
  assert.equal(defs.StoreGeneration.format, defs.Id.format);
  assert(validators.SourceRevision('r1'));
  assert(validators.SourceRevision('"etag-01"'));
  assert(!validators.SourceRevision(''));
  assert(!validators.AudioEpoch('00000000-0000-4000-8000-000000000060'));
});

test('content hashes match independently fixed canonical text and SHA-256', async () => {
  const { cases } = await read(
    'packages/contracts/fixtures/content-hash-cases.json',
  );
  const h01 = await read('packages/contracts/fixtures/h01.json');
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  for (const entry of cases) {
    assert.equal(
      canonicalJson(entry.input_json),
      entry.expected_canonical,
      entry.id,
    );
    assert.equal(
      contentHash(entry.input_json),
      entry.expected_sha256,
      entry.id,
    );
  }
  assert.equal(byId.get('h01').expected_sha256, h01.expected_sha256);
  const hashes = cases.map((entry) => entry.expected_sha256);
  assert.equal(new Set(hashes).size, hashes.length);
  assert.notEqual(
    byId.get('labels-ab').expected_sha256,
    byId.get('labels-ba').expected_sha256,
  );
  assert.notEqual(
    byId.get('label-nfc').expected_sha256,
    byId.get('label-nfd').expected_sha256,
  );
});

test('time zones are checked against the runtime database, not only the pattern', () => {
  assert(validators.TimeZone('Asia/Tokyo'));
  assert.deepEqual(semanticErrors('TimeZone', 'Asia/Tokyo'), []);
  assert(validators.TimeZone('Mars/Olympus_Mons'));
  assert.deepEqual(semanticErrors('TimeZone', 'Mars/Olympus_Mons'), [
    'unknown_time_zone',
  ]);
  assert(!validators.TimeZone('+09:00'));
});

test('explicit null is required and is not the same as an omitted key', async () => {
  const cases = await read('packages/contracts/fixtures/schema-cases.json');
  const input = structuredClone(
    cases.find((entry) => entry.id === 'input-text').value,
  );
  assert.equal(input.transcript_revision, null);
  assert(validators.InputSnapshot(input));
  delete input.transcript_revision;
  assert(!validators.InputSnapshot(input));
  assert.notEqual(contentHash('{"a":null}'), contentHash('{}'));
  assert.notEqual(contentHash('{"a":[]}'), contentHash('{"a":null}'));
});
