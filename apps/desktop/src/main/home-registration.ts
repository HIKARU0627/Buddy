// 中枢の画面の「自宅のネットワーク」で画面へ渡す伏せた表示（設計 11 §10、ADR 0022・0026、B03-08）。
//
// - 中枢のマシンが今つながっているネットワークの指紋（ゲートウェイの MAC・サブネット・SSID）は main だけが持つ。
//   画面（Renderer）・IPC・ログには、次の伏せた表示だけを出す。
//   - ゲートウェイの MAC: 最後の 2 組だけ（例 53:01）。
//   - サブネット: そのまま（中枢も平文で保存し、端末の判定の理由にも出る値。秘密ではない）。
//   - SSID: 文字数（Unicode のコードポイントの数）と、4 文字以上なら先頭の 1 文字。3 文字以下は文字数だけ。
// - 登録は、画面で確かめた値と同じ指紋だけを送る（参照を作ったときの指紋と、送る直前に集め直した指紋を比べる）。
// Electron に依存しない純粋な関数だけを置き、node:test で試験する。

import type { DesktopHomeObservation, HomeFingerprint } from '@buddy/contracts';

// 指紋の読み取りの上限（macOS は route・arp・ipconfig・networksetup を順に実行する。各コマンドは runner の
// 10 秒で切れる）。過ぎたら読み取れなかった扱いにする。
export const HOME_COLLECT_TIMEOUT_MS = 20_000;

// 先頭の文字を出す SSID の最小の文字数（短い SSID は先頭の文字で大半が分かるため、文字数だけにする）。
export const SSID_HINT_MIN_LENGTH = 4;

type SsidUnavailableReason = NonNullable<
  DesktopHomeObservation['ssid_unavailable_reason']
>;

// @buddy/platform の取れなかった理由のコードを、画面の理由にまとめる。
function ssidReasonOf(unavailable: readonly string[]): SsidUnavailableReason {
  if (unavailable.includes('ssid_redacted')) return 'redacted';
  if (unavailable.includes('ssid_ambiguous')) return 'ambiguous';
  return 'unavailable';
}

export function ssidHintOf(
  ssid: string,
): NonNullable<DesktopHomeObservation['ssid_hint']> {
  const characters = Array.from(ssid);
  return {
    first:
      characters.length >= SSID_HINT_MIN_LENGTH
        ? (characters[0] as string)
        : null,
    length: characters.length,
  };
}

// MAC（小文字の 2 桁のコロン区切り 6 組。契約の形で検査済み）の最後の 2 組。
export function macTailOf(mac: string): string {
  return mac.slice(-5);
}

// 指紋（契約の形に合わない要素は null にした後の値）を画面へ渡す伏せた表示にする。どの要素も取れなければ null
// （読み取れなかった扱い）。ref は登録できる（ゲートウェイの MAC とサブネットがある）ときだけ渡す。
export function maskHomeObservation(
  fingerprint: HomeFingerprint,
  unavailable: readonly string[],
  ref: string | null,
  collectedAt: string,
): DesktopHomeObservation | null {
  if (
    fingerprint.gateway_mac === null &&
    fingerprint.subnet === null &&
    fingerprint.ssid === null
  )
    return null;
  return {
    ref: registrable(fingerprint) ? ref : null,
    collected_at: collectedAt,
    gateway_mac_tail:
      fingerprint.gateway_mac === null
        ? null
        : macTailOf(fingerprint.gateway_mac),
    subnet: fingerprint.subnet,
    ssid_hint: fingerprint.ssid === null ? null : ssidHintOf(fingerprint.ssid),
    ssid_unavailable_reason:
      fingerprint.ssid === null ? ssidReasonOf(unavailable) : null,
  };
}

// 自宅として登録できる指紋か（中枢はゲートウェイの MAC とサブネットを必須にしている。ADR 0022）。
export function registrable(fingerprint: HomeFingerprint): boolean {
  return fingerprint.gateway_mac !== null && fingerprint.subnet !== null;
}

export function sameFingerprint(
  a: HomeFingerprint,
  b: HomeFingerprint,
): boolean {
  return (
    a.gateway_mac === b.gateway_mac &&
    a.subnet === b.subnet &&
    a.ssid === b.ssid
  );
}
