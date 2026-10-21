// OS 別の鍵保護・起動・端末能力のアダプター（設計 06 の初期のコード配置、ADR 0013・0017・0020）。
// Core から使う。共有層（contracts・domain）からは import しない。Electron には依存しない。
export * from './runner.js';
export * from './supervisor.js';
export * from './macos-launch-agent.js';
export * from './macos-diagnostics.js';
export * from './key-store.js';
// B03-01: TLS の秘密鍵の KeyStore（ADR 0020）。
export * from './tls-key-store.js';
export * from './key-protection.js';
export * from './startup.js';
