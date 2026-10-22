// 押したボタン・行のすぐ下に出す操作の結果の 1 段（ADR 0024 の約束 4「記号＋文言」・約束 7）。
// warning（拒否・失敗）は ⚠（WarningIcon）、success（適用できた）は ● を付ける。記号は読み上げない（文言で伝える）。
// 拒否・失敗も適用の知らせも、押した直後に読み上げるため role="alert" にする。
import { StatusMark } from './StatusText.js';

export function InlineNotice({
  tone,
  text,
}: {
  readonly tone: 'warning' | 'success';
  readonly text: string;
}) {
  return (
    <p
      role="alert"
      className={`flex max-w-prose items-start gap-1.5 text-sm leading-6 ${tone === 'success' ? 'text-success-soft-foreground' : 'text-warning-soft-foreground'}`}
    >
      <span className={`flex shrink-0 ${tone === 'success' ? '' : 'mt-1'}`}>
        <StatusMark
          line={{
            tone,
            mark: tone === 'success' ? 'dot' : 'warning',
            text: '',
          }}
        />
      </span>
      <span>{text}</span>
    </p>
  );
}
