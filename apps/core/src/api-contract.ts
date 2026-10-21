// HTTPS の要求の形式検査（ADR 0009・0020）。正本は packages/contracts の JSON Schema で、Ajv で検査する。
// schema の JSON は @buddy/contracts の公開出口（./schema.json）から読む。別ワークスペースの src は参照しない。
// 形式の検査は認可ではない。経路の検査（ROUTE_CHECKS）と状態遷移の判定は別に行う。

import { readFileSync } from 'node:fs';
import ajvModule from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

const Ajv2020 = ajvModule.default;
const addFormats = formatsModule.default;

export interface ApiContract {
  // 定義名（$defs の名前）の形式に合うか。未知の定義名は例外。
  valid(definition: string, value: unknown): boolean;
}

export function contractSchemaUrl(): URL {
  return new URL(import.meta.resolve('@buddy/contracts/schema.json'));
}

export function loadContractSchema(): unknown {
  return JSON.parse(readFileSync(contractSchemaUrl(), 'utf8'));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createApiContract(
  schema: unknown = loadContractSchema(),
): ApiContract {
  if (!isRecord(schema) || typeof schema['$id'] !== 'string')
    throw new Error('api_contract_schema_invalid');
  const id = schema['$id'];
  const ajv = new Ajv2020({
    strict: true,
    allErrors: false,
    validateFormats: true,
  });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validators = new Map<string, ValidateFunction>();
  return {
    valid(definition, value) {
      let validate = validators.get(definition);
      if (validate === undefined) {
        validate = ajv.getSchema(`${id}#/$defs/${definition}`);
        if (validate === undefined)
          throw new Error(`api_contract_missing:${definition}`);
        validators.set(definition, validate);
      }
      return validate(value) === true;
    },
  };
}
