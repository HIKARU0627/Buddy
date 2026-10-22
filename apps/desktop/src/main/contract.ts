// デスクトップの限定 IPC の形式検査（ADR 0014・0015）。
// 正本は packages/contracts の JSON Schema で、main は受け取った要求と、送る前の応答・通知・状態欄を Ajv で検査する。
// 状態欄の意味検査は scripts/contract-tools.mjs の semanticErrors と同じ意味を desktop 側に最小限で持つ（scripts を import しない）。
// Electron に依存しない（node:test で試験する）。
import { readFileSync } from 'node:fs';
import type {
  DesktopConnectionView,
  DesktopIpcNotification,
  DesktopIpcRequest,
  DesktopIpcResponse,
  DesktopStatusBar,
} from '@buddy/contracts';
import ajvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;

const CONTRACT_NAMES = [
  'DesktopIpcRequest',
  'DesktopIpcResponse',
  'DesktopIpcNotification',
  'DesktopStatusBar',
  'DesktopConnectionView',
] as const;

type ContractName = (typeof CONTRACT_NAMES)[number];

export interface DesktopContract {
  isRequest(value: unknown): value is DesktopIpcRequest;
  // 送る前の検査。形式の誤りと意味の誤りのコードを返す（空なら送ってよい）。
  responseErrors(value: DesktopIpcResponse): readonly string[];
  notificationErrors(value: DesktopIpcNotification): readonly string[];
  statusBarErrors(value: DesktopStatusBar): readonly string[];
  connectionErrors(value: DesktopConnectionView): readonly string[];
  // 中枢の API の形式の検査（Bootstrap・Snapshot・PairingClaim・DeviceCredential など、契約の $defs の名前）。
  // @buddy/client の ClientContract としても使う。
  valid(name: string, value: unknown): boolean;
}

// schema の JSON は @buddy/contracts の公開出口（./schema.json）から読む。別ワークスペースの src は参照しない。
export function contractSchemaUrl(): URL {
  return new URL(import.meta.resolve('@buddy/contracts/schema.json'));
}

export function loadContractSchema(): unknown {
  return JSON.parse(readFileSync(contractSchemaUrl(), 'utf8'));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createDesktopContract(schema: unknown): DesktopContract {
  if (!isRecord(schema) || typeof schema['$id'] !== 'string')
    throw new Error('desktop_contract_schema_invalid');
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validators = new Map(
    CONTRACT_NAMES.map((name) => {
      const validator = ajv.getSchema(`${schema['$id']}#/$defs/${name}`);
      if (!validator) throw new Error(`desktop_contract_missing:${name}`);
      return [name, validator] as const;
    }),
  );
  const valid = (name: ContractName, value: unknown): boolean =>
    validators.get(name)?.(value) === true;
  const errors = (name: ContractName, value: unknown): string[] =>
    valid(name, value) ? desktopSemanticErrors(name, value) : ['schema'];
  return {
    isRequest: (value): value is DesktopIpcRequest =>
      valid('DesktopIpcRequest', value),
    responseErrors: (value) => errors('DesktopIpcResponse', value),
    notificationErrors: (value) => errors('DesktopIpcNotification', value),
    statusBarErrors: (value) => errors('DesktopStatusBar', value),
    connectionErrors: (value) => errors('DesktopConnectionView', value),
    valid: (name, value) => {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) return false;
      const validator = ajv.getSchema(
        `${String(schema['$id'])}#/$defs/${name}`,
      );
      if (!validator) throw new Error(`desktop_contract_missing:${name}`);
      return validator(value) === true;
    },
  };
}

// 来客モードも全端末の停止なので「全体停止中」と表示する（ADR 0014 の読み取り）。
const STOPPED_VOICE: Readonly<Record<string, string>> = {
  local: 'device_stopped',
  guest: 'global_stopped',
  global: 'global_stopped',
};

// 形式検査に通った値だけを受け取る。文書に明記した局所的な不変条件だけを見る（ADR 0014 の意味検査）。
export function desktopSemanticErrors(
  name: ContractName,
  value: unknown,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return errors;
  if (name === 'DesktopStatusBar' && value['visibility'] === 'shown') {
    const scope = String(value['stop_scope']);
    if (value['input_permitted'] === true && scope !== 'none')
      errors.push('input_permitted_while_stopped');
    const voice = value['voice_state'];
    if (
      voice !== null &&
      (scope === 'none'
        ? Object.values(STOPPED_VOICE).includes(String(voice))
        : voice !== STOPPED_VOICE[scope])
    )
      errors.push('voice_state_conflicts_with_stop');
    const hubValues = [
      value['display_target'],
      value['storage_mode'],
      value['budget_held'],
      value['safety_stopped'],
    ];
    const connection = value['hub_connection'];
    // 接続中は最終確認時刻を必ず持つ。中枢がまだ正本を持たない値は接続中でも null（不明）にできる（ADR 0025）。
    if (connection === 'connected' && value['hub_last_confirmed_at'] === null)
      errors.push('connected_without_values');
    if (
      connection !== 'connected' &&
      (hubValues.some((v) => v !== null) ||
        (connection === 'not_connected' &&
          value['hub_last_confirmed_at'] !== null))
    )
      errors.push('hub_values_without_connection');
  }
  // 中枢との接続・ペアリングの状態（ADR 0025）。
  if (name === 'DesktopConnectionView' && value['visibility'] === 'shown') {
    const pairing = value['pairing'];
    if (isRecord(pairing)) {
      const step = pairing['step'];
      if ((step === 'failed') !== (pairing['failure'] !== null))
        errors.push('pairing_failure_mismatch');
      if (
        (step === 'fingerprint_check' ||
          step === 'code_entry' ||
          step === 'claiming' ||
          step === 'waiting_approval') &&
        pairing['fingerprint'] === null
      )
        errors.push('pairing_without_fingerprint');
      if (step === 'fetching_certificate' && pairing['fingerprint'] !== null)
        errors.push('fingerprint_before_certificate');
      // 確認コードは申請を受け付けた後の承認待ちのときだけ（B03-06）。
      if (pairing['claim_check'] !== null && step !== 'waiting_approval')
        errors.push('claim_check_outside_waiting');
    }
    // 中枢の画面の判定は接続している間だけ（B03-06）。
    if (value['hub_screen'] === true && value['link'] !== 'connected')
      errors.push('hub_screen_without_connection');
    const link = value['link'];
    const operations = value['operations'];
    if (
      link !== 'connected' &&
      Array.isArray(operations) &&
      operations.length > 0
    )
      errors.push('operations_without_connection');
    if (link === 'connected' && value['last_confirmed_at'] === null)
      errors.push('connected_without_confirmation');
    if ((link === 'waiting_retry') !== (value['retry_at'] !== null))
      errors.push('retry_at_mismatch');
    const registration = value['registration'];
    if (
      registration === 'reregistration_required'
        ? link !== 'reregistration_required'
        : registration === 'registered'
          ? link === 'reregistration_required'
          : link !== 'not_connected'
    )
      errors.push('link_conflicts_with_registration');
  }
  if (name === 'DesktopIpcResponse' && isRecord(value['connection']))
    errors.push(
      ...desktopSemanticErrors('DesktopConnectionView', value['connection']),
    );
  if (name === 'DesktopIpcResponse' && isRecord(value['status'])) {
    const status = value['status'];
    errors.push(...desktopSemanticErrors('DesktopStatusBar', status));
    const shown = status['visibility'] === 'shown';
    if (
      value['channel'] === 'desktop.io_stop' &&
      shown &&
      status['stop_scope'] === 'none'
    )
      errors.push('stop_not_reflected');
    if (
      value['channel'] === 'desktop.io_resume' &&
      (!shown || status['stop_scope'] !== 'none')
    )
      errors.push('resume_not_reflected');
  }
  if (name === 'DesktopIpcNotification') {
    if (isRecord(value['status']))
      errors.push(
        ...desktopSemanticErrors('DesktopStatusBar', value['status']),
      );
    if (isRecord(value['connection']))
      errors.push(
        ...desktopSemanticErrors('DesktopConnectionView', value['connection']),
      );
    if (
      value['source'] === 'os_query' &&
      value['event'] !== 'lock_screen' &&
      value['event'] !== 'unlock_screen'
    )
      errors.push('query_without_lock_state');
  }
  return errors;
}
