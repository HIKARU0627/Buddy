// 保存してよい記憶の種類の欄（#180 の Q10・U432、ADR 0191。設計 03 忘却と再取り込み、ADR 0024・0181・0183）。標準の端末画面
// （従来の窓）の本体の「記憶と忘却」の欄の上に置く。
// - 6 種類（好み・目標・人・習慣・言葉の使い方・進み具合）を枠で囲んだ行に並べ、行ごとの選択（Checkbox）で許可する。選んだら
//   すぐ中枢へ送る（変えた後の種類の全部。版は main が持つ）。送っている間は全部の選択を止める。
// - 設定の正本は中枢。中枢から読めていない間は選択を置かず、読めていないことを書く（「何も許可していない」と言わない）。
// - 選ぶのをやめても保存済みの記憶は消えないこと、忘れるのは下の「記憶と忘却」の欄であることを書く。
// 理由のコード・API の名前・設定の版は出さない。
import { Checkbox, Description, Label } from '@heroui/react';
import type { DesktopMemoryEntry } from '@buddy/contracts';
import { InlineNotice } from '../../components/InlineNotice.js';
import { Section } from '../../components/Section.js';
import { StatusText } from '../../components/StatusText.js';
import { FRAME_CLASS } from '../../shapes.js';
import {
  MEMORY_KIND_DESCRIPTIONS,
  MEMORY_KIND_LABELS,
  MEMORY_KIND_ORDER,
  MEMORY_SETTINGS_LABELS,
  SETTINGS_PLACE,
  allowedKinds,
} from '../../state/memory-state.js';
import type {
  MemoryActions,
  MemoryViewState,
} from '../../state/memory-state.js';

function KindRow({
  kind,
  allowed,
  disabled,
  actions,
}: {
  readonly kind: DesktopMemoryEntry['kind'];
  readonly allowed: boolean;
  readonly disabled: boolean;
  readonly actions: MemoryActions;
}) {
  return (
    <li className="px-3 py-2.5" data-memory-kind={kind}>
      <Checkbox
        isSelected={allowed}
        isDisabled={disabled}
        onChange={(selected) => actions.setKind(kind, selected)}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Label>{MEMORY_KIND_LABELS[kind]}</Label>
        </Checkbox.Content>
        <Description className="text-xs leading-5 text-muted">
          {MEMORY_KIND_DESCRIPTIONS[kind]}
        </Description>
      </Checkbox>
    </li>
  );
}

export function MemorySettingsPanel({
  state,
  actions,
}: {
  readonly state: MemoryViewState;
  readonly actions: MemoryActions;
}) {
  const settings = allowedKinds(state);
  const notice =
    state.notice !== null && state.notice.place === SETTINGS_PLACE
      ? state.notice
      : null;
  const changing = state.busy === SETTINGS_PLACE;
  return (
    <Section
      id="memory-settings-heading"
      title={MEMORY_SETTINGS_LABELS.section}
    >
      <p className="max-w-prose text-sm leading-6">
        {MEMORY_SETTINGS_LABELS.lead}
      </p>
      {settings === null ? (
        <p className="max-w-prose text-sm leading-6 text-muted">
          {MEMORY_SETTINGS_LABELS.unread}
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <StatusText
              line={
                settings.length === 0
                  ? {
                      tone: 'neutral',
                      mark: 'circle',
                      text: MEMORY_SETTINGS_LABELS.none,
                    }
                  : {
                      tone: 'success',
                      mark: 'dot',
                      text: MEMORY_SETTINGS_LABELS.some(settings.length),
                    }
              }
            />
            {changing ? (
              <span className="text-xs text-muted">
                {MEMORY_SETTINGS_LABELS.changing}
              </span>
            ) : null}
          </p>
          <ul
            aria-label={MEMORY_SETTINGS_LABELS.listLabel}
            className={`flex flex-col divide-y divide-separator ${FRAME_CLASS}`}
          >
            {MEMORY_KIND_ORDER.map((kind) => (
              <KindRow
                key={kind}
                kind={kind}
                allowed={settings.includes(kind)}
                disabled={state.busy !== null}
                actions={actions}
              />
            ))}
          </ul>
          <p className="max-w-prose text-xs leading-5 text-muted">
            {MEMORY_SETTINGS_LABELS.keep}
          </p>
        </>
      )}
      {notice === null ? null : (
        <InlineNotice tone={notice.tone} text={notice.text} />
      )}
    </Section>
  );
}
