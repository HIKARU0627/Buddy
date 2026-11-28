// 記録しない会話の独立した確認を画面に出して承認を受ける経路（ADR 0197、U503。ADR 0045・0192）。
//
// - 経路の検査（端末トークン・自宅のネットワーク・接続範囲・ロック解除・画面操作）は api-server.ts が先に行う（ROUTE_CHECKS。
//   通常の承認の経路と同じ。音声の「はい」・チャットでは承認しない）。ここは検査を通った要求の処理だけ。
// - 一覧は、認証した端末が頼んだ確認だけを、画面で承認に要る値（何をどう変えるか・対象のメールの表示用の値・内容版・内容の
//   hash・会話の内容は保存されないこと）だけで返す。区切りの ID・世代・操作の ID・発言・応答は返さない（U601）。
// - 承認する端末は本文の値ではなく、認証した要求の端末（U503 の条件）。確認を頼んだ端末だけが承認・断れる（U600）。
//   区切りの世代・操作の ID は Core が確認に結び付けて持つ値を使い、画面からは内容版と内容の hash だけを受けて照合する。
// - 再送（approvals に合わせる。U604）: 同じ接続範囲・request_id・同じ内容は控えた応答、内容が違えば 409。別の request_id の
//   二重の承認は、同じ端末・同じ内容なら最初の結果を返し、記録を書き直さない（保存境界の保持者の already_approved）。
// - 取り下げた・断った・記録しない会話を出た・入り直した・ロック・忘却で捨てた確認への承認は 409 で、記録も外部変更も作らない。
// - 口（PRIVATE_CONFIRMATION_SCREEN_OPEN）が閉じている間は、一覧は空、承認・断るは 409（確認そのものも作られない）。
// - 応答・ログに確認の中身（ラベル名・件名）を書かない。受付の控え・確認は RAM だけで、DB に書かない。

import type { JsonObject } from './strict-json.js';
import { apiErrorResponse } from './api-server.js';
import type { ApiHandlerRequest, ApiRouteHandler } from './api-server.js';
import { deviceCommandId, requestHash } from './api-operations.js';
import type {
  PrivateApprovalOutcome,
  PrivateConfirmationDesk,
} from './private-confirmations.js';

export interface PrivateConfirmationRoutesOptions {
  readonly desk: Pick<
    PrivateConfirmationDesk,
    'list' | 'owner' | 'approve' | 'decline' | 'receipt' | 'remember'
  >;
  // 確認の画面の口（製品は PRIVATE_CONFIRMATION_SCREEN_OPEN）。
  readonly open: () => boolean;
}

export interface PrivateConfirmationRoutes {
  readonly handlers: Readonly<Record<string, ApiRouteHandler>>;
}

const stringOf = (body: JsonObject | null, key: string): string => {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
};

type Result = 'recorded' | 'record_failed' | 'record_unknown' | 'declined';

const RESULT_OF: Readonly<
  Record<Exclude<PrivateApprovalOutcome['kind'], 'refused'>, Result>
> = {
  recorded: 'recorded',
  record_failed: 'record_failed',
  record_unknown: 'record_unknown',
};

export function createPrivateConfirmationRoutes(
  options: PrivateConfirmationRoutesOptions,
): PrivateConfirmationRoutes {
  const { desk } = options;

  const listPrivateConfirmations: ApiRouteHandler = (request) => {
    const device = request.device;
    if (device === null)
      return Promise.resolve(apiErrorResponse(401, 'unauthenticated'));
    const confirmations = options.open()
      ? desk
          .list()
          .filter((entry) => entry.device_id === device.device_id)
          .flatMap((entry) => {
            const operation = entry.view.operation;
            const action = operation.action;
            // 切り出すのはラベルの変更だけ（U502）。ほかの種類は画面に出さない（承認もできない）。
            if (action.kind !== 'mail.labels.change') return [];
            return [
              {
                confirmation_id: entry.confirmation_id,
                intent: 'label_mail',
                service: operation.provider,
                account_label: entry.display.account_label,
                target: entry.display.target,
                add: [...action.add],
                remove: [...action.remove],
                content_version: operation.content_version,
                content_hash: entry.view.content_hash,
                conversation_saved: false,
              },
            ];
          })
      : [];
    return Promise.resolve({ status: 200, body: { confirmations } });
  };

  // 受付の控え（同じ接続範囲・request_id）。同じ内容なら控えた応答、違えば 409。なければ null。
  const replay = (request: ApiHandlerRequest) => {
    const body = request.body as JsonObject;
    const requestId = stringOf(body, 'request_id');
    const confirmationId = request.params['confirmation_id'] ?? '';
    const key = deviceCommandId(stringOf(body, 'command_scope_id'), requestId);
    const hash = requestHash(request.route.operationId, confirmationId, body);
    const stored = desk.receipt(key);
    const response =
      stored === null
        ? null
        : stored.hash === hash
          ? { status: 202, body: structuredClone(stored.response) }
          : apiErrorResponse(409, 'conflict', requestId);
    return { key, hash, requestId, confirmationId, response };
  };

  const answer = (
    key: string,
    hash: string,
    requestId: string,
    confirmationId: string,
    result: Result,
  ) => {
    const body = {
      request_id: requestId,
      confirmation_id: confirmationId,
      result,
    };
    desk.remember(key, hash, body);
    return { status: 202, body };
  };

  const approvePrivateConfirmation: ApiRouteHandler = async (request) => {
    const device = request.device;
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const body = request.body as JsonObject;
    const { key, hash, requestId, confirmationId, response } = replay(request);
    if (!options.open()) return apiErrorResponse(409, 'conflict', requestId);
    if (response !== null) return response;
    const owner = desk.owner(confirmationId);
    // 知らない・捨てた・断った確認、他の端末が頼んだ確認、画面が見た内容と違う承認は 409（記録も外部変更も作らない）。
    if (
      owner === null ||
      owner.state === 'declined' ||
      owner.device_id !== device.device_id ||
      owner.content_version !== stringOf(body, 'content_version') ||
      owner.content_hash !== stringOf(body, 'content_hash')
    )
      return apiErrorResponse(409, 'conflict', requestId);
    const outcome = await desk.approve({
      confirmation_id: confirmationId,
      // 承認する端末は認証した要求の端末（本文では名乗れない。U503）。
      device_id: device.device_id,
      segment_generation: owner.segment_generation,
      operation_id: owner.operation_id,
      content_version: owner.content_version,
      content_hash: stringOf(body, 'content_hash'),
    });
    if (outcome.kind === 'refused')
      return apiErrorResponse(409, 'conflict', requestId);
    return answer(
      key,
      hash,
      requestId,
      confirmationId,
      RESULT_OF[outcome.kind],
    );
  };

  const declinePrivateConfirmation: ApiRouteHandler = async (request) => {
    const device = request.device;
    if (device === null) return apiErrorResponse(401, 'unauthenticated');
    const { key, hash, requestId, confirmationId, response } = replay(request);
    if (!options.open()) return apiErrorResponse(409, 'conflict', requestId);
    if (response !== null) return response;
    const owner = desk.owner(confirmationId);
    if (
      owner === null ||
      owner.state === 'approved' ||
      owner.device_id !== device.device_id
    )
      return apiErrorResponse(409, 'conflict', requestId);
    // 断った確認への再送（別の request_id）は、もう一度断ったことにする（何も作らない）。
    if (owner.state === 'declined')
      return answer(key, hash, requestId, confirmationId, 'declined');
    const declined = await desk.decline(confirmationId);
    if (!declined.ok) return apiErrorResponse(409, 'conflict', requestId);
    return answer(key, hash, requestId, confirmationId, 'declined');
  };

  return {
    handlers: {
      listPrivateConfirmations,
      approvePrivateConfirmation,
      declinePrivateConfirmation,
    },
  };
}
