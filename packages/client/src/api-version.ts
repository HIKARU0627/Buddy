// 端末が使える API の版（設計 07 §2、ADR 0009・0025）。
// Bootstrap.api_version の major がこの一覧になければ、その中枢を使わない（要求を続けない）。

import { apiCompatibility } from '@buddy/domain';

// この端末が実装している API の major。
export const CLIENT_API_MAJORS: readonly number[] = [1];

const API_VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/u;

// 形式が違う版も使わない（major を読めないため）。
export function checkApiVersion(
  version: string,
  majors: readonly number[] = CLIENT_API_MAJORS,
): 'compatible' | 'upgrade_required' {
  if (!API_VERSION.test(version)) return 'upgrade_required';
  return apiCompatibility(version, majors);
}
