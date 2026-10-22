// #87 の模擬メールのアダプター（MockMailConnector）を、Core の差し込み口（ProviderReader・ProviderWriter）へ
// つなぐ（ADR 0030）。読み取りと書込みに別のアダプターを渡せる（時間切れの設定を書込みだけに持たせるため）。
// 接続の状態は、許可の読み取りから決める（読めれば active、変更の範囲があれば read_write）。書込みできる操作の
// 種類（writable_kinds）は、種類ごとの範囲から決める（B04-07: ラベルの変更と下書きの保存を別に許す）。
// 模擬 provider の真の結果（truth）はここへ渡さない（Core は HTTP の応答と読み取りだけを見る）。

import type { MockMailConnector } from '@buddy/connectors';
import type {
  ProviderConnection,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';

// ラベルの変更に要る範囲（模擬 provider の WRITE_SCOPES.labels と同じ値）。
export const MOCK_LABEL_WRITE_SCOPE = 'mail.labels.change';
// 下書きの保存に要る範囲（模擬 provider の WRITE_SCOPES.draftCreate と同じ値）。
export const MOCK_DRAFT_WRITE_SCOPE = 'mail.drafts.create';

// 操作の種類と、その書込みに要る範囲。
const WRITE_SCOPE_OF_KIND: readonly (readonly [string, string])[] = [
  ['mail.labels.change', MOCK_LABEL_WRITE_SCOPE],
  ['mail.draft.create', MOCK_DRAFT_WRITE_SCOPE],
];

// 読み取りの種類と、それに要る範囲（模擬 provider の合成の範囲）。
const READ_SCOPE_OF_KIND: readonly (readonly [string, string])[] = [
  ['mail.message', 'mail.read'],
  ['calendar.events', 'calendar.read'],
];

export interface MockMailPorts {
  readonly reader: ProviderReader;
  readonly writer: ProviderWriter;
}

export function mockMailPorts(options: {
  readonly accountId: string;
  readonly read: MockMailConnector;
  readonly write?: MockMailConnector;
}): MockMailPorts {
  const read = options.read;
  const write = options.write ?? options.read;
  const reader: ProviderReader = {
    async connection(): Promise<ProviderConnection | null> {
      const permission = await read.readPermission(options.accountId);
      if (permission === null) return null;
      const writable = WRITE_SCOPE_OF_KIND.filter(([, scope]) =>
        permission.scopes.includes(scope),
      ).map(([kind]) => kind);
      return {
        provider: 'mock',
        account_id: permission.account_id,
        account_label: permission.account_label,
        status: 'active',
        access: writable.length > 0 ? 'read_write' : 'read',
        writable_kinds: writable,
        readable_kinds: READ_SCOPE_OF_KIND.filter(([, scope]) =>
          permission.scopes.includes(scope),
        ).map(([kind]) => kind),
      };
    },
    readPermission: (accountId) => read.readPermission(accountId),
    readTarget: (remoteId) => read.readTarget(remoteId),
    listEvents: () => read.listEvents(),
    findDrafts: (marker) => read.findDraftsByMarker(marker),
  };
  const writer: ProviderWriter = {
    changeLabels: (identity, change) => write.changeLabels(identity, change),
    createDraft: (identity, draft) => write.createDraft(identity, draft),
  };
  return { reader, writer };
}
