// 起動・監督アダプターの境界（ADR 0013）。OS ごとに別のアダプターにする。
// 自動起動は本人が設定で有効にしたときだけ行うため、register は enabled: true を明示的に受け取らない限り何もしない。
// 初期中枢は macOS（Mac mini）だけ。Windows・Linux は例外ではなく unsupported の結果を返す。

export type CorePlatform = 'macos' | 'windows' | 'linux' | 'other';

/** ログイン後に起動する Core の起動方法。どれも絶対パス。 */
export interface CoreLaunchSpec {
  /** node の実行ファイル。 */
  readonly nodePath: string;
  /** Core の CLI（`start --data-dir <path>` を受け付ける入口）。 */
  readonly coreCliPath: string;
  /** Core のデータディレクトリ。ログもこの中に置く。 */
  readonly dataDir: string;
}

export interface RegisterRequest {
  /** 本人が設定で自動起動を有効にしたか。true 以外では登録しない。 */
  readonly enabled: boolean;
  /**
   * 登録と同時に今のセッションへ読み込むか。読み込むと RunAtLoad により Core がすぐ起動する。
   * false なら定義ファイルだけを書き、次のログインから有効になる。
   */
  readonly loadNow: boolean;
  readonly launch: CoreLaunchSpec;
}

export interface UnregisterRequest {
  /**
   * 今のセッションからも外すか。外すと launchd が管理中の Core を止める。
   * false なら定義ファイルだけを消し、実行中の Core はそのまま、次のログインから起動しない。
   */
  readonly unloadNow: boolean;
}

export type UnsupportedReason = 'initial_release_supports_macos_core_only';

export interface UnsupportedResult {
  readonly status: 'unsupported';
  readonly platform: CorePlatform;
  readonly reason: UnsupportedReason;
}

export interface FailedResult {
  readonly status: 'failed';
  /** 失敗した段階（invalid_spec・write_definition・bootstrap など）。 */
  readonly step: string;
  /** 表示用の理由コード。コマンドの出力（ホームのパスなどを含み得る）はそのまま入れない。 */
  readonly reasons: readonly string[];
}

export type RegisterResult =
  | { readonly status: 'not_enabled' }
  | {
      readonly status: 'registered';
      readonly definitionPath: string;
      /** loadNow で今のセッションへ読み込んだか。 */
      readonly loaded: boolean;
      /** すでに読み込まれていたため、読み込み直さなかったか（実行中の Core を止めない）。 */
      readonly alreadyLoaded: boolean;
    }
  | UnsupportedResult
  | FailedResult;

export type UnregisterResult =
  | {
      readonly status: 'unregistered';
      readonly removedDefinition: boolean;
      readonly bootedOut: boolean;
    }
  | UnsupportedResult
  | FailedResult;

export type LoadState = 'loaded' | 'not_loaded' | 'unknown';

export type SupervisorStatus =
  | {
      readonly status: 'ok';
      readonly platform: CorePlatform;
      readonly definitionPath: string;
      readonly installed: boolean;
      readonly load: LoadState;
    }
  | UnsupportedResult;

export interface StartupSupervisor {
  readonly platform: CorePlatform;
  register(request: RegisterRequest): Promise<RegisterResult>;
  unregister(request: UnregisterRequest): Promise<UnregisterResult>;
  status(): Promise<SupervisorStatus>;
}

export function corePlatformOf(nodePlatform: string): CorePlatform {
  switch (nodePlatform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return 'other';
  }
}

/** Windows・Linux など、初期版で中枢の自動起動に対応しない OS のアダプター。 */
export function createUnsupportedStartupSupervisor(
  platform: CorePlatform,
): StartupSupervisor {
  const result: UnsupportedResult = {
    status: 'unsupported',
    platform,
    reason: 'initial_release_supports_macos_core_only',
  };
  return {
    platform,
    register: () => Promise.resolve(result),
    unregister: () => Promise.resolve(result),
    status: () => Promise.resolve(result),
  };
}
