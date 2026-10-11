import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const spec = JSON.parse(
  await readFile(
    new URL('../security/gitleaks-release.json', import.meta.url),
    'utf8',
  ),
);
const target = spec.assets[`${process.platform}-${process.arch}`];
if (!target) throw new Error('この OS / CPU の Gitleaks は未設定です。');
const directory = new URL('../.local/tools/gitleaks/', import.meta.url);
const executable = new URL(
  process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
  directory,
);
const installed = spawnSync(fileURLToPath(executable), ['version'], {
  encoding: 'utf8',
});
if (installed.status === 0 && installed.stdout.trim() === spec.version) {
  console.log(`Gitleaks ${spec.version} is installed.`);
} else {
  await mkdir(directory, { recursive: true });
  const response = await fetch(target.url);
  if (!response.ok)
    throw new Error(`Gitleaks download failed: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== target.sha256) {
    throw new Error('Gitleaks archive checksum mismatch');
  }
  const archive = new URL(
    target.url.endsWith('.zip') ? 'release.zip' : 'release.tar.gz',
    directory,
  );
  await writeFile(archive, data);
  // Windows 10/11 and the macOS/Linux development environments provide tar.
  const extraction = spawnSync(
    'tar',
    [
      '--no-same-owner',
      '-xf',
      fileURLToPath(archive),
      '-C',
      fileURLToPath(directory),
      process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
    ],
    { stdio: 'inherit' },
  );
  if (extraction.error || extraction.status !== 0)
    throw new Error('Gitleaks extraction failed; tar が必要です。');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  await rm(archive);
  const check = spawnSync(fileURLToPath(executable), ['version'], {
    encoding: 'utf8',
  });
  if (check.status !== 0 || check.stdout.trim() !== spec.version)
    throw new Error('Unexpected Gitleaks version');
  console.log(`Installed Gitleaks ${spec.version} (SHA-256 verified).`);
}
