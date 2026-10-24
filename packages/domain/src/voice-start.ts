// Live の接続を始めるときの送信トラックの門（B05-02、ADR 0041。設計 10 §2・§9、09 X31・X54）。
// 送信トラックは、session.started と中枢の「サイドバンド接続済み」の両方が揃うまで無効にする
// （接続前に委譲が起きると中枢が取りこぼすため）。時刻は呼び出し側が単調時計で渡す。

// SDP answer の後、サイドバンドが接続できるまで待つ上限（ms）。超えたら接続を閉じて③へ切り替える（X54）。
export const SIDEBAND_CONNECT_DEADLINE_MS = 3000;
// 呼びかけから session.started までの許容（ms。設計の初期値で合格値ではない）。超えたら効果音で「まだ接続中」を知らせる。
// 原本は「目標 1.5 秒、許容 3 秒。超えたら」と書き、どちらを超えたらかを明示しない。許容（3 秒）を超えたら、と読んだ（原本に決めなし）。
export const SESSION_START_TOLERANCE_MS = 3000;

export interface LiveStartGateInput {
  readonly io_suspended: boolean;
  // 記録しない会話が始まった（接続を開かない。質問 94）。
  readonly private_conversation: boolean;
  readonly session_started: boolean;
  readonly sideband_connected: boolean;
  // SDP answer を受けてからの経過（ms）。
  readonly elapsed_since_answer_ms: number;
  // 呼びかけを検知してからの経過（ms）。
  readonly elapsed_since_wake_ms: number;
  // 「まだ接続中」の効果音をすでに鳴らした（繰り返さない）。
  readonly still_connecting_played: boolean;
}

export interface LiveStartGate {
  // answer を適用してよいか。止める条件があれば（SDP answer 待ち・適用後のどちらでも）適用せず、作成済みのセッションは
  // 中枢がサイドバンドから閉じる（最低 15 秒分の課金は精算に記録する。X31）。
  readonly apply_answer: boolean;
  readonly send_track_enabled: boolean;
  // 「聞き取り開始」の 2 つ目の効果音。送信トラックを有効にするのと同時だけ。
  readonly play_listening_clip: boolean;
  readonly play_still_connecting_clip: boolean;
  readonly close_live: boolean;
  // 閉じたあと③（声で話しかけて文字で返す）へ切り替えるか。入出力の停止中は③も使わない。
  readonly switch_to_local_asr: boolean;
  readonly reasons: readonly string[];
}

// 送信トラックを有効にしてよいか。
// - 入出力の停止中・記録しない会話の開始: 送信トラックは無効のまま、answer を適用せず（待ち中）接続を閉じる。
//   入出力の停止中は③も使わない（画面で明示再開するまで）。記録しない会話は③へ切り替える。
// - サイドバンドが SDP answer から 3 秒を超えても接続できない: 接続を閉じて③へ切り替える（ちょうど 3 秒は待つ）。
// - session.started とサイドバンド接続済みの両方が揃った: 送信トラックを有効にし、2 つ目の効果音を鳴らす。
// - それ以外は待つ。送信トラックは無効のまま。
export function evaluateLiveStartGate(
  input: LiveStartGateInput,
): LiveStartGate {
  const closed = (
    reasons: string[],
    switchToLocalAsr: boolean,
  ): LiveStartGate => ({
    apply_answer: false,
    send_track_enabled: false,
    play_listening_clip: false,
    play_still_connecting_clip: false,
    close_live: true,
    switch_to_local_asr: switchToLocalAsr,
    reasons,
  });
  if (input.io_suspended) return closed(['io_suspended'], false);
  if (input.private_conversation) return closed(['private_conversation'], true);
  const waiting: string[] = [];
  if (!input.session_started) waiting.push('awaiting_session_started');
  if (!input.sideband_connected) waiting.push('awaiting_sideband');
  if (
    !input.sideband_connected &&
    input.elapsed_since_answer_ms > SIDEBAND_CONNECT_DEADLINE_MS
  )
    return closed(['sideband_not_connected_in_time'], true);
  if (waiting.length === 0)
    return {
      apply_answer: true,
      send_track_enabled: true,
      play_listening_clip: true,
      play_still_connecting_clip: false,
      close_live: false,
      switch_to_local_asr: false,
      reasons: [],
    };
  return {
    apply_answer: true,
    send_track_enabled: false,
    play_listening_clip: false,
    play_still_connecting_clip:
      !input.session_started &&
      !input.still_connecting_played &&
      input.elapsed_since_wake_ms > SESSION_START_TOLERANCE_MS,
    close_live: false,
    switch_to_local_asr: false,
    reasons: waiting,
  };
}
