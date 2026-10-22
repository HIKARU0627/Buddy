// #87 の模擬メールのアダプター（MockMailConnector）を、Core の差し込み口（ProviderReader・ProviderWriter）へ
// つなぐ（ADR 0030）。読み取りと書込みに別のアダプターを渡せる（時間切れの設定を書込みだけに持たせるため）。
// 接続の状態は、許可の読み取りから決める（読めれば active、変更の範囲があれば read_write）。
// 模擬 provider の真の結果（truth）はここへ渡さない（Core は HTTP の応答と読み取りだけを見る）。

import type { MockMailConnector } from '@buddy/connectors';
import type {
  ProviderConnection,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';

// ラベルの変更に要る範囲（模擬 provider の WRITE_SCOPES.labels と同じ値）。
export const MOCK_LABEL_WRITE_SCOPE = 'mail.labels.change';

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
      return {
        provider: 'mock',
        account_id: permission.account_id,
        status: 'active',
        access: permission.scopes.includes(MOCK_LABEL_WRITE_SCOPE)
          ? 'read_write'
          : 'read',
      };
    },
    readPermission: (accountId) => read.readPermission(accountId),
    readTarget: (remoteId) => read.readTarget(remoteId),
    listEvents: () => read.listEvents(),
  };
  const writer: ProviderWriter = {
    changeLabels: (identity, change) => write.changeLabels(identity, change),
  };
  return { reader, writer };
}
