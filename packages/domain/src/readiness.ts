import { INTENT_POLICIES, type IntentName } from './intents.js';

export type InputState =
  'collecting' | 'end_candidate' | 'sealed' | 'superseded' | 'blocked';

export type InputEvidence =
  | 'submitted_text'
  | 'full_audio_segment'
  | 'live_policy_observed'
  | 'unverified';

// Core が別の検査で確定した事実。モデル・端末の申告をそのまま入れない。
export interface ReadinessChecks {
  // 新しい本人の発話開始による一時保留（設計 10 §5A-3）。
  readonly utteranceHold: boolean;
  readonly targetResolved: boolean;
  readonly evidenceVerified: boolean;
  readonly permissionCurrent: boolean;
  readonly policyCurrent: boolean;
  readonly safetyStopped: boolean;
  // 方針表がこの操作の自動実行を許すか（J09〜J11、自分だけの予定など）。
  readonly autoPolicyAllows: boolean;
}

export type ReadinessState = 'blocked' | 'needs_approval' | 'auto_eligible';

export interface Readiness {
  readonly route: 'local_command' | 'remote_mutation';
  readonly state: ReadinessState;
  readonly reasonCodes: readonly string[];
}

// 変更を伴う意図の実行可否（設計 10 §5A F01・§6A D15、08 §3・§9）。
// sealed だけでは許可しない。方式 C は needs_approval へ昇格させず全文確定へ戻す。
// auto_eligible は 08 の最終検査へ進む資格であり、送出の許可ではない。
export function assessReadiness(
  input: { readonly state: InputState; readonly inputEvidence: InputEvidence },
  intent: IntentName,
  checks: ReadinessChecks,
): Readiness {
  const policy = INTENT_POLICIES[intent];
  if (policy.route === 'read')
    throw new TypeError(`${intent} is a read intent without ActionReadiness`);
  const route = policy.route;
  const reasons: string[] = [];
  if (input.state !== 'sealed') reasons.push('input_not_sealed');
  if (input.inputEvidence === 'unverified') reasons.push('input_unverified');
  if (checks.utteranceHold) reasons.push('utterance_hold');
  if (!checks.targetResolved) reasons.push('target_unresolved');
  if (!checks.evidenceVerified) reasons.push('evidence_unverified');
  if (!checks.permissionCurrent) reasons.push('permission_changed');
  if (!checks.policyCurrent) reasons.push('policy_changed');
  if (reasons.length) return { route, state: 'blocked', reasonCodes: reasons };

  const needsScreen =
    policy.approval === 'screen' ||
    (policy.approval === 'policy' && !checks.autoPolicyAllows);
  if (
    input.inputEvidence === 'live_policy_observed' &&
    (!policy.liveTranscript || needsScreen)
  )
    return { route, state: 'blocked', reasonCodes: ['requires_full_text'] };
  if (needsScreen) return { route, state: 'needs_approval', reasonCodes: [] };
  if (policy.approval === 'policy' && checks.safetyStopped)
    return { route, state: 'blocked', reasonCodes: ['safety_stopped'] };
  return { route, state: 'auto_eligible', reasonCodes: [] };
}
