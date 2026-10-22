// 試験の道具。後片付けは「閉じてから削除」の順にする（Windows では開いたままのファイルを消せない）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type test from 'node:test';
import { FaultInjector } from './fault-injector.js';
import { createMockProvider, type MockProvider } from './provider/server.js';

export const TEST_TIMEOUT_MS = 20_000;

const cleanups = new WeakMap<object, (() => unknown)[]>();

export function onCleanup(t: test.TestContext, cleanup: () => unknown): void {
  let stack = cleanups.get(t);
  if (stack === undefined) {
    const created: (() => unknown)[] = [];
    stack = created;
    cleanups.set(t, created);
    t.after(async () => {
      // 後から登録したもの（サーバー）を先に閉じ、最後に最初に登録したディレクトリを消す。
      for (const run of created.reverse()) {
        try {
          await run();
        } catch {
          // 後始末の失敗で他の後始末を止めない。
        }
      }
    });
  }
  stack.push(cleanup);
}

export async function tempDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-connectors-'));
  onCleanup(t, () =>
    rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  );
  return base;
}

export async function startProvider(
  t: test.TestContext,
  options: {
    readonly dir?: string;
    readonly injector?: FaultInjector;
    readonly now?: () => string;
  } = {},
): Promise<MockProvider & { readonly dir: string }> {
  const dir = options.dir ?? (await tempDir(t));
  const provider = await createMockProvider({
    dir,
    injector: options.injector ?? new FaultInjector(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  onCleanup(t, () => provider.close());
  return Object.assign(provider, { dir });
}

/** 待ちが終わらないときに、名前つきの失敗にする。 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
