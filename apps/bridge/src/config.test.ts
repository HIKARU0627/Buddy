// 設定の読み書きと、Muse 向けトークンの照合の試験。期待値は手で書く。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bridgeTokenHash,
  bridgeTokenMatches,
  emptyConfig,
  loadConfig,
  saveConfig,
} from './config.js';
import type { BridgeConfig } from './config.js';

const TOKEN = 'bridge-token-for-tests-00000000000000000001';

test('save and load round-trip, with the file mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-bridge-config-'));
  const path = join(dir, 'nested', 'config.json');
  const config: BridgeConfig = {
    ...emptyConfig(),
    hub: { host: '127.0.0.1', port: 47443 },
    hubCertificatePem:
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    hubFingerprint: 'ab12',
    deviceId: 'd-1',
    deviceToken: 'x'.repeat(43),
    bridgeTokenHash: bridgeTokenHash(TOKEN),
    listen: { host: '100.64.0.2', port: 47444 },
  };
  await saveConfig(path, config);
  assert.deepEqual(await loadConfig(path), config);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the saved file holds the bridge token hash, never the token itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-bridge-config-'));
  const path = join(dir, 'config.json');
  const config: BridgeConfig = {
    ...emptyConfig(),
    bridgeTokenHash: bridgeTokenHash(TOKEN),
  };
  await saveConfig(path, config);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes(bridgeTokenHash(TOKEN)), true);
});

test('bridgeTokenMatches accepts only the registered token', () => {
  const config: BridgeConfig = {
    ...emptyConfig(),
    bridgeTokenHash: bridgeTokenHash(TOKEN),
  };
  assert.equal(bridgeTokenMatches(config, TOKEN), true);
  assert.equal(bridgeTokenMatches(config, 'wrong-token'), false);
  assert.equal(bridgeTokenMatches(config, null), false);
  assert.equal(bridgeTokenMatches(emptyConfig(), TOKEN), false);
});

test('loadConfig returns null for a missing or broken file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buddy-bridge-config-'));
  assert.equal(await loadConfig(join(dir, 'absent.json')), null);
  const broken = join(dir, 'broken.json');
  await saveConfig(broken, emptyConfig());
  const { writeFile } = await import('node:fs/promises');
  await writeFile(broken, '{not json', 'utf8');
  assert.equal(await loadConfig(broken), null);
});
