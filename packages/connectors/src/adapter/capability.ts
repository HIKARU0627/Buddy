// connector の能力の最小の型。
// 暫定: connector の能力の型は #81 で domain に置く予定。それまでは、このファイルの型で自分の能力を表す。
// domain の型ができたら、このファイルの型を差し替える（アダプター本体は能力の登録の部分以外へ依存しない）。

export type MinimalEffectKind = 'Read' | 'RemoteMutation';

export interface MinimalReadCapability {
  readonly kind:
    'permission' | 'mail.message' | 'mail.draft' | 'calendar.events';
  readonly effect_kind: 'Read';
}

export interface MinimalWriteCapability {
  readonly action_kind:
    'mail.labels.change' | 'mail.draft.create' | 'mail.draft.send';
  readonly effect_kind: 'RemoteMutation';
  /** HTTP の自動再送の回数。書込みは常に 0。 */
  readonly automatic_http_retries: 0;
  /** 照合の範囲。下書きの作成は作成物の目印（operation_marker、ADR 0027）、他は正確な対象。 */
  readonly reconcile_scope: 'exact_target' | 'operation_marker';
}

export interface MinimalConnectorCapability {
  readonly provider: 'mock';
  readonly reads: readonly MinimalReadCapability[];
  readonly writes: readonly MinimalWriteCapability[];
}

export const MOCK_CONNECTOR_CAPABILITY: MinimalConnectorCapability = {
  provider: 'mock',
  reads: [
    { kind: 'permission', effect_kind: 'Read' },
    { kind: 'mail.message', effect_kind: 'Read' },
    { kind: 'mail.draft', effect_kind: 'Read' },
    { kind: 'calendar.events', effect_kind: 'Read' },
  ],
  writes: ['mail.labels.change', 'mail.draft.create', 'mail.draft.send'].map(
    (action_kind) => ({
      action_kind: action_kind as MinimalWriteCapability['action_kind'],
      effect_kind: 'RemoteMutation' as const,
      automatic_http_retries: 0 as const,
      reconcile_scope:
        action_kind === 'mail.draft.create'
          ? ('operation_marker' as const)
          : ('exact_target' as const),
    }),
  ),
};
