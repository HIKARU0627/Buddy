// 試験装置だけの出口。模擬 provider の起動と、真の結果（truth）を見る API を含む。Core のコードからは読み込まない。
export {
  createMockProvider,
  type MockProvider,
  type MockProviderOptions,
  type MockProviderTruth,
} from './provider/server.js';
export {
  SYNTHETIC_ACCOUNT_ID,
  SYNTHETIC_CLOCK,
  type AppliedChange,
  type MockDraft,
  type MockEvent,
  type MockMail,
  type MockPermission,
  type MockReceipt,
  type ProviderState,
} from './provider/data.js';
export {
  FAULT_POINTS,
  PROVIDER_FAULT_POINTS,
  FaultInjector,
  InjectedFaultError,
} from './fault-injector.js';
