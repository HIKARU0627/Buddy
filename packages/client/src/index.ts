// 端末側の接続の純粋な部分（B03-05、ADR 0025）。Node・DOM・Electron の API を使わない。
// 通信（TLS のピン留め・WSS）・時計・形式の検査は transport.ts の境界で受け取り、デスクトップの main が実装を渡す。
export * from './api-version.js';
export * from './backoff.js';
export * from './connection.js';
export * from './transport.js';
