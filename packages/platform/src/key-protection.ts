// 中枢の鍵保護の可否の確認（設計 02 の KeyStore アダプター、ADR 0013）。
// 保護手段が使えない場合は秘密情報を平文で保存せず、対象処理を停止して理由を表示する。
// この境界は可否の確認だけを行い、保存・暗号化はしない（キーチェーンの実装は B02）。
// 平文の保存へ切り替える経路・設定は作らない。
import type { CommandRunner } from './runner.js';
import { corePlatformOf } from './supervisor.js';

export const SECURITY_PATH = '/usr/bin/security';

export type KeyProtectionBackend = 'macos_keychain' | 'none' | 'mock';

export type KeyProtectionStatus =
  | {
      readonly available: true;
      readonly backend: Exclude<KeyProtectionBackend, 'none'>;
      readonly reason: null;
    }
  | {
      readonly available: false;
      readonly backend: KeyProtectionBackend;
      /** 表示用の理由コード。コマンドの出力（キーチェーンのパスなど）は入れない。 */
      readonly reason: string;
    };

export interface KeyProtectionProbe {
  /** 'os' は実機の確認、'mock' は試験用の模擬。 */
  readonly kind: 'os' | 'mock';
  check(): Promise<KeyProtectionStatus>;
}

/**
 * macOS: `security default-keychain` で既定のキーチェーンがあることだけを確かめる。
 * キーチェーンへの書込み・読み出しはしない。
 */
export function createMacKeychainProbe(
  runner: CommandRunner,
): KeyProtectionProbe {
  return {
    kind: 'os',
    async check() {
      const result = await runner.run(SECURITY_PATH, ['default-keychain']);
      if (result.exitCode === null)
        return {
          available: false,
          backend: 'macos_keychain',
          reason: 'security_command_unavailable',
        };
      if (result.exitCode !== 0)
        return {
          available: false,
          backend: 'macos_keychain',
          reason: 'default_keychain_query_failed',
        };
      // 出力は `    "<パス>"` の 1 行。パスの値は理由に含めない。
      const lines = result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length !== 1 || !/^"[^"]+"$/u.test(lines[0] ?? ''))
        return {
          available: false,
          backend: 'macos_keychain',
          reason: 'default_keychain_missing',
        };
      return { available: true, backend: 'macos_keychain', reason: null };
    },
  };
}

/** 初期版で中枢の鍵保護に対応しない OS の probe。 */
export function createUnsupportedKeyProtectionProbe(
  nodePlatform: string,
): KeyProtectionProbe {
  const platform = corePlatformOf(nodePlatform);
  const reason =
    platform === 'windows' || platform === 'linux'
      ? `${platform}_core_not_supported_in_initial_release`
      : 'platform_not_supported';
  return {
    kind: 'os',
    check: () => Promise.resolve({ available: false, backend: 'none', reason }),
  };
}

/** 実行中の OS に合う probe（Core では process.platform を渡す）。 */
export function createKeyProtectionProbe(
  nodePlatform: string,
  runner: CommandRunner,
): KeyProtectionProbe {
  return corePlatformOf(nodePlatform) === 'macos'
    ? createMacKeychainProbe(runner)
    : createUnsupportedKeyProtectionProbe(nodePlatform);
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
    // 実機の probe が返してよい「使える」は macOS のキーチェーンだけ。模擬の結果は模擬の probe だけ。
    const backendMatches = isMock
      ? status.backend === 'mock'
      : status.backend === 'macos_keychain';
    return backendMatches ? [] : unavailable('probe_result_invalid');
  }
  if (status.available !== false) return unavailable('probe_result_invalid');
  const { reason } = status;
  return unavailable(
    typeof reason === 'string' && REASON_CODE.test(reason) ? reason : 'unknown',
  );
}
