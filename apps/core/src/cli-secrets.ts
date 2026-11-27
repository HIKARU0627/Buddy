// 起動の環境変数から受け取る秘密（レシートの読み取りの鍵、Google の OAuth クライアントシークレット）の扱い。
//
// 読んだ直後に process.env から消す。消さないと、packages/platform の createNodeCommandRunner が起動する子プロセス
// （tailscale、macOS の security・launchctl など）が親の環境をそのまま受け継ぎ、鍵が子プロセスから見える。
// 限界: Linux の /proc/<pid>/environ は起動時の環境を見せ続けるので、同じ利用者の別のプロセスからは読める
// （環境変数で受け取る方式の限界。ADR 0178・0144 の追補）。
import type { CoreHouseholdOptions } from './core.js';
import { RECEIPT_API_KEY_ENV } from './household-receipt-reader.js';
import type { KeyProtectionMode } from './preflight.js';

export const GOOGLE_OAUTH_CLIENT_SECRET_ENV =
  'BUDDY_GOOGLE_OAUTH_CLIENT_SECRET';

export interface StartupSecrets {
  // 値そのまま（形の検査は起動の設定が行い、形の違いは receipt_api_key_invalid として記録する）。なければ null。
  readonly receiptApiKey: string | null;
  readonly googleClientSecret: string | null;
}

const present = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

// 秘密を読んで env から消す。読んだ値はそれぞれの起動の設定にだけ渡す。
export function takeStartupSecrets(env: NodeJS.ProcessEnv): StartupSecrets {
  const secrets: StartupSecrets = {
    receiptApiKey: present(env[RECEIPT_API_KEY_ENV]),
    googleClientSecret: present(env[GOOGLE_OAUTH_CLIENT_SECRET_ENV]),
  };
  delete env[RECEIPT_API_KEY_ENV];
  delete env[GOOGLE_OAUTH_CLIENT_SECRET_ENV];
  return secrets;
}

// レシートの読み取りの設定。模擬の起動（mock・mock_unavailable）では外部のモデルへ送らないので、鍵を渡さず
// household の provider を付けない。
export function householdOptionsFor(
  mode: KeyProtectionMode,
  receiptApiKey: string | null,
): { readonly household?: CoreHouseholdOptions } {
  return mode === 'os'
    ? { household: { receiptProvider: { apiKey: receiptApiKey } } }
    : {};
}
