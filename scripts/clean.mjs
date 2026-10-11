import { rm } from 'node:fs/promises';
import { readWorkspaces } from './workspaces.mjs';

const root = new URL('../', import.meta.url);
for (const workspace of await readWorkspaces()) {
  await rm(new URL(`${workspace}/dist/`, root), {
    recursive: true,
    force: true,
  });
}
