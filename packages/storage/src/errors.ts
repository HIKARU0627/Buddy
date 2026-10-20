// 保存層の拒否（ADR 0016）。reason は機械判定用の理由コードで、パスや SQL・本文を含めない。
// reasons は PRAGMA の読み戻しなど、理由が複数ある場合の内訳。

export class StorageError extends Error {
  readonly reason: string;
  readonly reasons: readonly string[];
  constructor(
    reason: string,
    message: string,
    reasons: readonly string[] = [reason],
  ) {
    super(message);
    this.name = 'StorageError';
    this.reason = reason;
    this.reasons = reasons;
  }
}
