// Buddy Core（ADR 0012・0019）。Electron に依存しない独立プロセスの起動・停止とローカル制御チャネル、
// DB の組み込み（鍵の照合値・store_generation・起動時の回復）。
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
export type { CoreHandle, CoreStartRefusal, StartCoreOptions } from './core.js';
export { RecoveryError, recoverInterruptedOperations } from './recovery.js';
export type { RecoveryReport } from './recovery.js';
