// Core が使う公開出口。模擬 provider の本体と真の結果を見る API は ./testing だけに置く（Core には渡さない）。
export {
  createMockMailConnector,
  type CalendarEvent,
  type MailTarget,
  type MarkedDraft,
  type MockMailConnector,
  type MockMailConnectorOptions,
  type PermissionState,
  type RemoteDraft,
  type WriteIdentity,
  type WriteOutcome,
} from './adapter/mock-mail-connector.js';
export {
  MOCK_CONNECTOR_CAPABILITY,
  type MinimalConnectorCapability,
  type MinimalEffectKind,
  type MinimalReadCapability,
  type MinimalWriteCapability,
} from './adapter/capability.js';
export {
  FAULT_POINTS,
  FaultInjector,
  InjectedFaultError,
  type ArmOptions,
  type FaultContext,
  type FaultMatch,
  type FaultPoint,
  type FaultSpec,
} from './fault-injector.js';
