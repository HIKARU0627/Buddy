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
  collectPages,
  defaultGoogleHttpTransport,
  GoogleApiError,
  GoogleHttpClient,
  GoogleTransportFailure,
  type GoogleAccessTokenSource,
  type GoogleApiErrorKind,
  type GoogleHttpClientOptions,
  type GoogleHttpTransport,
  type GoogleHttpTransportRequest,
  type GoogleHttpTransportResponse,
  type GooglePage,
  type GoogleQuery,
  type GoogleTransportFailureReason,
} from './adapter/google-http.js';
export {
  createGoogleCalendarReader,
  type GoogleCalendarEvent,
  type GoogleCalendarEventTime,
  type GoogleCalendarReader,
  type ListCalendarEventsRequest,
} from './adapter/google-calendar.js';
export {
  createGoogleGmailReader,
  GoogleHistoryExpiredError,
  type GoogleGmailHeader,
  type GoogleGmailMessage,
  type GoogleGmailMessageFormat,
  type GoogleGmailMessageRef,
  type GoogleGmailPart,
  type GoogleGmailReader,
  type GoogleHistoryEntry,
  type GoogleHistoryLabelChange,
  type GoogleHistoryResult,
} from './adapter/google-gmail.js';
export {
  createGoogleReadConnector,
  GOOGLE_READ_CAPABILITY,
  type GoogleReadConnector,
} from './adapter/google-connector.js';
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
