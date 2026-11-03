// B10-02 のアダプターの公開出口（ADR 0080）。試験用の偽の実装は ./testing にだけ置き、製品のコードから読まない。
export type * from './types.js';
export type * from './http.js';
export type * from './provider.js';
export * from './adapter.js';
