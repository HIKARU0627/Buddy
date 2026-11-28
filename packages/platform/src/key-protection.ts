// 中枢の鍵保護の可否の確認（設計 02 の KeyStore アダプター、ADR 0013・0017）。
// 保護手段が使えない場合は秘密情報を平文で保存せず、対象処理を停止して理由を表示する。
// B02-02 から、確認は実際の KeyStore でデータ鍵を取得（初回は作成）できるかに基づく（ADR 0017）。
// 取得した鍵は確認の結果に含めず、保持もしない。平文の保存へ切り替える経路・設定は作らない。
// Windows は DPAPI（CurrentUser）で確かめる（ADR 0202）。PowerShell を呼べて、DPAPI でデータ鍵を保護・
// 復号でき（初回は作成して読み戻す）、置き場所に書けるときだけ使える。
import type { KeyStore, OsKeyStoreOptions } from './key-store.js';
import {
  createMacKeychainKeyStore,
  createUnsupportedKeyStore,
  createWindowsDpapiKeyStore,
} from './key-store.js';
import { corePlatformOf } from './supervisor.js';

export type KeyProtectionBackend =
  'macos_keychain' | 'windows_dpapi' | 'none' | 'mock';

/** 実機の probe が「使える」と返してよい保護手段。 */
const OS_BACKENDS: readonly KeyProtectionBackend[] = [
  'macos_keychain',
  'windows_dpapi',
];

export type KeyProtectionStatus =
  | {
      readonly available: true;
      readonly backend: Exclude<KeyProtectionBackend, 'none'>;
      readonly reason: null;
    }
  | {
      readonly available: false;
      readonly backend: KeyProtectionBackend;
      /** 表示用の理由コード。保護領域の出力・例外のメッセージ・鍵の値は入れない。 */
      readonly reason: string;
    };

export interface KeyProtectionProbe {
  /** 'os' は実機の確認、'mock' は試験用の模擬。 */
  readonly kind: 'os' | 'mock';
  check(): Promise<KeyProtectionStatus>;
}

/**
 * KeyStore に基づく確認。データ鍵を読み、なければ作成して読み戻す（loadOrCreateDataKey）。
 * 鍵を取得できたときだけ使えるとし、鍵の値は捨てる。kind は KeyStore の kind をそのまま使う。
 */
export function createKeyStoreProbe(keyStore: KeyStore): KeyProtectionProbe {
  return {
    kind: keyStore.kind,
    async check() {
      const result = await keyStore.loadOrCreateDataKey();
      if (result.ok)
        return { available: true, backend: result.backend, reason: null };
      return {
        available: false,
        backend: result.backend,
        reason: result.reason,
      };
    },
  };
}

export interface KeyProtectionProbeOptions extends OsKeyStoreOptions {
  /**
   * macOS・Windows で確認に使う KeyStore（試験で差し替える）。省略時は macOS はキーチェーン、
   * Windows は DPAPI。Linux など対応しない OS では使わない。
   */
  readonly keyStore?: KeyStore;
}

/**
 * 実行中の OS に合う probe（Core では process.platform を渡す）。
 * Linux の中枢は初期版の対象外として使えない（KeyStore も作らない）。
 */
export function createKeyProtectionProbe(
  nodePlatform: string,
  options: KeyProtectionProbeOptions = {},
): KeyProtectionProbe {
  const platform = corePlatformOf(nodePlatform);
  if (platform !== 'macos' && platform !== 'windows')
    return createKeyStoreProbe(createUnsupportedKeyStore(nodePlatform));
  const { keyStore, ...keyStoreOptions } = options;
  if (keyStore !== undefined) return createKeyStoreProbe(keyStore);
  return createKeyStoreProbe(
    platform === 'macos'
      ? createMacKeychainKeyStore(keyStoreOptions)
      : createWindowsDpapiKeyStore(keyStoreOptions),
  );
}

export interface MockKeyProtectionOptions {
  readonly available: boolean;
  /** available: false のときの理由。省略時は mock_unavailable。 */
  readonly reason?: string;
}

/** 試験用の模擬 probe。kind と backend が 'mock' になる。 */
export function createMockKeyProtectionProbe(
  options: MockKeyProtectionOptions,
): KeyProtectionProbe {
  const status: KeyProtectionStatus = options.available
    ? { available: true, backend: 'mock', reason: null }
    : {
        available: false,
        backend: 'mock',
        reason: options.reason ?? 'mock_unavailable',
      };
  return { kind: 'mock', check: () => Promise.resolve(status) };
}

export interface KeyProtectionPreflightOptions {
  /** 模擬の probe を受け入れるか。試験だけで true にする。省略時は拒否する。 */
  readonly allowMock?: boolean;
}

export const KEY_PROTECTION_UNAVAILABLE = 'key_protection_unavailable';

const REASON_CODE = /^[a-z0-9_:.-]{1,128}$/u;

/**
 * Core の起動前検査。鍵保護が使えなければ `key_protection_unavailable:<理由>` を返し、Core は起動を拒否する。
 * 確認が例外で終わった・結果の形が不正・模擬を許していない場合も使えない扱いにする（良好と推測しない）。
 */
export async function keyProtectionPreflight(
  probe: KeyProtectionProbe,
  options: KeyProtectionPreflightOptions = {},
): Promise<string[]> {
  const unavailable = (reason: string) => [
    `${KEY_PROTECTION_UNAVAILABLE}:${reason}`,
  ];
  const isMock = probe.kind === 'mock';
  if (isMock && options.allowMock !== true)
    return unavailable('mock_not_allowed');
  let status: KeyProtectionStatus;
  try {
    status = await probe.check();
  } catch {
    return unavailable('probe_failed');
  }
  if (status === null || typeof status !== 'object')
    return unavailable('probe_result_invalid');
  if (status.available === true) {
    // 実機の probe が返してよい「使える」は macOS のキーチェーンと Windows の DPAPI だけ。模擬の結果は模擬の probe だけ。
    const backendMatches = isMock
      ? status.backend === 'mock'
      : OS_BACKENDS.includes(status.backend);
    return backendMatches ? [] : unavailable('probe_result_invalid');
  }
  if (status.available !== false) return unavailable('probe_result_invalid');
  const { reason } = status;
  return unavailable(
    typeof reason === 'string' && REASON_CODE.test(reason) ? reason : 'unknown',
  );
}
