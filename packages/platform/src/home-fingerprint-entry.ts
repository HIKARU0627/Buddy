// 端末（デスクトップの main）が使う公開出口（B03-05、ADR 0025）。自宅の指紋の収集と、それに要るコマンドの
// runner だけを出す。キーチェーン・起動の監督など中枢側のアダプターは含めない（デスクトップの lint は
// @buddy/platform のうちこの出口だけを読み込めるようにしている）。
export * from './home-fingerprint.js';
export { createMockCommandRunner, createNodeCommandRunner } from './runner.js';
export type {
  CommandResult,
  CommandRunner,
  MockCommandRunner,
  NodeCommandRunnerOptions,
  RecordedCommand,
} from './runner.js';
