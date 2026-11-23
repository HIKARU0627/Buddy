// Buddy Bridge（ADR 0143）。中枢と同じマシンで動く小さな窓口で、Core へは HTTPS の端末として接続し、
// Muse 向けには絞った経路だけを独自トークンの認証で公開する。Core のコードは読み込まない（接続は HTTPS だけ）。

export {
  bridgeTokenHash,
  bridgeTokenMatches,
  defaultConfigPath,
  emptyConfig,
  generateBridgeToken,
  loadConfig,
  saveConfig,
} from './config.js';
export type { BridgeConfig } from './config.js';
export { createCoreClient } from './core-client.js';
export type {
  CoreClient,
  CoreClientOptions,
  CoreClientOutcome,
} from './core-client.js';
export {
  certificateFingerprint,
  createHttpsCoreTransport,
} from './core-transport.js';
export type {
  CoreTransport,
  CoreTransportOutcome,
  CoreTransportRequest,
  HubEndpoint,
  PeerCertificateOutcome,
} from './core-transport.js';
export { claimSecretHash, generateClaimSecret, pairBridge } from './pairing.js';
export type { HomeFingerprint, PairingDeps, PairingResult } from './pairing.js';
export { createBridgeServer } from './server.js';
export type { AuditEntry, BridgeServer, BridgeServerDeps } from './server.js';
