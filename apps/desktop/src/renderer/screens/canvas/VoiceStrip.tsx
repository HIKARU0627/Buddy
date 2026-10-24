// 状態の層のパネルの音声の段（B05-06、本人の判断 2026-10-23、ADR 0050）。説明文は置かず、並びと形で伝える。
// 1 段目は左から: マイクの記号・音声の状態（停止中は ■ だけ）・「音声を外部へ送っている」の印（つまみの専用の記号と
// 同じ形。送っていれば塗った面、送っていなければ線だけ）・「続ける」（押せる間だけ塗った面、押せない間は枠だけ）。
// 2 段目は、印の列の右端にそろえて同意の取り消し（同意しているときだけ。印と縦に並べて、何の同意かを位置で示す）。
// 2 段目の高さはいつも取っておき、取り消しが出入りしても下が動かないようにする。
// 「続ける」は呼びかけ語なしで声の会話を始める最小のボタンで、押せるのは呼びかけ待ちで外部へ送っていないときだけ
// （受付と同意の確認は main。同意がなければ main が OS の確認ダイアログを 1 回だけ出す）。
// ロック中・不明は、位置だけを残して中身を隠す（灰色の面）。理由のコード・送り先の名前は出さない。
import { Button, Spinner, Tooltip } from '@heroui/react';
import { InlineNotice } from '../../components/InlineNotice.js';
import { PrivacyIcon, StatusItemIcon } from '../../components/StatusIcons.js';
import { StatusMark, StatusText } from '../../components/StatusText.js';
import type { VoiceStripView } from '../../state/status-panel-state.js';

export const VOICE_LABELS = {
  region: '音声',
  continue: '続ける',
  continueName: '呼びかけなしで声の会話を始める',
  revoke: '同意を取り消す',
  revokeName: '音声を外部へ送ることへの同意を取り消す',
  externalOn: '音声を外部へ送っている',
  externalOff: '音声を外部へ送っていない',
  externalUnknown: '音声を外部へ送っているかは未受信',
  hidden: '音声: 隠しています',
} as const;

const EXTERNAL_CLASS: Readonly<Record<VoiceStripView['external'], string>> = {
  on: 'border border-warning-soft-foreground bg-warning-soft text-warning-soft-foreground',
  off: 'border border-separator text-muted',
  unknown: 'border border-dashed border-muted text-muted',
};

const EXTERNAL_NAME: Readonly<Record<VoiceStripView['external'], string>> = {
  on: VOICE_LABELS.externalOn,
  off: VOICE_LABELS.externalOff,
  unknown: VOICE_LABELS.externalUnknown,
};

export function VoiceStrip({
  view,
  message,
  onContinue,
  onRevoke,
}: {
  readonly view: VoiceStripView;
  // 「続ける」・取り消しの拒否の文言（なければ null）。
  readonly message: string | null;
  readonly onContinue: () => void;
  readonly onRevoke: () => void;
}) {
  if (view.kind === 'hidden')
    return (
      <div
        role="img"
        aria-label={VOICE_LABELS.hidden}
        data-voice="hidden"
        className="h-14 rounded-md bg-default"
      />
    );
  const live = view.external === 'on';
  return (
    <section
      aria-label={VOICE_LABELS.region}
      data-voice="shown"
      className="flex flex-col gap-2"
    >
      <div
        className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-2 ${live ? 'border border-warning-soft-foreground bg-warning-soft' : 'border border-separator'}`}
      >
        <StatusItemIcon
          item="voice"
          className={`size-5 shrink-0 ${live ? 'text-warning-soft-foreground' : 'text-muted'}`}
        />
        <p role="status" className="min-w-0 truncate text-sm">
          {view.showText ? (
            <StatusText line={view.line} />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <StatusMark line={view.line} />
              <span className="sr-only">{view.line.text}</span>
            </span>
          )}
        </p>
        <Tooltip delay={250} closeDelay={0}>
          <Tooltip.Trigger
            tabIndex={0}
            role="img"
            aria-label={EXTERNAL_NAME[view.external]}
            data-external={view.external}
            className={`flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent ${EXTERNAL_CLASS[view.external]}`}
          >
            <PrivacyIcon
              mark="voice_external"
              className={`size-4 ${view.external === 'unknown' ? 'opacity-40' : ''}`}
            />
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">
            <span className="text-xs">{EXTERNAL_NAME[view.external]}</span>
          </Tooltip.Content>
        </Tooltip>
        {/* 押せる間だけ主のボタン（塗った面）。押せない間は枠だけにする（位置は変えない。見た目のレビュー）。 */}
        <Button
          variant={view.continueState === 'ready' ? 'primary' : 'outline'}
          size="sm"
          aria-label={VOICE_LABELS.continueName}
          isDisabled={view.continueState !== 'ready'}
          onPress={onContinue}
          data-continue={view.continueState}
          className="w-20 shrink-0 gap-1.5"
        >
          {view.continueState === 'starting' ? (
            <Spinner size="sm" color="current" aria-hidden="true" />
          ) : null}
          {VOICE_LABELS.continue}
        </Button>
        {/* 2 段目の高さはいつも取っておく（取り消しが出入りしても、下の 8 項目が動かない。見た目のレビュー）。 */}
        <span
          data-revoke-row
          className="col-span-2 col-start-2 -mr-1 flex h-8 items-center justify-end"
        >
          {view.revocable ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={VOICE_LABELS.revokeName}
              onPress={onRevoke}
              className="h-8 px-2 text-xs text-muted"
            >
              {VOICE_LABELS.revoke}
            </Button>
          ) : null}
        </span>
      </div>
      {view.notice === null ? null : (
        <InlineNotice tone="warning" text={view.notice} />
      )}
      {message === null ? null : <InlineNotice tone="warning" text={message} />}
    </section>
  );
}
