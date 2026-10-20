// 起動前の検査の入口（設計 06 B01〜B03「鍵保護不能時の停止」、ADR 0012）。
// 検査は理由の配列を返し、一つでもあれば Core は起動しない。
// 鍵保護の実検査は B01-02 が提供する。ここでは入口と模擬の鍵保護だけを置き、
// 平文の保存へ切り替える経路は作らない。

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
  // 実検査（B01-02 で実装）。未実装の間は起動を拒否する。
  | 'os'
  // 模擬起動。模擬の鍵保護が使えるものとして扱う。
  | 'mock'
  // 模擬起動で、鍵保護が使えない状態を再現する（拒否の試験用）。
  | 'mock_unavailable';

export function keyProtectionCheck(mode: KeyProtectionMode): PreflightCheck {
  return () => {
    if (mode === 'mock') return [];
    if (mode === 'mock_unavailable') return ['key_protection_unavailable'];
    return ['key_protection_check_not_implemented'];
  };
}
