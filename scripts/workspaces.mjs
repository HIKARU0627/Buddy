import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export async function readWorkspaces() {
  const config = parse(
    await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'),
  );
  const workspaces = config?.packages;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error('pnpm-workspace.yaml に packages を定義してください。');
  }
  for (const workspace of workspaces) {
    if (
      typeof workspace !== 'string' ||
      !/^(apps|packages)\/[a-z-]+$/u.test(workspace)
    ) {
      throw new Error(`Unexpected workspace path: ${workspace}`);
    }
  }
  return workspaces;
}
