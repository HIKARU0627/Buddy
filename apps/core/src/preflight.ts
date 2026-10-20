// 起動前の検査の入口（設計 06 B01〜B03「鍵保護不能時の停止」、ADR 0012・0013）。
// 検査は理由の配列を返し、一つでもあれば Core は起動しない。
// 鍵保護の可否は @buddy/platform の probe で、実際の KeyStore からデータ鍵を取得（初回は作成）できるかで
// 確かめる（ADR 0013・0017）。平文の保存へ切り替える経路は作らない。
import {
  createKeyProtectionProbe,
  createMockKeyProtectionProbe,
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

export interface KeyProtectionCheckOptions {
  // 試験で差し替える。省略時は実行中の OS と、その OS の KeyStore（macOS はキーチェーン）。
  // keyStore は macOS でだけ使う。模擬の KeyStore（kind: 'mock'）は 'os' の検査では拒否される。
  readonly nodePlatform?: string;
  readonly keyStore?: KeyStore;
}

export function keyProtectionCheck(
  mode: KeyProtectionMode,
  options: KeyProtectionCheckOptions = {},
): PreflightCheck {
  if (mode !== 'os')
    return () =>
      keyProtectionPreflight(
        createMockKeyProtectionProbe({ available: mode === 'mock' }),
        { allowMock: true },
      );
  return () =>
    keyProtectionPreflight(
      createKeyProtectionProbe(
        options.nodePlatform ?? process.platform,
        options.keyStore === undefined ? {} : { keyStore: options.keyStore },
      ),
    );
}
