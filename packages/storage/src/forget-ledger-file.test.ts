// 忘却台帳の別ファイルと DB の整合（ADR 0054）: 忘却の途中・COMMIT の後・ファイルの置き換えの前のどこで止まっても、
// 再開（もう一度の同期）でファイルと DB がそろうこと。ファイルが進んでいる・食い違う・系譜が違う・壊れているときは
// 書き換えずに拒否すること。期待値（hash）は手で書いた値（forget-test-support.ts の説明）。

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parseLedgerFile, syncForgetLedgerFile } from './index.js';
import type { ForgetLedgerExport, SqliteDatabase } from './index.js';
import {
  ENTRY_1,
  ENTRY_2,
  HASH_1,
  HASH_2,
  HMACS,
  LEDGER_ID,
  M_OTHER,
  NOW_2,
  forgetM,
  forgetOther,
  memoryOp,
  planFor,
  seedWorld,
  value,
} from './forget-test-support.js';
import {
  databasePath,
  openSeededDatabase,
  withTempDir,
} from './operation-test-support.js';

const WRITTEN = new Date('2031-02-01T00:00:00.000Z');

function exportLedger(db: SqliteDatabase): ForgetLedgerExport {
  return value<ForgetLedgerExport>(
    memoryOp(db, { kind: 'forget.ledger_export' }),
  );
}

async function withDbAndFile(
  run: (db: SqliteDatabase, file: string, dir: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const db = openSeededDatabase(databasePath(dir));
    const ledgerDir = join(dir, 'ledger');
    mkdirSync(ledgerDir);
    try {
      seedWorld(db);
      await run(db, join(ledgerDir, 'forget-ledger.json'), ledgerDir);
    } finally {
      db.close();
    }
  });
}

function readFile(path: string): {
  ledger_id: string;
  head: { forgetting_generation: string; entry_hash: string };
  entries: {
    entry: { entry_id: string };
    previous_hash: string;
    entry_hash: string;
  }[];
} {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('ledger file: no ledger and no file writes nothing; a committed forget is written, then stays in sync', async () => {
  await withDbAndFile(async (db, file, dir) => {
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      {
        ok: true,
        action: 'none',
        forgetting_generation: '0',
      },
    );
    assert.deepEqual(readdirSync(dir), []);
    value(forgetM(db));
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      {
        ok: true,
        action: 'written',
        forgetting_generation: '1',
      },
    );
    const written = readFile(file);
    assert.equal(written.ledger_id, LEDGER_ID);
    assert.deepEqual(written.head, {
      forgetting_generation: '1',
      entry_hash: HASH_1,
    });
    assert.equal(written.entries[0]?.entry.entry_id, ENTRY_1);
    assert.equal(written.entries[0]?.previous_hash, '0'.repeat(64));
    assert.notEqual(parseLedgerFile(readFileSync(file, 'utf8')), null);
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      {
        ok: true,
        action: 'in_sync',
        forgetting_generation: '1',
      },
    );
  });
});

test('ledger file: a stop before COMMIT changes neither; a stop after COMMIT and before the file write is resumed', async () => {
  await withDbAndFile(async (db, file) => {
    value(forgetM(db));
    await syncForgetLedgerFile(file, exportLedger(db), WRITTEN);
    const before = readFileSync(file, 'utf8');
    // 2 回目の忘却が COMMIT の前で止まった: DB もファイルも 1 世代のまま、そろっている。
    const stopped = forgetOther(db, () => {
      throw new Error('注入した失敗（COMMIT の前）');
    });
    assert.equal(stopped.ok, false);
    assert.equal(exportLedger(db).head.forgetting_generation, '1');
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      {
        ok: true,
        action: 'in_sync',
        forgetting_generation: '1',
      },
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    // 2 回目の忘却を COMMIT し、ファイルを書く前に止まった（同期を呼ばない）: DB が 1 世代進んでいる。
    value(forgetOther(db));
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(readFile(file).head.forgetting_generation, '1');
    // 再開（起動時の同期）で DB に合わせて書く。連鎖は 1 世代目から続く。
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      {
        ok: true,
        action: 'written',
        forgetting_generation: '2',
      },
    );
    const after = readFile(file);
    assert.deepEqual(
      after.entries.map((item) => [item.previous_hash, item.entry_hash]),
      [
        ['0'.repeat(64), HASH_1],
        [HASH_1, HASH_2],
      ],
    );
  });
});

test('ledger file: a stop before the rename keeps the old file; the next sync removes the temp file and writes', async () => {
  await withDbAndFile(async (db, file, dir) => {
    value(forgetM(db));
    await syncForgetLedgerFile(file, exportLedger(db), WRITTEN);
    const before = readFileSync(file, 'utf8');
    value(forgetOther(db));
    await assert.rejects(
      syncForgetLedgerFile(file, exportLedger(db), WRITTEN, {
        beforeRename: () => {
          throw new Error('注入した停止（rename の前）');
        },
      }),
      /rename の前/u,
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')).length,
      1,
    );
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      {
        ok: true,
        action: 'written',
        forgetting_generation: '2',
      },
    );
    assert.deepEqual(readdirSync(dir), ['forget-ledger.json']);
    assert.deepEqual(readFile(file).head, {
      forgetting_generation: '2',
      entry_hash: HASH_2,
    });
  });
});

test('ledger file: a file ahead of the DB, a diverged hash, another lineage and a broken file are refused and left as they are', async () => {
  await withDbAndFile(async (db, file) => {
    value(forgetM(db));
    value(forgetOther(db));
    const full = exportLedger(db);
    await syncForgetLedgerFile(file, full, WRITTEN);
    const written = readFileSync(file, 'utf8');
    // DB が 1 世代目へ戻された（古い DB を置いた）: ファイルが進んでいる。
    const behind: ForgetLedgerExport = {
      ledger_id: full.ledger_id,
      entries: full.entries.slice(0, 1),
      head: { forgetting_generation: '1', entry_hash: HASH_1 },
    };
    assert.deepEqual(await syncForgetLedgerFile(file, behind, WRITTEN), {
      ok: false,
      reason: 'ledger_file_ahead',
    });
    // DB に台帳がないのにファイルに項目がある。
    assert.deepEqual(
      await syncForgetLedgerFile(
        file,
        {
          ledger_id: null,
          entries: [],
          head: { forgetting_generation: '0', entry_hash: '0'.repeat(64) },
        },
        WRITTEN,
      ),
      { ok: false, reason: 'ledger_file_ahead' },
    );
    // 同じ世代の hash が違う。
    const diverged: ForgetLedgerExport = {
      ...full,
      entries: full.entries.map((item, index) =>
        index === 0 ? { ...item, entry_hash: 'f'.repeat(64) } : item,
      ),
    };
    assert.deepEqual(await syncForgetLedgerFile(file, diverged, WRITTEN), {
      ok: false,
      reason: 'ledger_file_diverged',
    });
    // 別の系譜。
    assert.deepEqual(
      await syncForgetLedgerFile(
        file,
        { ...full, ledger_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        WRITTEN,
      ),
      { ok: false, reason: 'ledger_lineage_mismatch' },
    );
    assert.equal(readFileSync(file, 'utf8'), written);
    // 壊れたファイル・本文の欄が混ざったファイル・連鎖の書き換えは読まない。
    const parsed = JSON.parse(written);
    const variants = [
      '{"schema":',
      JSON.stringify({ ...parsed, note: 'x' }),
      JSON.stringify({
        ...parsed,
        entries: parsed.entries.map((item: { entry: object }, index: number) =>
          index === 0
            ? { ...item, entry: { ...item.entry, body: '合成の本文' } }
            : item,
        ),
      }),
      JSON.stringify({
        ...parsed,
        entries: parsed.entries.map(
          (
            item: { entry: { blocked_content_keys: string[] } },
            index: number,
          ) =>
            index === 1
              ? {
                  ...item,
                  entry: {
                    ...item.entry,
                    blocked_content_keys: ['e'.repeat(64)],
                  },
                }
              : item,
        ),
      }),
      JSON.stringify({ ...parsed, entries: parsed.entries.slice(1) }),
    ];
    for (const text of variants) {
      assert.equal(parseLedgerFile(text), null, text.slice(0, 40));
      writeFileSync(file, text);
      assert.deepEqual(await syncForgetLedgerFile(file, full, WRITTEN), {
        ok: false,
        reason: 'ledger_file_invalid',
      });
      assert.equal(readFileSync(file, 'utf8'), text);
    }
  });
});

// 世代 1 のファイルをそろえ、世代 2 の忘却を COMMIT した後・rename の前に止まった状態を作る（一時ファイルが世代 2）。
// 世代 1 の書き出し（DB が世代 1 へ戻された状態の代わり）・世代 1 のファイルの中身・一時ファイルを返す。
async function stoppedBeforeRename(
  db: SqliteDatabase,
  file: string,
  dir: string,
): Promise<{
  gen1: ForgetLedgerExport;
  gen1Text: string;
  temp: string;
  text: string;
}> {
  value(forgetM(db));
  await syncForgetLedgerFile(file, exportLedger(db), WRITTEN);
  const gen1 = exportLedger(db);
  const gen1Text = readFileSync(file, 'utf8');
  value(forgetOther(db));
  await assert.rejects(
    syncForgetLedgerFile(file, exportLedger(db), WRITTEN, {
      beforeRename: () => {
        throw new Error('注入した停止（rename の前）');
      },
    }),
    /rename の前/u,
  );
  const temps = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.equal(temps.length, 1);
  const temp = join(dir, temps[0] ?? '');
  return { gen1, gen1Text, temp, text: readFileSync(temp, 'utf8') };
}

// 同じ系譜で、世代 1 に別の忘却（M_OTHER）を書いた台帳のファイル（連鎖が分岐した台帳）。
async function divergedLedgerText(): Promise<string> {
  let text = '';
  await withDbAndFile(async (db, file) => {
    const target = { source_kind: 'memory', source_id: M_OTHER } as const;
    const { plan, generation } = planFor(db, target, null);
    value(
      memoryOp(db, {
        kind: 'forget.apply',
        target,
        instruction_turn_id: null,
        plan: plan as never,
        source_hmacs: HMACS,
        entry_id: ENTRY_2,
        previous_generation: generation,
        new_ledger_id: LEDGER_ID,
        now: NOW_2,
      }),
    );
    await syncForgetLedgerFile(file, exportLedger(db), WRITTEN);
    text = readFileSync(file, 'utf8');
  });
  return text;
}

test('ledger file: a temp file newer than the DB, of another lineage or of a diverged chain is kept and refused', async () => {
  const diverged = await divergedLedgerText();
  await withDbAndFile(async (db, file, dir) => {
    const { gen1, gen1Text, temp, text } = await stoppedBeforeRename(
      db,
      file,
      dir,
    );
    // DB が世代 1 へ戻された: 世代 2 の一時ファイルを消して in_sync にしない。
    assert.deepEqual(await syncForgetLedgerFile(file, gen1, WRITTEN), {
      ok: false,
      reason: 'ledger_file_ahead',
    });
    assert.equal(readFileSync(temp, 'utf8'), text);
    assert.equal(readFileSync(file, 'utf8'), gen1Text);
    // 別の系譜の一時ファイル（世代 2 の中身のまま系譜だけ違う。系譜は hash に入らない）。
    writeFileSync(
      temp,
      text.replace(LEDGER_ID, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    );
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      { ok: false, reason: 'ledger_lineage_mismatch' },
    );
    // 同じ系譜で世代 1 の hash が違う一時ファイル（連鎖が分岐した）。
    assert.notEqual(diverged, gen1Text);
    writeFileSync(temp, diverged);
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      { ok: false, reason: 'ledger_file_diverged' },
    );
    // 読めない中身（DB から作れない文）も消さずに拒否する。
    writeFileSync(temp, 'not a ledger');
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      { ok: false, reason: 'ledger_file_invalid' },
    );
    assert.equal(readFileSync(temp, 'utf8'), 'not a ledger');
    assert.equal(readFileSync(file, 'utf8'), gen1Text);
    // DB と同じ世代の一時ファイルは DB が中身を含むので消し、書く。
    writeFileSync(temp, text);
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      { ok: true, action: 'written', forgetting_generation: '2' },
    );
    assert.deepEqual(readdirSync(dir), ['forget-ledger.json']);
    // 古い世代の一時ファイル（世代 1 の正規の台帳と同じ中身）は消す。
    writeFileSync(temp, gen1Text);
    assert.deepEqual(
      await syncForgetLedgerFile(file, exportLedger(db), WRITTEN),
      { ok: true, action: 'in_sync', forgetting_generation: '2' },
    );
    assert.deepEqual(readdirSync(dir), ['forget-ledger.json']);
  });
});

test('ledger file: a half-written temp file is removed only when the DB holds its content', async () => {
  await withDbAndFile(async (db, file, dir) => {
    const { gen1, gen1Text, temp, text } = await stoppedBeforeRename(
      db,
      file,
      dir,
    );
    const gen2 = exportLedger(db);
    // DB が世代 2（書いていたときと同じ）: どこで途切れた一時ファイルも DB が中身を含むので消す。
    for (let cut = 0; cut < text.length; cut += 7) {
      writeFileSync(temp, text.slice(0, cut));
      const result = await syncForgetLedgerFile(file, gen2, WRITTEN);
      assert.equal(result.ok, true, `cut ${cut}: ${JSON.stringify(result)}`);
      assert.deepEqual(readdirSync(dir), ['forget-ledger.json'], `cut ${cut}`);
    }
    // 世代 1 の書きかけ（前の書き込みが失敗して残った）も、世代 2 の DB が含むので消す。
    writeFileSync(temp, gen1Text.slice(0, gen1Text.length - 5));
    assert.equal((await syncForgetLedgerFile(file, gen2, WRITTEN)).ok, true);
    assert.deepEqual(readdirSync(dir), ['forget-ledger.json']);
    // DB が世代 1 へ戻された（正規の台帳も世代 1）: 世代 2 の項目まで届いた書きかけは、DB が含まないので残して拒否する。
    writeFileSync(file, gen1Text);
    const partial = text.slice(0, text.length - 3);
    writeFileSync(temp, partial);
    assert.deepEqual(await syncForgetLedgerFile(file, gen1, WRITTEN), {
      ok: false,
      reason: 'ledger_file_invalid',
    });
    assert.equal(readFileSync(temp, 'utf8'), partial);
    assert.equal(readFileSync(file, 'utf8'), gen1Text);
    // 項目まで届いていない書きかけ（schema の行まで）は台帳の中身を持たないので消せる。
    writeFileSync(temp, text.slice(0, 20));
    assert.deepEqual(await syncForgetLedgerFile(file, gen1, WRITTEN), {
      ok: true,
      action: 'in_sync',
      forgetting_generation: '1',
    });
    assert.deepEqual(readdirSync(dir), ['forget-ledger.json']);
  });
});
