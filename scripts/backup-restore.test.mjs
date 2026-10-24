import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  BACKUP_EXCLUDED_TABLES,
  BACKUP_INCLUDED_TABLES,
  BACKUP_REQUIRED_TABLES,
  RESTORE_QUARANTINE_STATES,
  RESTORE_REJECTIONS,
  RESTORE_RESETS,
  RESTORE_SETTINGS_ONLY_TABLES,
  RESTORE_STAGES,
  applyRestoreEvent,
  backupHkdfInputProblems,
  backupKeyCoverageProblems,
  backupManifestProblems,
  backupRetentionPlan,
  backupSetupKeyPlan,
  backupTablePlan,
  buildRestoreAftermath,
  buildRestoreResult,
  decodeBackupBase64,
  decodeRecoveryCode,
  encodeRecoveryCode,
  keyInstallOrderProblems,
  keyInstallPlan,
  keyWrapAad,
  keyWrapHkdfInput,
  ledgerSubkeyHkdfInput,
  quarantineRestoredOperations,
  recoveryCheckHkdfInput,
  restoreBudgetHold,
  restoreBudgetHoldReasons,
  restoreCandidateAutoReasons,
  restoreDbVerifyCheck,
  restoreForgetCheck,
  restoreLedgerCheck,
  restoreMarkGuard,
  restoreOpenCheck,
  restoreRebuildCheck,
  restoreReconcileCheck,
  restoredOperationProblems,
} from '../packages/domain/dist/index.js';
import {
  loadContracts,
  parseStrictJson,
  restoreGuard,
  root,
  semanticErrors,
} from './contract-tools.mjs';

// B06-05 のバックアップと復元の判定。期待値は tests/fixtures/backup-restore-cases.json に手で書いたもので、domain の出力から作らない。
// 契約（Schema と scripts/contract-tools.mjs の意味検査・restoreGuard）と食い違わないことも、ここで照合する。
const cases = parseStrictJson(
  await readFile(
    new URL('tests/fixtures/backup-restore-cases.json', root),
    'utf8',
  ),
);
const storageCases = parseStrictJson(
  await readFile(
    new URL('packages/contracts/fixtures/storage-contract-cases.json', root),
    'utf8',
  ),
);
const { validators } = await loadContracts();

const sorted = (values) => [...values].sort();
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const clone = (value) => structuredClone(value);

function manifestFor(entry) {
  const manifest = {
    ...clone(cases.base_manifest),
    ...clone(entry.override ?? {}),
  };
  if (entry.drop_wraps)
    manifest.key_wraps = manifest.key_wraps.filter(
      (wrap) => !entry.drop_wraps.includes(wrap.purpose),
    );
  const replace = entry.replace_wrap ?? entry.manifest_replace_wrap;
  if (replace)
    manifest.key_wraps = manifest.key_wraps.map((wrap) =>
      wrap.purpose === replace.purpose ? { ...wrap, ...replace.with } : wrap,
    );
  if (entry.add_wrap)
    manifest.key_wraps.push({ ...manifest.key_wraps[0], ...entry.add_wrap });
  return manifest;
}

function assertUnique(list) {
  const ids = list.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate case id');
}

test('fixture ids are unique across sections', () => {
  const all = Object.values(cases)
    .filter(Array.isArray)
    .flat()
    .filter((entry) => entry && typeof entry === 'object' && 'id' in entry);
  assertUnique(all);
  assert(all.length >= 120, `cases: ${all.length}`);
});

// --- バックアップの中身 ---

test('table plan: hand-written classification', () => {
  for (const entry of cases.table_plan_cases) {
    const plan = backupTablePlan(entry.tables);
    assert.equal(plan.ok, entry.expect.ok, entry.id);
    if (plan.ok) {
      assert.deepEqual(
        plan.excluded_tables,
        entry.expect.excluded_tables,
        entry.id,
      );
      assert.equal(
        plan.included_tables.length,
        entry.expect.included_count,
        entry.id,
      );
      assert(
        !plan.excluded_tables.some((t) => BACKUP_REQUIRED_TABLES.includes(t)),
      );
    } else {
      assert.deepEqual(
        sorted(plan.reasons),
        sorted(entry.expect.reasons),
        entry.id,
      );
      assert.deepEqual(
        plan.unknown_tables,
        entry.expect.unknown_tables,
        entry.id,
      );
      assert.deepEqual(
        plan.missing_required_tables,
        entry.expect.missing_required_tables,
        entry.id,
      );
    }
  }
});

test('every table created by the migrations is classified (new tables must be listed)', async () => {
  const dir = new URL('packages/storage/migrations/', root);
  const names = new Set();
  for (const file of (await readdir(dir)).filter((f) =>
    /^\d{4}_.*\.sql$/u.test(f),
  )) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    for (const match of sql.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gu,
    ))
      if (!match[1].endsWith('_')) names.add(match[1]);
  }
  assert(names.size >= 45, `tables: ${names.size}`);
  const unclassified = [...names].filter(
    (name) =>
      !BACKUP_INCLUDED_TABLES.includes(name) &&
      !Object.hasOwn(BACKUP_EXCLUDED_TABLES, name),
  );
  assert.deepEqual(unclassified, []);
  const overlap = BACKUP_INCLUDED_TABLES.filter((name) =>
    Object.hasOwn(BACKUP_EXCLUDED_TABLES, name),
  );
  assert.deepEqual(overlap, []);
  // 一覧に、マイグレーションにない表が残っていない（名前の打ち間違い）。
  const stale = [
    ...BACKUP_INCLUDED_TABLES,
    ...Object.keys(BACKUP_EXCLUDED_TABLES),
  ].filter((name) => !names.has(name));
  assert.deepEqual(stale, []);
  // 生の音声・記録しない会話・OAuth・API キーは表ではない（DB に置かない）。
  for (const name of names)
    assert(!/audio|token|api_key|private/u.test(name), name);
  assert.deepEqual(
    RESTORE_SETTINGS_ONLY_TABLES.filter((t) => !names.has(t)),
    [],
  );
});

test('manifest problems and agreement with the contract (Schema + semantic check)', () => {
  for (const entry of cases.manifest_cases) {
    const manifest = manifestFor(entry);
    assert.deepEqual(
      sorted(backupManifestProblems(manifest)),
      sorted(entry.problems),
      entry.id,
    );
    if (entry.contract) {
      const valid = validators.BackupManifest(manifest);
      assert.equal(valid, entry.contract.schema_valid, `${entry.id}: schema`);
      if (valid)
        assert.deepEqual(
          sorted(semanticErrors('BackupManifest', manifest)),
          sorted(entry.contract.semantic_errors),
          `${entry.id}: contract semantic`,
        );
    }
  }
});

test('key coverage before writing a manifest', () => {
  for (const entry of cases.coverage_cases)
    assert.deepEqual(
      sorted(
        backupKeyCoverageProblems({
          key_wraps: cases.base_manifest.key_wraps,
          db_blob_key_ids: entry.db_blob_key_ids,
          recorded_ledger_key_id: entry.recorded_ledger_key_id,
          forgetting_generation: entry.forgetting_generation,
        }),
      ),
      sorted(entry.problems),
      entry.id,
    );
});

test('old backups: expiry, generations, forgetting replacement, clock regression', () => {
  for (const entry of cases.retention_cases) {
    const plan = backupRetentionPlan(entry.input);
    if (!entry.expect.ok) {
      assert.deepEqual(
        plan,
        { ok: false, reason: entry.expect.reason },
        entry.id,
      );
      continue;
    }
    assert.equal(plan.ok, true, entry.id);
    assert.equal(plan.clock_state, entry.expect.clock_state, entry.id);
    assert.equal(plan.effective_now, entry.expect.effective_now, entry.id);
    assert.deepEqual(
      plan.decisions.map((d) => [d.action, d.reasons]),
      entry.expect.decisions,
      entry.id,
    );
    assert.deepEqual(
      plan.decisions.map((d) => d.backup_id),
      entry.input.backups.map((b) => b.backup_id),
      entry.id,
    );
    assert.equal(
      plan.needs_new_backup,
      entry.expect.needs_new_backup,
      entry.id,
    );
    assert.equal(
      plan.restorable_count,
      entry.expect.restorable_count,
      entry.id,
    );
    assert.equal(
      plan.forgetting_checked,
      entry.expect.forgetting_checked,
      entry.id,
    );
  }
});

test('old backups: the order of the input does not change the plan', () => {
  for (const entry of cases.retention_cases.filter((c) => c.expect.ok)) {
    const reversed = {
      ...entry.input,
      backups: [...entry.input.backups].reverse(),
    };
    const plan = backupRetentionPlan(reversed);
    const byId = new Map(
      plan.decisions.map((d) => [d.backup_id, [d.action, d.reasons]]),
    );
    entry.input.backups.forEach((backup, index) =>
      assert.deepEqual(
        byId.get(backup.backup_id),
        entry.expect.decisions[index],
        entry.id,
      ),
    );
  }
});

// --- 鍵の運用 ---

test('setup keeps existing keys and refuses to regenerate the ledger key', () => {
  for (const entry of cases.setup_key_cases) {
    const plan = backupSetupKeyPlan(entry.input);
    if (entry.expect.ok) assert.deepEqual(plan, entry.expect, entry.id);
    else {
      assert.equal(plan.ok, false, entry.id);
      assert.deepEqual(
        sorted(plan.reasons),
        sorted(entry.expect.reasons),
        entry.id,
      );
    }
  }
});

test('key install plan: add only, never overwrite or delete', () => {
  for (const entry of cases.key_install_cases) {
    const plan = keyInstallPlan({
      key_wraps: manifestFor(entry).key_wraps,
      keystore: entry.keystore,
    });
    if (entry.expect.ok) {
      assert.deepEqual(plan, entry.expect, entry.id);
      assert.deepEqual(keyInstallOrderProblems(plan.steps), [], entry.id);
    } else {
      assert.equal(plan.ok, false, entry.id);
      assert.deepEqual(
        sorted(plan.reasons),
        sorted(entry.expect.reasons),
        entry.id,
      );
    }
  }
});

// 失敗の注入: 計画の各手順の前で止め、差し替えの前なら discard_on_failure だけを消す。稼働中の鍵（元の KeyStore）が
// どこで止まっても残り、差し替えの前の失敗では KeyStore が元と同じになることを確かめる（KeyStore の模型は試験の中で持つ）。
test('a failure at any step before the swap leaves the running keys untouched', () => {
  for (const entry of cases.key_install_cases.filter((c) => c.expect.ok)) {
    const plan = keyInstallPlan({
      key_wraps: manifestFor(entry).key_wraps,
      keystore: entry.keystore,
    });
    const original = sorted(entry.keystore.map((k) => k.key_id));
    for (let stop = 0; stop <= plan.steps.length; stop += 1) {
      const store = new Set(original);
      let swapped = false;
      for (const step of plan.steps.slice(0, stop)) {
        if (step.step === 'stage_key') {
          assert(
            !store.has(step.key_id),
            `${entry.id}: overwrite ${step.key_id}`,
          );
          store.add(step.key_id);
        }
        if (step.step === 'swap_database') swapped = true;
      }
      for (const key of original)
        assert(store.has(key), `${entry.id}: lost ${key} at ${stop}`);
      if (!swapped) {
        for (const key of plan.discard_on_failure) store.delete(key);
        assert.deepEqual(
          sorted(store),
          original,
          `${entry.id}: rollback at ${stop}`,
        );
      }
    }
  }
});

test('key install order check catches swapped steps', () => {
  for (const entry of cases.install_order_cases) {
    const steps = entry.steps.map((name) => ({
      step: name,
      purpose: 'data_key',
      key_id: 'data-key-v1',
      active_key_ids: {},
      key_ids: [],
    }));
    assert.deepEqual(
      sorted(keyInstallOrderProblems(steps)),
      sorted(entry.problems),
      entry.id,
    );
  }
});

test('HKDF arguments: RFC 5869 order and independent known values', () => {
  const known = cases.crypto_known_values;
  const tc = known.rfc5869_case1;
  // hkdfSync(digest, ikm, salt, info, keylen) の引数の順序を、RFC 5869 の試験の値で確かめる。
  assert.equal(
    hex(
      hkdfSync(
        'sha256',
        Buffer.from(tc.ikm_hex, 'hex'),
        Buffer.from(tc.salt_hex, 'hex'),
        Buffer.from(tc.info_hex, 'hex'),
        tc.length,
      ),
    ),
    tc.okm_hex,
  );
  const recoveryKey = Buffer.from(known.recovery_key_hex, 'hex');
  for (const expected of known.wrap_keys) {
    const wrap = cases.base_manifest.key_wraps.find(
      (w) => w.purpose === expected.purpose,
    );
    const input = keyWrapHkdfInput(wrap);
    assert.deepEqual(backupHkdfInputProblems(input), [], expected.purpose);
    assert.equal(hex(input.salt), known.salt_hex, expected.purpose);
    assert.equal(hex(input.info), expected.info_hex, expected.purpose);
    assert.equal(input.length, 32);
    assert.equal(
      hex(
        hkdfSync(input.hash, recoveryKey, input.salt, input.info, input.length),
      ),
      expected.okm_hex,
      expected.purpose,
    );
  }
  const dataWrap = cases.base_manifest.key_wraps.find(
    (w) => w.purpose === 'data_key',
  );
  assert.equal(hex(keyWrapAad(dataWrap)), known.data_key_aad_hex);
  const ledgerKey = Buffer.from(known.ledger_hmac_key_hex, 'hex');
  for (const [use, okm] of Object.entries(known.ledger_subkeys)) {
    const input = ledgerSubkeyHkdfInput(use);
    assert.deepEqual(backupHkdfInputProblems(input), [], use);
    assert.equal(input.salt.length, 0);
    assert.equal(
      hex(
        hkdfSync(input.hash, ledgerKey, input.salt, input.info, input.length),
      ),
      okm,
      use,
    );
  }
  const check = recoveryCheckHkdfInput();
  assert.deepEqual(backupHkdfInputProblems(check), []);
  assert.equal(
    hex(
      hkdfSync(check.hash, recoveryKey, check.salt, check.info, check.length),
    ).toUpperCase(),
    known.recovery_check_value,
  );
  // 確認値は RecoveryKeyRecord.check_value の形（大文字の 16 進 8 桁）。
  assert.match(known.recovery_check_value, /^[0-9A-F]{8}$/u);
  assert.throws(() => ledgerSubkeyHkdfInput('constructor'));
});

test('HKDF input check rejects malformed parameters', () => {
  const good = recoveryCheckHkdfInput();
  assert.deepEqual(backupHkdfInputProblems({ ...good, hash: 'md5' }), [
    'hash_not_sha256',
  ]);
  assert.deepEqual(
    backupHkdfInputProblems({ ...good, salt: new Uint8Array(8) }),
    ['salt_length_invalid'],
  );
  assert.deepEqual(
    backupHkdfInputProblems({
      ...good,
      info: Uint8Array.from(Buffer.from('other/x')),
    }),
    ['info_not_buddy_label'],
  );
  assert.deepEqual(
    sorted(backupHkdfInputProblems({ ...good, info: new Uint8Array(0) })),
    ['info_empty', 'info_not_buddy_label'],
  );
  assert.deepEqual(backupHkdfInputProblems({ ...good, length: 33 }), [
    'length_invalid',
  ]);
  assert.deepEqual(backupHkdfInputProblems({ ...good, length: 0 }), [
    'length_invalid',
  ]);
  assert.throws(() =>
    keyWrapHkdfInput({
      ...cases.base_manifest.key_wraps[0],
      kdf: { algorithm: 'hkdf-sha256', salt: 'AAECAwQFBgc=' },
    }),
  );
});

// 取り違え: 用途・鍵の ID・復旧キーを info と AAD に入れたので、包みを別の欄に入れ替えると AES-GCM の認証で開けない。
test('a wrap moved to another purpose fails authentication', () => {
  const known = cases.crypto_known_values;
  const recoveryKey = Buffer.from(known.recovery_key_hex, 'hex');
  const material = randomBytes(32);
  const nonce = randomBytes(12);
  const wrap = (w) => {
    const input = keyWrapHkdfInput(w);
    return Buffer.from(
      hkdfSync(input.hash, recoveryKey, input.salt, input.info, input.length),
    );
  };
  const dataWrap = cases.base_manifest.key_wraps.find(
    (w) => w.purpose === 'data_key',
  );
  const cipher = createCipheriv('aes-256-gcm', wrap(dataWrap), nonce);
  cipher.setAAD(keyWrapAad(dataWrap));
  const sealed = Buffer.concat([cipher.update(material), cipher.final()]);
  const tag = cipher.getAuthTag();
  const open = (w) => {
    const decipher = createDecipheriv('aes-256-gcm', wrap(w), nonce);
    decipher.setAAD(keyWrapAad(w));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]);
  };
  assert.deepEqual(open(dataWrap), material);
  assert.throws(() => open({ ...dataWrap, purpose: 'ledger_hmac_key' }));
  assert.throws(() => open({ ...dataWrap, key_id: 'data-key-v2' }));
  assert.throws(() =>
    open({
      ...dataWrap,
      recovery_key_id: '00000000-0000-4000-8000-000000009002',
    }),
  );
});

test('recovery code: Crockford base32 known values and lenient reading', () => {
  for (const entry of cases.recovery_code_cases) {
    const bytes = Uint8Array.from(Buffer.from(entry.bytes_hex, 'hex'));
    assert.equal(encodeRecoveryCode(bytes), entry.code, entry.id);
    assert.equal(
      hex(decodeRecoveryCode(entry.code)),
      entry.bytes_hex,
      entry.id,
    );
    // RecoveryKeyDisplay の形（大文字・4 文字 × 13 組）。
    assert.match(
      entry.code,
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/u,
    );
  }
  for (const entry of cases.recovery_code_inputs) {
    const decoded = decodeRecoveryCode(entry.text);
    if (entry.bytes_hex === null) assert.equal(decoded, null, entry.id);
    else assert.equal(hex(decoded), entry.bytes_hex, entry.id);
  }
  assert.throws(() => encodeRecoveryCode(new Uint8Array(31)));
});

test('base64 of the salt is read strictly', () => {
  assert.equal(
    hex(decodeBackupBase64('AAECAwQFBgcICQoLDA0ODw==')),
    cases.crypto_known_values.salt_hex,
  );
  assert.equal(decodeBackupBase64('AAECAwQFBgcICQoLDA0ODx=='), null);
  assert.equal(decodeBackupBase64('AAECAwQFBgcICQoLDA0ODw='), null);
  assert.equal(decodeBackupBase64('AAEC*wQF'), null);
});

// --- 復元の 6 段階 ---

test('stage and reason vocabulary matches the contract', async () => {
  const schema = parseStrictJson(
    await readFile(
      new URL('packages/contracts/schemas/buddy.schema.json', root),
      'utf8',
    ),
  );
  assert.deepEqual(
    RESTORE_REJECTIONS,
    schema.$defs.RestoreRejectionReason.enum,
  );
  assert.deepEqual(
    RESTORE_STAGES,
    schema.$defs.RestoreStageResult.properties.stage.enum,
  );
  assert.deepEqual(RESTORE_RESETS, cases.restore_resets);
});

test('stage 1 ledger check: missing, old, partial, rolled back, lineage, key mismatch', () => {
  for (const entry of cases.ledger_check_cases) {
    const result = restoreLedgerCheck({
      manifest: manifestFor(entry),
      ledgers: entry.ledgers,
      latest_known_generation: entry.latest_known_generation,
      hub_ledger_key: entry.hub_ledger_key,
    });
    assert.deepEqual(
      {
        status: result.decision.status,
        reasons: result.decision.reasons,
        ledger: result.ledger,
        settings_only_eligible: result.settings_only_eligible,
      },
      entry.expect,
      entry.id,
    );
    assert.equal(result.decision.stage, 'ledger_check');
  }
});

test('stage 2 open check: unreadable keys and clock regression', () => {
  for (const entry of cases.open_check_cases) {
    const result = restoreOpenCheck({
      ...cases.open_check_base,
      ...entry.override,
    });
    assert.deepEqual(
      {
        status: result.decision.status,
        reasons: result.decision.reasons,
        effective_now: result.effective_now,
      },
      entry.expect,
      entry.id,
    );
  }
});

test('stages 3 to 6', () => {
  const run = {
    forget: restoreForgetCheck,
    db: restoreDbVerifyCheck,
    rebuild: restoreRebuildCheck,
    reconcile: restoreReconcileCheck,
  };
  for (const entry of cases.stage_cases)
    assert.deepEqual(run[entry.kind](entry.input), entry.expect, entry.id);
});

test('restore result: outcome, settings-only and agreement with the contract', () => {
  for (const entry of cases.result_cases) {
    const override = { ...(entry.override ?? {}) };
    if (typeof override.after_restore === 'string')
      override.after_restore = cases[override.after_restore];
    const input = {
      ...clone(cases.result_base),
      ...override,
      decisions: entry.decisions.map(([stage, status, reasons]) => ({
        stage,
        status,
        reasons,
      })),
    };
    const built = buildRestoreResult(input);
    if (!entry.expect.ok) {
      assert.equal(built.ok, false, entry.id);
      assert.deepEqual(
        sorted(built.reasons),
        sorted(entry.expect.reasons),
        entry.id,
      );
      continue;
    }
    assert.equal(built.ok, true, entry.id);
    const result = built.result;
    assert.equal(result.outcome, entry.expect.outcome, entry.id);
    assert.equal(result.failed_stage, entry.expect.failed_stage, entry.id);
    assert.deepEqual(
      result.stages.map((s) => s.status),
      entry.expect.statuses,
      entry.id,
    );
    assert.deepEqual(
      result.stages.map((s) => s.stage),
      RESTORE_STAGES,
      entry.id,
    );
    // 組み立てた結果は、契約の Schema と意味検査に通る。
    assert.equal(
      validators.RestoreResult(result),
      true,
      `${entry.id}: ${JSON.stringify(validators.RestoreResult.errors)}`,
    );
    assert.deepEqual(semanticErrors('RestoreResult', result), [], entry.id);
  }
});

// 段階の判定を、決まった順につないだ一連の復元（台帳が古い・時計が戻った・鍵の取り違え）。
test('end to end: stop at the first failing stage and never restore memories without the latest ledger', () => {
  const ledgerCase = (id) => cases.ledger_check_cases.find((c) => c.id === id);
  const flow = (ledgerId, openOverride) => {
    const entry = ledgerCase(ledgerId);
    const ledger = restoreLedgerCheck({
      manifest: manifestFor(entry),
      ledgers: entry.ledgers,
      latest_known_generation: entry.latest_known_generation,
      hub_ledger_key: entry.hub_ledger_key,
    });
    const decisions = [ledger.decision];
    if (ledger.decision.status === 'passed') {
      const open = restoreOpenCheck({
        ...cases.open_check_base,
        ...openOverride,
      });
      decisions.push(open.decision);
    }
    return buildRestoreResult({
      ...clone(cases.result_base),
      decisions,
      settings_only: {
        eligible: ledger.settings_only_eligible,
        settings_readable: true,
      },
    });
  };
  const oldOnly = flow('x16-b0605-ledger-only-old-copy', {});
  assert.equal(oldOnly.result.outcome, 'settings_only');
  assert.equal(oldOnly.result.after_restore, null);
  const keySwap = flow(
    'x16-b0605-ledger-key-swapped-against-existing-ledger',
    {},
  );
  assert.equal(keySwap.result.outcome, 'rejected');
  const clock = flow('x16-b0605-ledger-hub-current', {
    now: '2026-10-24T02:00:00Z',
    started_at: '2026-10-24T01:59:00Z',
  });
  assert.equal(clock.result.outcome, 'rejected');
  assert.equal(clock.result.failed_stage, 'expiry_purge');
  assert.deepEqual(clock.result.stages[1].reasons, ['clock_regression']);
});

// --- 復元の後の保留 ---

const toOp = ([
  operation_id,
  effect_route,
  state,
  content_version,
  valid_approval_count,
]) => ({
  operation_id,
  effect_route,
  state,
  content_version,
  valid_approval_count,
});

test('quarantine: all approvals revoked, seven states marked, in-flight held', () => {
  const entry = cases.quarantine_case;
  const plan = quarantineRestoredOperations(
    entry.input.map(toOp),
    entry.restored_at,
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.operations.map((op) => [op.state, op.restore_unverified_at !== null]),
    entry.expect,
  );
  for (const op of plan.operations) {
    assert.equal(op.valid_approval_count, 0, op.operation_id);
    if (op.restore_unverified_at !== null)
      assert.equal(op.restore_unverified_at, entry.restored_at);
    // 契約の Schema と意味検査（印・承認の失効）に通る。domain の検査も同じ結果。
    assert.equal(validators.RestoredOperation(op), true, op.operation_id);
    assert.deepEqual(
      semanticErrors('RestoredOperation', op),
      [],
      op.operation_id,
    );
    assert.deepEqual(restoredOperationProblems(op), [], op.operation_id);
  }
  const {
    approvals_revoked_count,
    operations_held_count,
    operations_unverified_count,
  } = plan;
  assert.deepEqual(
    {
      approvals_revoked_count,
      operations_held_count,
      operations_unverified_count,
    },
    entry.expect_counts,
  );
  assert.deepEqual(
    sorted(RESTORE_QUARANTINE_STATES),
    sorted([
      'awaiting_approval',
      'approved',
      'preparing',
      'dispatching',
      'reconciling',
      'unknown_held',
      'not_executed',
    ]),
  );
});

test('quarantine rejects unreadable operations instead of guessing', () => {
  for (const entry of cases.quarantine_rejections) {
    const plan = quarantineRestoredOperations(
      entry.input.map(toOp),
      entry.restored_at,
    );
    assert.equal(plan.ok, false, entry.id);
    assert.deepEqual(
      { reasons: plan.reasons, operation_ids: plan.operation_ids },
      entry.expect,
      entry.id,
    );
  }
});

// B06-01 の P3: 承認の失効は、印の有無・経路によらず検査する。契約の fixture（手書き）の RestoredOperation の全件で、
// domain の検査と契約の意味検査が同じ理由を返すこと。
test('restored operation check agrees with the contract on every contract fixture', () => {
  const rows = storageCases.cases.filter(
    (c) => c.schema === 'RestoredOperation' && c.valid,
  );
  assert(rows.length >= 19);
  for (const row of rows) {
    assert.deepEqual(
      sorted(restoredOperationProblems(row.value)),
      sorted(row.semantic_errors),
      row.id,
    );
    assert.deepEqual(
      sorted(semanticErrors('RestoredOperation', row.value)),
      sorted(row.semantic_errors),
      row.id,
    );
  }
  const unmarkedLocal = {
    schema: 'buddy.restored-operation.v1',
    operation_id: '00000000-0000-4000-8000-000000007101',
    effect_route: 'local_command',
    state: 'succeeded',
    content_version: '1',
    restore_unverified_at: null,
    valid_approval_count: 2,
  };
  assert.deepEqual(restoredOperationProblems(unmarkedLocal), [
    'approval_not_revoked',
  ]);
});

test('mark guard gives the same answers as the contract restoreGuard', () => {
  // 契約の手書きのシナリオの期待値。
  for (const scenario of storageCases.scenarios)
    for (const step of scenario.steps) {
      const { expect, ...event } = step;
      assert.deepEqual(
        restoreMarkGuard(scenario.initial, event),
        expect,
        `${scenario.id} ${step.event}`,
      );
    }
  // 全ての出来事 × 印の有無 × 観測の組で、契約の参照実装と一致する。
  const observations = [
    { kind: 'found', marker_content_version: '1', content_matches: true },
    { kind: 'found', marker_content_version: '2', content_matches: true },
    { kind: 'found', marker_content_version: '1', content_matches: false },
    { kind: 'found', marker_content_version: '1', content_matches: null },
    { kind: 'not_found', marker_content_version: null, content_matches: null },
    { kind: 'multiple', marker_content_version: null, content_matches: null },
    { kind: 'unreadable', marker_content_version: null, content_matches: null },
    {
      kind: 'unsupported',
      marker_content_version: null,
      content_matches: null,
    },
  ];
  const events = [
    { event: 'create_approval' },
    { event: 'enter_approved' },
    { event: 'enter_preparing' },
    { event: 'create_attempt' },
    { event: 'revise_content' },
    { event: 'owner_resolve' },
    ...observations.map((observation) => ({ event: 'reconcile', observation })),
  ];
  for (const mark of [null, '2026-10-24T03:10:00Z'])
    for (const event of events) {
      const op = { content_version: '1', restore_unverified_at: mark };
      assert.deepEqual(
        restoreMarkGuard(op, event),
        restoreGuard(op, event),
        `${mark} ${JSON.stringify(event)}`,
      );
    }
});

test('release ordering: only positive evidence or the owner removes the mark', () => {
  for (const sequence of cases.event_sequences) {
    const [route, state, version, marked, approvals] = sequence.initial;
    let op = {
      schema: 'buddy.restored-operation.v1',
      operation_id: '00000000-0000-4000-8000-000000007501',
      effect_route: route,
      state,
      content_version: version,
      restore_unverified_at: marked ? '2026-10-24T03:10:00Z' : null,
      valid_approval_count: approvals,
    };
    sequence.steps.forEach(([event, result, reason, next], index) => {
      const outcome = applyRestoreEvent(op, event);
      const label = `${sequence.id}[${index}] ${event.event}`;
      assert.deepEqual(outcome.decision, { result, reason }, label);
      op = outcome.operation;
      assert.deepEqual(
        [
          op.state,
          op.content_version,
          op.restore_unverified_at !== null,
          op.valid_approval_count,
        ],
        next,
        label,
      );
    });
  }
});

test('budget hold after restore', () => {
  for (const entry of cases.budget_hold_cases) {
    const hold = restoreBudgetHold(entry.input);
    assert.deepEqual(hold, entry.expect, entry.id);
  }
  for (const entry of cases.budget_gate_cases)
    assert.deepEqual(
      restoreBudgetHoldReasons(entry.input),
      entry.expect,
      entry.id,
    );
});

test('candidate-origin automation waits for re-ingestion', () => {
  for (const entry of cases.candidate_auto_cases)
    assert.deepEqual(
      restoreCandidateAutoReasons(entry.input),
      entry.expect,
      entry.id,
    );
});

test('aftermath: new store generation and counts from the quarantine', () => {
  const quarantine = quarantineRestoredOperations(
    cases.quarantine_case.input.map(toOp),
    cases.quarantine_case.restored_at,
  );
  for (const entry of cases.aftermath_cases) {
    const built = buildRestoreAftermath({ ...entry.input, quarantine });
    if (typeof entry.expect === 'string') {
      assert.equal(built.ok, true, entry.id);
      assert.deepEqual(built.after_restore, cases[entry.expect], entry.id);
      assert.equal(
        validators.RestoreAftermath(built.after_restore),
        true,
        entry.id,
      );
    } else {
      assert.equal(built.ok, false, entry.id);
      assert.deepEqual(built.reasons, entry.expect.reasons, entry.id);
    }
  }
  const failed = buildRestoreAftermath({
    ...cases.aftermath_cases[0].input,
    quarantine: {
      ok: false,
      reasons: ['unknown_operation_state'],
      operation_ids: [],
    },
  });
  assert.deepEqual(failed, { ok: false, reasons: ['quarantine_failed'] });
});
