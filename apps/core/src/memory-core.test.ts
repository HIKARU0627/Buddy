// 製品の Core（startCore、HTTPS は 127.0.0.1・鍵は模擬）での記憶の一覧の経路と、忘却の画面から見た拒否（UI-10、ADR 0183）。
// - 一覧は本人の画面操作（Buddy-Input-Origin が screen）・ロック解除済み・自宅の中の登録済み端末だけに返す。
// - 忘却の公開ゲート（U112）は閉じたままで、一覧は forget_gate: closed を返し、計画は 503（画面はこれを「まだ使えません」に写す）。
// - 別の端末が作った計画を実行できないこと・計画の後に世代が変わったら 409 で作り直させることは、ゲートを開いた組み立てで
//   forget-service.test.ts が確かめる（製品の Core ではゲートが閉じていて計画を作れない）。
// 記憶は DB に直接書く（記憶を保存する経路はまだない）。本文はこの試験のデータ鍵で封じる。期待値は手で書いた。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sealBlob } from '@buddy/storage';
import type { MemoryOp } from '@buddy/storage';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import {
  DATA_KEY_MATERIAL,
  bootstrap,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore } from './event-test-support.js';

const contract = sharedApiContract();
const MEMORY = 'c1000000-0000-4000-8000-0000000000c1';
const SESSION = 'c1000000-0000-4000-8000-0000000000c2';
const TURN = 'c1000000-0000-4000-8000-0000000000c3';
const SCREEN = { 'buddy-input-origin': 'screen' };

function list(
  core: EventCore,
  token: string,
  headers: Record<string, string>,
): ReturnType<typeof pinnedRequest> {
  return pinnedRequest(core.target, {
    method: 'GET',
    path: '/v1/memory/records',
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

function sealedInput(
  memoryId: string,
  purpose: 'memory_text' | 'memory_target_key',
  text: string,
) {
  const sealed = sealBlob(DATA_KEY_MATERIAL, new TextEncoder().encode(text), {
    ownerTable: 'memories',
    ownerId: memoryId,
    ownerVersion: 0,
    purpose,
  });
  assert(sealed.ok);
  return {
    blob_id: randomUUID(),
    format_version: sealed.envelope.formatVersion,
    key_id: sealed.envelope.keyId,
    nonce: sealed.envelope.nonce,
    ciphertext: sealed.envelope.ciphertext,
    tag: sealed.envelope.tag,
  };
}

test(
  'the product Core lists memories only to an unlocked screen at home and keeps forgetting closed',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);

    // 空の一覧（ゲートは閉じている）。
    const empty = await list(core, device.token, SCREEN);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json, {
      schema: 'buddy.memory-list.v1',
      forget_gate: 'closed',
      items: [],
      truncated: false,
    });

    // 由来の発言を作り、記憶を 1 件保存する（保存層の命令。記憶を保存する経路はまだない）。
    const now = Date.now();
    const ref = () => ({
      command_scope_id: scope,
      request_id: randomUUID(),
      request_hash: 'ab'.repeat(32),
      command_id: randomUUID(),
    });
    const session = await core.handle.store.conversation({
      kind: 'session.create',
      session_id: SESSION,
      storage_mode: 'normal',
      display_device_id: device.device.device_id,
      created_at: now,
      request: ref(),
    });
    assert(session.ok, JSON.stringify(session));
    const turn = await core.handle.store.conversation({
      kind: 'turn.record',
      session_id: SESSION,
      turn_id: TURN,
      input_id: randomUUID(),
      text: sealedInput(TURN, 'memory_text', '合成の発言'),
      created_at: now,
      expires_at: now + 7 * 86_400_000,
      workflow: null,
      permission_revision: '1',
      request: ref(),
      operation: null,
      response_json: '{}',
    });
    assert(turn.ok, JSON.stringify(turn));
    // 保存してよい種類（ADR 0191）: 好みを許可する（版 0 → 1）。
    const allowed = await core.handle.store.memory({
      kind: 'memory.settings_set',
      expected_revision: '0',
      allowed_kinds: ['preference'],
      now,
    });
    assert(allowed.ok, JSON.stringify(allowed));
    const save: MemoryOp = {
      kind: 'memory.save',
      memory_id: MEMORY,
      origin: 'explicit_request',
      memory_kind: 'preference',
      text: sealedInput(MEMORY, 'memory_text', '返信は短めが好み'),
      target_key: sealedInput(MEMORY, 'memory_target_key', '返信の長さ'),
      target_key_hash: 'cd'.repeat(32),
      dedupe_key: 'ef'.repeat(32),
      sources: [{ source_kind: 'turn', source_id: TURN }],
      source_hmacs: [
        { source_kind: 'turn', source_id: TURN, hmac: 'a1'.repeat(32) },
      ],
      forgetting_generation: '0',
      settings_revision: '1',
      now,
    };
    const saved = await core.handle.store.memory(save);
    assert(saved.ok, JSON.stringify(saved));
    const listed = await list(core, device.token, SCREEN);
    assert.equal(listed.status, 200, listed.text);
    assert(contract.valid('MemoryListResponse', listed.json));
    const items = listed.json?.['items'] as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.deepEqual(
      {
        memory_id: items[0]?.['memory_id'],
        kind: items[0]?.['kind'],
        text: items[0]?.['text'],
        status: items[0]?.['status'],
        source_counts: items[0]?.['source_counts'],
      },
      {
        memory_id: MEMORY,
        kind: 'preference',
        text: '返信は短めが好み',
        status: 'active',
        source_counts: { turn: 1, source_item: 0, memory: 0 },
      },
    );
    // 由来の ID・対象キー・内容の HMAC は出さない。
    assert(!listed.text.includes(TURN));
    assert(!listed.text.includes('返信の長さ'));
    assert(!listed.text.includes('ef'.repeat(32)));

    // 起源が画面でない（音声・中枢の自動の処理・チャット）・起源がないは拒否する。
    for (const origin of ['voice', 'system', 'chat']) {
      const refused = await list(core, device.token, {
        'buddy-input-origin': origin,
      });
      assert.equal(refused.status, 403, origin);
      assert.equal(refused.json?.['code'], 'screen_operation_required');
    }
    const missing = await list(core, device.token, {});
    assert.equal(missing.status, 422);
    // トークンなし。
    const anonymous = await pinnedRequest(core.target, {
      method: 'GET',
      path: '/v1/memory/records',
      headers: SCREEN,
    });
    assert.equal(anonymous.status, 401);
    // ロック中・ロック状態不明は本文を出さない。
    for (const lock of ['locked', 'unknown'] as const) {
      core.env.lock = lock;
      const locked = await list(core, device.token, SCREEN);
      assert.equal(locked.status, 403, lock);
      assert.equal(locked.json?.['code'], 'device_locked');
    }
    core.env.lock = 'unlocked';
    // 自宅の外は拒否する。
    core.env.home = false;
    const outside = await list(core, device.token, SCREEN);
    assert.equal(outside.status, 403);
    assert.equal(outside.json?.['code'], 'outside_home_network');
    core.env.home = true;

    // 計画はゲートが閉じているので 503（画面は「まだ使えません」に写す）。
    const planned = await postJson(
      core,
      device,
      '/v1/memory/forget-plans',
      { request_id: randomUUID(), command_scope_id: scope, memory_id: MEMORY },
      SCREEN,
    );
    assert.equal(planned.status, 503, planned.text);
  },
);

test(
  'ADR 0191: the product Core keeps the allowed memory kinds empty by default and changes them only by an unlocked screen operation with the current revision',
  { timeout: 30_000 },
  async (t) => {
    const core = await startEventCore(t);
    const device = await insertDevice(core.handle.store);
    const scope = await bootstrap(core, device);
    const read = (headers: Record<string, string>) =>
      pinnedRequest(core.target, {
        method: 'GET',
        path: '/v1/memory/settings',
        headers: { authorization: `Bearer ${device.token}`, ...headers },
      });
    const change = (
      expected: string,
      kinds: readonly string[],
      headers: Record<string, string> = SCREEN,
    ) =>
      postJson(
        core,
        device,
        '/v1/memory/settings',
        {
          request_id: randomUUID(),
          command_scope_id: scope,
          expected_memory_settings_revision: expected,
          allowed_kinds: kinds,
        },
        headers,
      );

    // 既定は空（何も保存しない）・版 0。
    const initial = await read(SCREEN);
    assert.equal(initial.status, 200, initial.text);
    assert.deepEqual(initial.json, {
      schema: 'buddy.memory-settings.v1',
      allowed_kinds: [],
      memory_settings_revision: '0',
    });
    // 音声・チャット・中枢の自動の処理の起源からは変えられない（読むこともできない）。
    for (const origin of ['voice', 'chat', 'system']) {
      const refused = await change('0', ['preference'], {
        'buddy-input-origin': origin,
      });
      assert.equal(refused.status, 403, origin);
      assert.equal(refused.json?.['code'], 'screen_operation_required');
      const unread = await read({ 'buddy-input-origin': origin });
      assert.equal(unread.status, 403, origin);
    }
    // ロック中は変えられない。
    core.env.lock = 'locked';
    assert.equal((await change('0', ['preference'])).status, 403);
    core.env.lock = 'unlocked';
    // 知らない種類・重なりは 422。
    assert.equal((await change('0', ['health'])).status, 422);
    assert.equal((await change('0', ['goal', 'goal'])).status, 422);
    assert.deepEqual(
      (await read(SCREEN)).json?.['memory_settings_revision'],
      '0',
    );

    // 本人の画面操作で変える。並びは種類の決まった順。
    const changed = await change('0', ['goal', 'preference']);
    assert.equal(changed.status, 200, changed.text);
    assert(contract.valid('MemorySettings', changed.json));
    assert.deepEqual(changed.json, {
      schema: 'buddy.memory-settings.v1',
      allowed_kinds: ['preference', 'goal'],
      memory_settings_revision: '1',
    });
    // 古い版からの変更（別の画面・再送）は 409 で、設定は変わらない。
    const stale = await change('0', []);
    assert.equal(stale.status, 409, stale.text);
    assert.deepEqual((await read(SCREEN)).json, changed.json);
  },
);
