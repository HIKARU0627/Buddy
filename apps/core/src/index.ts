// Buddy Core（ADR 0012・0019・0020）。Electron に依存しない独立プロセスの起動・停止とローカル制御チャネル、
// DB の組み込み（鍵の照合値・store_generation・起動時の回復）、HTTPS の受付と経路の検査（B03-01）。
export {
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  Lifecycle,
  controlOpDisposition,
  nextLifecycleState,
} from './lifecycle.js';
export type { LifecycleEvent, LifecycleState } from './lifecycle.js';
export {
  CONTROL_OPS,
  MAX_CONTROL_LINE_BYTES,
  encodeControlMessage,
  parseControlRequest,
} from './control-protocol.js';
export type {
  ControlOp,
  ControlParseResult,
  ControlRejectReason,
  ControlRequest,
  ControlResponse,
  ControlStatus,
} from './control-protocol.js';
export { callControl } from './control-channel.js';
export type { ControlCallResult } from './control-channel.js';
export {
  DB_FILE,
  LOCK_FILE,
  SOCKET_FILE,
  STATE_FILE,
  controlEndpoint,
  defaultDataDir,
  socketPathTooLong,
} from './paths.js';
export { parseCoreState } from './data-dir.js';
export type { CoreState } from './data-dir.js';
export { defaultIsPidAlive, parseLockRecord } from './lock.js';
export type { LockRecord, LockRefusal } from './lock.js';
export {
  MOCK_DATA_KEY_SEED,
  createCoreKeyStore,
  keyProtectionCheck,
  runPreflight,
} from './preflight.js';
export type { KeyProtectionMode, PreflightCheck } from './preflight.js';
export { CoreStartError, startCore } from './core.js';
export type {
  CoreHandle,
  CoreHttpsInfo,
  CoreHttpsOptions,
  CoreStartRefusal,
  StartCoreOptions,
} from './core.js';
export {
  API_VERSION,
  ApiListenError,
  DEFAULT_API_LIMITS,
  DEFAULT_HTTPS_PORT,
  INPUT_ORIGINS,
  createApiServer,
  listenHostReason,
  listenPortReason,
} from './api-server.js';
export type {
  ApiLimits,
  ApiServer,
  ApiServerOptions,
  ApiStore,
} from './api-server.js';
export { API_ROUTES, matchRoute } from './api-routes.js';
export type { ApiRoute, HttpMethod, RouteMatch } from './api-routes.js';
export {
  DEVICE_TOKEN_PATTERN,
  commandScopeState,
  createDeviceToken,
  deviceTokenHash,
  parseBearerToken,
} from './api-auth.js';
export type { CommandScopeState } from './api-auth.js';
export { SAFE_REQUEST_ENVIRONMENT } from './api-environment.js';
export type {
  EnvironmentInput,
  RequestEnvironment,
} from './api-environment.js';
export {
  CERTIFICATE_NOT_AFTER,
  certificateFingerprint,
  isCertificateFingerprint,
} from './tls-certificate.js';
export {
  TLS_CERTIFICATE_FILE,
  TlsIdentityError,
  loadOrCreateTlsIdentity,
} from './tls-identity.js';
export type { TlsIdentity, TlsIdentityCreation } from './tls-identity.js';
export { RecoveryError, recoverInterruptedOperations } from './recovery.js';
export type { RecoveryReport } from './recovery.js';
// B03-04: スナップショット・イベントの配信（WSS）・操作の経路（ADR 0023）。
export {
  EVENT_CURSOR_TTL_MS,
  cursorReplayDecision,
  decodeEventCursor,
  encodeEventCursor,
} from './event-cursor.js';
export type {
  EventCursorValue,
  ReplayRange,
  ResnapshotReason,
} from './event-cursor.js';
export { EventFeed } from './event-feed.js';
export type {
  EventEnvelope,
  EventFeedOptions,
  EventQueryStore,
} from './event-feed.js';
export { STREAM_CLOSE_CODES, createEventStream } from './event-stream.js';
export type { EventStreamManager, EventStreamOptions } from './event-stream.js';
export {
  REVISION_CHECKED_ROUTES,
  createOperationRoutes,
  deviceCommandId,
  requestHash,
} from './api-operations.js';
export type { OperationRoutes, PreviewCheck } from './api-operations.js';
export { DeviceConnections } from './device-connections.js';
export type { DeviceCloseReason } from './device-connections.js';
