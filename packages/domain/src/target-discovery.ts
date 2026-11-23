// 選べる取得対象（発見の結果）の意味の規則（ADR 0145。設計 01 接続・端末の対象選択、設計 04 取得する対象）。
// 形式（JSON Schema の ConnectionTargetDiscovery）はこの前に検査する。ここは提供元と対象の種類の対応・重複・
// 一覧の状態と中身の対応だけを確かめる。同じ規則を scripts/contract-tools.mjs の意味検査が持つ。
// - Google: カレンダー（calendar）とラベル（mail_label）。カテゴリは無い（not_supported）。
// - Microsoft: フォルダー（mail_folder）とカテゴリ（表示だけ。ADR 0072）。カレンダーは Buddy の Graph の読み取りに
//   無い（ADR 0134・0138）ので not_supported。
// - loaded 以外の一覧は空（拒否・読めないことを「対象が無い」に見せない）。

export const TARGET_DISCOVERY_STATUSES = [
  'loaded',
  'rejected',
  'unavailable',
  'not_supported',
] as const;
export type TargetDiscoveryStatus = (typeof TARGET_DISCOVERY_STATUSES)[number];

export const TARGET_OPTION_KINDS = [
  'calendar',
  'mail_label',
  'mail_folder',
] as const;
export type TargetOptionKind = (typeof TARGET_OPTION_KINDS)[number];

export interface TargetOptionLike {
  readonly id: string;
  readonly kind: string;
  readonly primary: boolean;
}

export interface TargetDiscoveryLike {
  readonly calendars: {
    readonly status: string;
    readonly options: readonly TargetOptionLike[];
  };
  readonly mail_containers: {
    readonly status: string;
    readonly options: readonly TargetOptionLike[];
  };
  readonly categories: {
    readonly status: string;
    readonly categories: readonly { readonly category_id: string }[];
  };
}

// 提供元ごとの、カレンダー・メールの入れ物の対象の種類。null はその種類の対象を持たない（not_supported）。
export const TARGET_OPTION_KIND_BY_PROVIDER: Readonly<
  Record<
    'google' | 'microsoft',
    {
      readonly calendar: TargetOptionKind | null;
      readonly mail: TargetOptionKind;
      readonly categories: boolean;
    }
  >
> = {
  google: { calendar: 'calendar', mail: 'mail_label', categories: false },
  microsoft: { calendar: null, mail: 'mail_folder', categories: true },
};

const hasDuplicate = (ids: readonly string[]): boolean =>
  new Set(ids).size !== ids.length;

/** 発見の結果の意味の誤り。誤りが無ければ空。 */
export function targetDiscoveryErrors(
  provider: 'google' | 'microsoft',
  value: TargetDiscoveryLike,
): string[] {
  const errors: string[] = [];
  const rule = TARGET_OPTION_KIND_BY_PROVIDER[provider];
  const lists = [
    { list: value.calendars, kind: rule.calendar },
    { list: value.mail_containers, kind: rule.mail },
  ];
  for (const { list, kind } of lists) {
    if (list.status !== 'loaded' && list.options.length > 0)
      errors.push('options_without_loaded');
    if (kind === null && list.status !== 'not_supported')
      errors.push('kind_not_supported');
    if (kind !== null && list.status === 'not_supported')
      errors.push('kind_supported');
    if (list.options.some((option) => option.kind !== kind))
      errors.push('option_kind_mismatch');
    if (hasDuplicate(list.options.map((option) => option.id)))
      errors.push('option_duplicate');
  }
  const primaries = [
    ...value.calendars.options,
    ...value.mail_containers.options,
  ].filter((option) => option.primary);
  if (primaries.some((option) => option.kind !== 'calendar'))
    errors.push('primary_not_calendar');
  if (primaries.length > 1) errors.push('primary_duplicate');
  const categories = value.categories;
  if (categories.status !== 'loaded' && categories.categories.length > 0)
    errors.push('categories_without_loaded');
  if (rule.categories === (categories.status === 'not_supported'))
    errors.push(rule.categories ? 'kind_supported' : 'kind_not_supported');
  if (hasDuplicate(categories.categories.map((item) => item.category_id)))
    errors.push('category_duplicate');
  return [...new Set(errors)];
}
