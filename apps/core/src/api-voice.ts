// 音声の制御の経路（B05-03、ADR 0046）。経路の検査（domain の ROUTE_CHECKS）と形式の検査（JSON Schema）の後に呼ぶ。
// 中身の判定は VoiceControl（domain の規則を使う）が持ち、ここは要求の値を渡すだけ。

import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { apiErrorResponse } from './api-server.js';
import type { VoiceControl } from './voice-control.js';

export function createVoiceRoutes(voice: VoiceControl): {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
} {
  const authenticated =
    (
      run: (
        request: ApiHandlerRequest & {
          device: NonNullable<ApiHandlerRequest['device']>;
          body: NonNullable<ApiHandlerRequest['body']>;
        },
      ) => Promise<{ status: number; body: object }>,
    ): ApiRouteHandler =>
    async (request) => {
      if (request.device === null || request.body === null)
        return apiErrorResponse(401, 'unauthenticated');
      try {
        return await run({
          ...request,
          device: request.device,
          body: request.body,
        });
      } catch {
        return apiErrorResponse(503, 'dependency_unavailable');
      }
    };
  return {
    handlers: {
      renewLease: authenticated((request) =>
        voice.renewLease(
          request.device,
          request.body,
          request.declaredLockState,
        ),
      ),
      stopIo: authenticated((request) =>
        voice.stopIo(request.device, request.body),
      ),
      resumeIo: authenticated((request) =>
        voice.resumeIo(request.device, request.body, request.declaredLockState),
      ),
      createLiveSession: authenticated((request) =>
        voice.createLiveSession(request.device, request.body),
      ),
      closeLiveSession: authenticated((request) =>
        voice.closeLiveSession(
          request.device,
          request.params['live_session_id'] ?? '',
          request.body,
        ),
      ),
    },
  };
}
