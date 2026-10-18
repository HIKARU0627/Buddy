import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import prettier from 'prettier';
import { root, schemaUrl, parseStrictJson } from './contract-tools.mjs';

const schema = parseStrictJson(await readFile(schemaUrl, 'utf8'));
const raw = await compile(schema, 'BuddyContract', {
  bannerComment:
    '// Generated from buddy.schema.json. Do not edit; run contracts:generate.',
  additionalProperties: false,
  unreachableDefinitions: true,
  enableConstEnums: false,
  $refOptions: { resolve: { http: false } },
});
const target = new URL('packages/contracts/src/generated.ts', root);
const config = await prettier.resolveConfig(
  fileURLToPath(new URL('prettier.config.mjs', root)),
);
const output = await prettier.format(raw, { ...config, parser: 'typescript' });
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== output)
    throw new Error('Generated types are stale. Run contracts:generate.');
  console.log('Generated contract types match JSON Schema.');
} else {
  await writeFile(target, output);
  console.log('Generated contract types.');
}
