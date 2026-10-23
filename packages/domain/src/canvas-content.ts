// キャンバスの物の中身（行・セル・予定・メールの件名・出典など）の意味の検査（UI-07、ADR 0032 の「UI-07 の部品のカタログ」）。
// 形式（JSON Schema の CanvasContent）の検査の後に別に行う。記述（CanvasDocument）は参照だけで本文を持たず、中身は物ごとに
// 描くときに許可範囲内で取る。中身は中枢の識別子を含まず、行は物の item_refs と同じ順・同じ件数の位置で参照に結び付く。
// DOM・Electron・Node 専用 API に依存しない純粋な関数。Schema が上限を持つ項目も、Schema を通らない経路で作られた値を
// 拒否するために、ここでもう一度確かめる。

// 部品ごとの上限（Schema と同じ。一致は scripts/canvas-content.test.mjs で確かめる）。
export const CANVAS_CONTENT_LIMITS = {
  rows: 50,
  tableColumns: 8,
  compareColumns: { min: 2, max: 3 },
  compareRows: 12,
  mailLabels: 5,
  progressSteps: 12,
  chartPoints: { min: 2, max: 24 },
  chartSeries: { min: 1, max: 3 },
  minutesPerDay: 1440,
  textLength: 120,
  labelLength: 24,
  bodyLength: 2000,
} as const;

export type CanvasContentError =
  | 'component_mismatch'
  | 'refs_mismatch'
  | 'columns_mismatch'
  | 'limit_exceeded'
  | 'range_invalid'
  | 'progress_invalid'
  | 'chart_invalid'
  | 'url_invalid'
  | 'body_not_opened'
  | 'text_invalid';

// 中身の最小の形（contracts の生成型から独立。domain は contracts に依存しない）。
export interface CanvasContentLike {
  readonly component: string;
  readonly rows?: readonly unknown[];
  readonly columns?: readonly unknown[];
  readonly events?: readonly {
    readonly start_minute: number;
    readonly end_minute: number;
  }[];
  readonly day_start_minute?: number;
  readonly day_end_minute?: number;
  readonly mails?: readonly { readonly body: string | null }[];
  readonly steps?: readonly { readonly done: number; readonly total: number }[];
  readonly x_labels?: readonly unknown[];
  readonly series?: readonly { readonly values: readonly number[] }[];
  readonly sources?: readonly { readonly url: string }[];
  readonly text?: string;
}

// 制御文字を拒否するための正規表現なので、no-control-regex をこの範囲だけ外す。
/* eslint-disable no-control-regex */
// 画面へ渡してよい出典の URL か（https だけ。ホスト名があり、ユーザー名・パスワード・空白・制御文字を含まない。2048 文字まで）。
// Schema の CanvasContentUrl と同じ規則。domain は URL クラスを持たない（Node・DOM に依存しない）ので、形で判定する。
// 実際に開くときは、main の externalOpenTarget（URL の解析つき）がもう一度確かめる。
export function isCanvasHttpsUrl(url: string): boolean {
  return (
    url.length <= 2048 &&
    /^https:\/\/[^\s\u0000-\u001F\u007F-\u009F@/?#]+([/?#][^\s\u0000-\u001F\u007F-\u009F]*)?$/u.test(
      url,
    )
  );
}

// 制御文字・方向の制御文字を含まないか（改行を許すときは U+000A を除く）。Schema の pattern と同じ集合。
const FORBIDDEN =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/u;
const FORBIDDEN_NO_NEWLINE =
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

// 中身の文字列を、1 行の文字列と本文（キー body・text。改行を許す）に分ける。
const textsOf = (
  value: unknown,
): { readonly lines: string[]; readonly bodies: string[] } => {
  const lines: string[] = [];
  const bodies: string[] = [];
  const walk = (node: unknown, key: string | null): void => {
    if (typeof node === 'string')
      (key === 'body' || key === 'text' ? bodies : lines).push(node);
    else if (Array.isArray(node)) node.forEach((entry) => walk(entry, key));
    else if (node !== null && typeof node === 'object')
      for (const [name, entry] of Object.entries(node)) walk(entry, name);
  };
  walk(value, null);
  return { lines, bodies };
};

// 物の部品（component）・参照の件数（refCount）・本文を開いた行（openIndex。開かないなら null）に対して、中身が
// 意味として正しいかを検査する。誤りの種類を重複なしで返す（正しければ空）。
export function canvasContentErrors(
  content: CanvasContentLike,
  expected: {
    readonly component: string;
    readonly refCount: number;
    readonly openIndex: number | null;
  },
): readonly CanvasContentError[] {
  const errors = new Set<CanvasContentError>();
  const L = CANVAS_CONTENT_LIMITS;
  if (content.component !== expected.component) {
    errors.add('component_mismatch');
    return [...errors];
  }
  // 文字列は制御文字・方向の制御文字を含まない（本文は改行だけを許す）。
  const { lines, bodies } = textsOf(content);
  if (
    lines.some((value) => FORBIDDEN.test(value)) ||
    bodies.some((value) => FORBIDDEN_NO_NEWLINE.test(value))
  )
    errors.add('text_invalid');
  const aligned = (count: number): void => {
    if (count !== expected.refCount) errors.add('refs_mismatch');
  };
  switch (content.component) {
    case 'list': {
      const rows = content.rows ?? [];
      aligned(rows.length);
      if (rows.length > L.rows) errors.add('limit_exceeded');
      break;
    }
    case 'table': {
      const rows = (content.rows ?? []) as readonly {
        readonly cells: readonly unknown[];
      }[];
      const columns = content.columns ?? [];
      aligned(rows.length);
      if (rows.length > L.rows || columns.length > L.tableColumns)
        errors.add('limit_exceeded');
      if (columns.length === 0) errors.add('columns_mismatch');
      if (rows.some((row) => row.cells.length !== columns.length))
        errors.add('columns_mismatch');
      break;
    }
    case 'schedule_timeline': {
      const events = content.events ?? [];
      aligned(events.length);
      if (events.length > L.rows) errors.add('limit_exceeded');
      const start = content.day_start_minute ?? 0;
      const end = content.day_end_minute ?? 0;
      if (!(start >= 0 && end <= L.minutesPerDay && start < end))
        errors.add('range_invalid');
      if (
        events.some(
          (event) =>
            !(
              event.start_minute < event.end_minute &&
              event.start_minute >= start &&
              event.end_minute <= end
            ),
        )
      )
        errors.add('range_invalid');
      break;
    }
    case 'mail_card': {
      const mails = content.mails ?? [];
      aligned(mails.length);
      if (mails.length > L.rows) errors.add('limit_exceeded');
      // 本文は開いた 1 通だけ。開いていない行の本文を渡さない（本文は開いたときだけ）。
      if (
        mails.some(
          (mail, index) => mail.body !== null && index !== expected.openIndex,
        )
      )
        errors.add('body_not_opened');
      if (
        expected.openIndex !== null &&
        (expected.openIndex >= mails.length ||
          mails[expected.openIndex]?.body === null)
      )
        errors.add('body_not_opened');
      break;
    }
    case 'compare': {
      const columns = content.columns ?? [];
      const rows = (content.rows ?? []) as readonly {
        readonly values: readonly unknown[];
      }[];
      if (
        columns.length < L.compareColumns.min ||
        columns.length > L.compareColumns.max ||
        rows.length > L.compareRows
      )
        errors.add('limit_exceeded');
      if (rows.some((row) => row.values.length !== columns.length))
        errors.add('columns_mismatch');
      break;
    }
    case 'progress': {
      const steps = content.steps ?? [];
      if (steps.length > L.progressSteps) errors.add('limit_exceeded');
      if (
        steps.some(
          (step) =>
            !(
              Number.isInteger(step.done) &&
              Number.isInteger(step.total) &&
              step.total >= 1 &&
              step.done >= 0 &&
              step.done <= step.total
            ),
        )
      )
        errors.add('progress_invalid');
      break;
    }
    case 'chart': {
      const labels = content.x_labels ?? [];
      const series = content.series ?? [];
      if (
        labels.length < L.chartPoints.min ||
        labels.length > L.chartPoints.max ||
        series.length < L.chartSeries.min ||
        series.length > L.chartSeries.max
      )
        errors.add('limit_exceeded');
      if (
        series.some(
          (entry) =>
            entry.values.length !== labels.length ||
            entry.values.some((value) => !Number.isFinite(value)),
        )
      )
        errors.add('chart_invalid');
      break;
    }
    case 'source_list': {
      const sources = content.sources ?? [];
      aligned(sources.length);
      if (sources.length > L.rows) errors.add('limit_exceeded');
      if (sources.some((source) => !isCanvasHttpsUrl(source.url)))
        errors.add('url_invalid');
      break;
    }
    case 'text': {
      if ((content.text ?? '').trim() === '') errors.add('text_invalid');
      break;
    }
    default:
      errors.add('component_mismatch');
  }
  return [...errors];
}
