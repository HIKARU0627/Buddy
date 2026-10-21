// ローカル制御チャネルの送受信（ADR 0012）。node:net の Unix domain socket / 名前付きパイプ。
// 接続できるのは同じマシンの、OS の権限で許された利用者だけ。HTTP・TLS・認証は B03 で決める。
// 応答は同期でも Promise でも作れる（最初の端末の命令は DB を引く。ADR 0021）。

import { randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import {
  MAX_CONTROL_LINE_BYTES,
  encodeControlMessage,
  parseControlRequest,
} from './control-protocol.js';
import type {
  ControlOp,
  ControlRequest,
  ControlResponse,
} from './control-protocol.js';
import { isJsonObject, parseStrictJson } from './strict-json.js';
import type { JsonObject } from './strict-json.js';

// 要求を送らないまま居座る接続を切るまでの時間。
const IDLE_TIMEOUT_MS = 2000;
const MAX_CONNECTIONS = 16;

export interface ControlServerOptions {
  readonly endpoint: string;
  // 正しい要求への応答を作る。応答を書き終えたあとに afterWrite を呼ぶ。
  readonly handle: (
    request: ControlRequest,
  ) => ControlHandled | Promise<ControlHandled>;
}

export interface ControlHandled {
  readonly response: ControlResponse;
  readonly afterWrite?: () => void;
}

export interface ControlServer {
  readonly server: Server;
  // 新しい接続の受付をやめ、残りの接続を待ってから閉じる。
  close(graceMs: number): Promise<void>;
}

export function listenControlServer(
  options: ControlServerOptions,
): Promise<ControlServer> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, options.handle);
  });
  server.maxConnections = MAX_CONNECTIONS;
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    // readableAll / writableAll は付けない（Unix socket は所有者だけ、パイプは既定の権限）。
    server.listen({ path: options.endpoint, exclusive: true }, () => {
      server.off('error', onError);
      resolve({
        server,
        close: (graceMs) =>
          new Promise<void>((done) => {
            const timer = setTimeout(() => {
              for (const socket of sockets) socket.destroy();
            }, graceMs);
            timer.unref();
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          }),
      });
    });
  });
}

function serveConnection(
  socket: Socket,
  handle: ControlServerOptions['handle'],
): void {
  let buffered = Buffer.alloc(0);
  let done = false;
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  const finish = (message: ControlResponse, afterWrite?: () => void) => {
    done = true;
    socket.removeAllListeners('data');
    socket.end(encodeControlMessage(message), () => afterWrite?.());
  };
  socket.on('data', (chunk: Buffer) => {
    if (done) return;
    buffered = Buffer.concat([buffered, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline === -1) {
      if (buffered.byteLength > MAX_CONTROL_LINE_BYTES)
        finish({ ok: false, error: 'invalid_request', reason: 'too_large' });
      return;
    }
    const parsed = parseControlRequest(buffered.subarray(0, newline));
    if (!parsed.ok) {
      finish({ ok: false, error: 'invalid_request', reason: parsed.reason });
      return;
    }
    // 1 接続 1 要求。改行より後ろのデータは読まずに閉じる。
    done = true;
    socket.removeAllListeners('data');
    let handled: ControlHandled | Promise<ControlHandled>;
    try {
      handled = handle(parsed.request);
    } catch {
      finish({ ok: false, error: 'unavailable' });
      return;
    }
    if (!(handled instanceof Promise)) {
      finish(handled.response, handled.afterWrite);
      return;
    }
    handled.then(
      ({ response, afterWrite }) => {
        if (!socket.destroyed) finish(response, afterWrite);
      },
      () => {
        if (!socket.destroyed) finish({ ok: false, error: 'unavailable' });
      },
    );
  });
}

export type ControlCallResult =
  | { readonly kind: 'response'; readonly body: JsonObject }
  // 接続先がない（ソケット・パイプが存在しない、または誰も受け付けていない）。
  | { readonly kind: 'absent' }
  // 接続したが時間内に応答がない、または応答が読めない。
  | { readonly kind: 'no_response' };

// 制御チャネルへ 1 要求を送る。CLI の status / stop と、起動時の二重起動の確認で使う。
export function callControl(
  endpoint: string,
  op: ControlOp,
  timeoutMs: number,
  // 命令ごとの追加の項目（pairing_first_approve の pairing_id）。
  fields: Readonly<Record<string, string>> = {},
): Promise<ControlCallResult> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = Buffer.alloc(0);
    const socket = connect({ path: endpoint });
    const settle = (result: ControlCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ kind: 'no_response' }), timeoutMs);
    socket.on('connect', () => {
      socket.write(
        encodeControlMessage({ ...fields, op, request_id: randomUUID() }),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > 64 * 1024) settle({ kind: 'no_response' });
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      try {
        const body = parseStrictJson(
          buffered.subarray(0, newline).toString('utf8'),
        );
        settle(
          isJsonObject(body)
            ? { kind: 'response', body }
            : { kind: 'no_response' },
        );
      } catch {
        settle({ kind: 'no_response' });
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const absent = ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '');
      settle(absent ? { kind: 'absent' } : { kind: 'no_response' });
    });
    socket.on('close', () => settle({ kind: 'no_response' }));
  });
}
