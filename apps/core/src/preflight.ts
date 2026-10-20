// 起動前の検査の入口（設計 06 B01〜B03「鍵保護不能時の停止」、ADR 0012・0013・0019）。
// 検査は理由の配列を返し、一つでもあれば Core は起動しない。
// 鍵保護の可否は @buddy/platform の probe で、実際の KeyStore からデータ鍵を取得（初回は作成）できるかで
// 確かめる（ADR 0013・0017）。平文の保存へ切り替える経路は作らない。
// 起動前の検査は単一起動のロックより前に動く。Core はロックの後に同じ KeyStore から鍵を読み直し（作成しない）、
// DB の鍵の照合値と比べる（ADR 0019。初回に二つの Core を同時に起動したときの鍵の上書きの窓への対策）。
import { createHash } from 'node:crypto';
import {
  createKeyProtectionProbe,
  createKeyStore,
  createKeyStoreProbe,
  createMockKeyStore,
  keyProtectionPreflight,
} from '@buddy/platform';
import type { KeyStore } from '@buddy/platform';

export type PreflightCheck = () =>
  readonly string[] | Promise<readonly string[]>;

export async function runPreflight(
  checks: readonly PreflightCheck[],
): Promise<readonly string[]> {
  const reasons: string[] = [];
  for (const check of checks) reasons.push(...(await check()));
  return reasons;
}

export type KeyProtectionMode =
  // 実行中の OS の鍵保護を確かめる（macOS はキーチェーンのデータ鍵。初期版の中枢は macOS だけ）。
  | 'os'
  // 模擬起動。模擬の鍵保護が使えるものとして扱う。
  | 'mock'
  // 模擬起動で、鍵保護が使えない状態を再現する（拒否の試験用）。
  | 'mock_unavailable';

// 模擬起動のデータ鍵の元になる公開の文字列。模擬の鍵は誰でも求められるので、模擬起動の DB は保護されない。
// 試験・模擬起動の再起動で同じ鍵になるように固定する（プロセスごとに変わると鍵の照合値が合わない）。
// 実機の鍵で作った DB を模擬起動で開くと、鍵の照合値が合わずに起動を拒否する（逆も同じ）。
export const MOCK_DATA_KEY_SEED =
  'buddy/mock-data-key/v1: public test value, not a secret';

// 起動の種類に合う KeyStore。模擬は実機の保護領域に触れない（メモリ上の 1 項目）。
export function createCoreKeyStore(
  mode: KeyProtectionMode,
  options: { readonly nodePlatform?: string } = {},
): KeyStore {
  if (mode === 'mock')
    return createMockKeyStore({
      stored: createHash('sha256')
        .update(MOCK_DATA_KEY_SEED, 'utf8')
        .digest('base64'),
    });
  if (mode === 'mock_unavailable')
    return createMockKeyStore({ available: false });
  return createKeyStore(options.nodePlatform ?? process.platform);
}

export interface KeyProtectionCheckOptions {
  // 試験で差し替える。省略時は実行中の OS と、その起動の種類の KeyStore（createCoreKeyStore）。
  // 'os' の検査では keyStore を macOS でだけ使い、模擬の KeyStore（kind: 'mock'）は拒否される。
  readonly nodePlatform?: string;
  readonly keyStore?: KeyStore;
}

export function keyProtectionCheck(
  mode: KeyProtectionMode,
  options: KeyProtectionCheckOptions = {},
): PreflightCheck {
  if (mode !== 'os') {
    const keyStore = options.keyStore ?? createCoreKeyStore(mode);
    return () =>
      keyProtectionPreflight(createKeyStoreProbe(keyStore), {
        allowMock: true,
      });
  }
  return () =>
    keyProtectionPreflight(
      createKeyProtectionProbe(
        options.nodePlatform ?? process.platform,
        options.keyStore === undefined ? {} : { keyStore: options.keyStore },
      ),
    );
}
