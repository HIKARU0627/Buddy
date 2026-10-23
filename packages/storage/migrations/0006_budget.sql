-- 保存案 0006（B07-03、ADR 0036）。予算の受付・精算・超過の承認・予算月の状態（設計 05 F02・D15、09 QA42・X18、
-- ADR 0006・0034・0035）。金額は通貨単位の百万分の一（契約の Amount、18 桁まで）。時刻は UTC の Unix ミリ秒。
-- 1. 予約の表に profile_id・精算の時刻・手での精算の印・M 超過の確認の時刻を足し、状態の流れと固定の項目を trigger で守る。
--    0001 の CHECK は変えられないため、0005 の前例どおり同じ列と新しい列の表を作り直して値を移す。live_sessions が
--    参照しているので、参照する側も新しい表を指す形で作り直す。子の表を先に消してから親の表を消す。
--    0001 の行には profile が記録されていないので、profile_id は 'legacy:unrecorded'（実在の profile ではない印）にする。
--    精算の時刻・確認の時刻は 0001 の行には記録がないので NULL のまま移す（推測の値を入れない）。
--    手での精算の印（settlement_kind）は 0001 の行の照合 ID の manual: から求める。
-- 2. 超過枠の個別の承認（1 つの request_id と M に固定。1 回だけ使える）。
-- 3. 予算月の状態（月・その月のタイムゾーン・月の始まり・始まりを決めたタイムゾーン）。月ごとに 1 行を足していく。
CREATE TABLE budget_reservations_0006 (
  reservation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  pool_id TEXT NOT NULL,
  budget_month TEXT NOT NULL CHECK (budget_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  price_version TEXT NOT NULL,
  reserved_amount INTEGER NOT NULL CHECK (reserved_amount >= 0),
  max_liability INTEGER NOT NULL CHECK (max_liability >= reserved_amount AND max_liability <= 999999999999999999),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'usage_unknown', 'settled', 'released')),
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision >= 1),
  approval_id TEXT,
  actual_gross INTEGER CHECK (actual_gross >= 0 AND actual_gross <= 999999999999999999),
  credit_applied INTEGER CHECK (credit_applied >= 0),
  additional_spend INTEGER CHECK (additional_spend >= 0),
  provider_reconciliation_id TEXT UNIQUE,
  -- 精算の種類。provider の usage による精算（照合 ID は provider の名前を前に付ける）か、本人の手での精算（manual:）。
  settlement_kind TEXT CHECK (settlement_kind IN ('provider', 'manual')),
  credit_cycle_id TEXT,
  settled_at INTEGER,
  overrun_reviewed INTEGER NOT NULL DEFAULT 0 CHECK (overrun_reviewed IN (0, 1)),
  overrun_reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  -- 0001 と同じ CHECK。
  CHECK ((status = 'settled') = (actual_gross IS NOT NULL AND credit_applied IS NOT NULL AND additional_spend IS NOT NULL AND provider_reconciliation_id IS NOT NULL)),
  CHECK (status <> 'settled' OR actual_gross = credit_applied + additional_spend),
  CHECK (status = 'settled' OR (actual_gross IS NULL AND credit_applied IS NULL AND additional_spend IS NULL)),
  CHECK (status <> 'released' OR provider_reconciliation_id IS NULL),
  CHECK (overrun_reviewed = 0 OR status = 'settled'),
  -- 精算した行だけが精算の種類を持ち、手での精算と照合 ID の manual: は一致する。
  CHECK ((status = 'settled') = (settlement_kind IS NOT NULL)),
  CHECK (settlement_kind IS NULL OR (settlement_kind = 'manual') = (provider_reconciliation_id GLOB 'manual:*')),
  CHECK (settled_at IS NULL OR status = 'settled'),
  CHECK (overrun_reviewed_at IS NULL OR overrun_reviewed = 1)
) STRICT;

INSERT INTO budget_reservations_0006 (reservation_id, request_id, profile_id, pool_id, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id, settlement_kind, credit_cycle_id, settled_at, overrun_reviewed, overrun_reviewed_at, created_at)
  SELECT reservation_id, request_id, 'legacy:unrecorded', pool_id, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, approval_id, actual_gross, credit_applied, additional_spend, provider_reconciliation_id,
    CASE WHEN status = 'settled' THEN (CASE WHEN provider_reconciliation_id GLOB 'manual:*' THEN 'manual' ELSE 'provider' END) END,
    credit_cycle_id, NULL, overrun_reviewed, NULL, created_at
  FROM budget_reservations;

-- 0001 と同じ列・制約。参照先は新しい予約の表（改名の後は budget_reservations を指す）。
CREATE TABLE live_sessions_0006 (
  live_session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (device_id),
  session_id TEXT REFERENCES sessions (session_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('conversation', 'notification')),
  control_state TEXT NOT NULL CHECK (control_state IN ('connecting', 'ready', 'lost', 'closing', 'closed')),
  control_epoch INTEGER NOT NULL CHECK (control_epoch >= 0),
  closure TEXT NOT NULL CHECK (closure IN ('open', 'close_requested', 'close_confirmed', 'close_unconfirmed')),
  usage_seconds INTEGER CHECK (usage_seconds >= 0),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservations_0006 (reservation_id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  CHECK (closure <> 'close_confirmed' OR usage_seconds IS NOT NULL)
) STRICT;

INSERT INTO live_sessions_0006 (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, ended_at, end_reason)
  SELECT live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, ended_at, end_reason FROM live_sessions;

DROP TABLE live_sessions;
DROP TABLE budget_reservations;

ALTER TABLE budget_reservations_0006 RENAME TO budget_reservations;
ALTER TABLE live_sessions_0006 RENAME TO live_sessions;

-- 0001 と同じ索引（表の作り直しで消えるため作り直す）。
CREATE INDEX budget_reservations_open ON budget_reservations (pool_id, budget_month)
  WHERE status IN ('reserved', 'usage_unknown');
-- 受付の検査で同じ月の行を読む。
CREATE INDEX budget_reservations_month ON budget_reservations (budget_month);
-- 1 つの超過の承認で受け付ける予約は 1 つ（承認を 1 回だけ使う最終の保証）。
CREATE UNIQUE INDEX budget_reservations_one_per_approval ON budget_reservations (approval_id)
  WHERE approval_id IS NOT NULL;

-- 予約の trigger。解放した行は released_final だけ、精算した行の精算の項目と状態は settlement_fixed だけが拒否する
-- （一つの変更に一つの理由が出るよう、条件を重ねない）。
-- 予算月と枠は精算でも変えない（ADR 0006。0001 と同じ名前と理由）。
CREATE TRIGGER budget_reservations_fixed_month BEFORE UPDATE OF budget_month, pool_id ON budget_reservations
  WHEN OLD.status <> 'released' AND (NEW.budget_month <> OLD.budget_month OR NEW.pool_id <> OLD.pool_id)
BEGIN
  SELECT RAISE(ABORT, 'budget_month_fixed');
END;

-- 受付時に固定する項目（ADR 0034・0035）。
CREATE TRIGGER budget_reservations_fixed_fields BEFORE UPDATE OF reservation_id, request_id, profile_id, price_version, currency, approval_id, created_at ON budget_reservations
  WHEN OLD.status <> 'released'
    AND (NEW.reservation_id <> OLD.reservation_id OR NEW.request_id <> OLD.request_id OR NEW.profile_id <> OLD.profile_id
      OR NEW.price_version <> OLD.price_version OR NEW.currency <> OLD.currency
      OR NEW.approval_id IS NOT OLD.approval_id OR NEW.created_at <> OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'budget_reservation_fixed');
END;

-- 状態の流れ: reserved → usage_unknown・settled・released、usage_unknown → settled。usage 不明は解放しない（送った可能性がある）。
-- 精算した行・解放した行の状態は下の trigger が守る。
CREATE TRIGGER budget_reservations_status_flow BEFORE UPDATE OF status ON budget_reservations
  WHEN OLD.status IN ('reserved', 'usage_unknown') AND NEW.status <> OLD.status
    AND NOT ((OLD.status = 'reserved' AND NEW.status IN ('usage_unknown', 'settled', 'released'))
      OR (OLD.status = 'usage_unknown' AND NEW.status = 'settled'))
BEGIN
  SELECT RAISE(ABORT, 'budget_status_transition');
END;

-- 解放した予約は変えない（解放済みの予約へ精算しない）。
CREATE TRIGGER budget_reservations_released_final BEFORE UPDATE ON budget_reservations
  WHEN OLD.status = 'released'
BEGIN
  SELECT RAISE(ABORT, 'budget_reservation_released');
END;

-- 精算は一度だけ。精算した状態・金額・照合 ID・種類・時刻は変えない（M 超過の確認だけを後から記録する）。
CREATE TRIGGER budget_reservations_settlement_fixed BEFORE UPDATE ON budget_reservations
  WHEN OLD.status = 'settled'
    AND (NEW.status <> OLD.status OR NEW.actual_gross IS NOT OLD.actual_gross OR NEW.credit_applied IS NOT OLD.credit_applied
      OR NEW.additional_spend IS NOT OLD.additional_spend OR NEW.provider_reconciliation_id IS NOT OLD.provider_reconciliation_id
      OR NEW.settlement_kind IS NOT OLD.settlement_kind OR NEW.credit_cycle_id IS NOT OLD.credit_cycle_id
      OR NEW.settled_at IS NOT OLD.settled_at)
BEGIN
  SELECT RAISE(ABORT, 'budget_settlement_fixed');
END;

-- M 超過の確認は取り消さない。確認の時刻も変えない。
CREATE TRIGGER budget_reservations_review_fixed BEFORE UPDATE OF overrun_reviewed, overrun_reviewed_at ON budget_reservations
  WHEN OLD.status <> 'released'
    AND ((OLD.overrun_reviewed = 1 AND NEW.overrun_reviewed = 0)
      OR (OLD.overrun_reviewed_at IS NOT NULL AND NEW.overrun_reviewed_at IS NOT OLD.overrun_reviewed_at))
BEGIN
  SELECT RAISE(ABORT, 'budget_overrun_review_fixed');
END;

-- 版は追加予約でだけ 1 つずつ上げる（reserved のまま）。R と M は追加予約（版を 1 つ上げる）で増やすだけで、
-- 減らさない（ADR 0006）。精算した行・usage 不明の行の版は上げられないので、R と M も変えられない。
CREATE TRIGGER budget_reservations_revision_step BEFORE UPDATE OF reservation_revision ON budget_reservations
  WHEN OLD.status <> 'released' AND NEW.reservation_revision <> OLD.reservation_revision
    AND (NEW.reservation_revision <> OLD.reservation_revision + 1 OR OLD.status <> 'reserved' OR NEW.status <> 'reserved')
BEGIN
  SELECT RAISE(ABORT, 'budget_revision_invalid');
END;
CREATE TRIGGER budget_reservations_top_up_only BEFORE UPDATE OF reserved_amount, max_liability ON budget_reservations
  WHEN OLD.status <> 'released' AND NEW.reservation_revision = OLD.reservation_revision
    AND (NEW.reserved_amount <> OLD.reserved_amount OR NEW.max_liability <> OLD.max_liability)
BEGIN
  SELECT RAISE(ABORT, 'budget_top_up_invalid');
END;
CREATE TRIGGER budget_reservations_no_decrease BEFORE UPDATE OF reserved_amount, max_liability ON budget_reservations
  WHEN OLD.status <> 'released' AND NEW.reservation_revision = OLD.reservation_revision + 1
    AND (NEW.reserved_amount < OLD.reserved_amount OR NEW.max_liability < OLD.max_liability)
BEGIN
  SELECT RAISE(ABORT, 'budget_amount_decrease');
END;

-- 超過枠の個別の承認（本人の判断 2026-10-23、ADR 0034）。1 つの request_id（予算の要求）と M・枠・予算月に固定し、
-- 承認は 1 回だけ使う（consumed）。同じ request_id の生きている承認（pending・approved・consumed）は 1 つ。
CREATE TABLE budget_overage_approvals (
  approval_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  budget_month TEXT NOT NULL CHECK (budget_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  max_liability INTEGER NOT NULL CHECK (max_liability >= 0 AND max_liability <= 999999999999999999),
  overage_remaining INTEGER NOT NULL CHECK (overage_remaining >= 0 AND overage_remaining <= 999999999999999999),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > requested_at),
  decided_at INTEGER,
  consumed_at INTEGER,
  consumed_reservation_id TEXT UNIQUE REFERENCES budget_reservations (reservation_id),
  -- 承認・拒否・使用済みは決めた時刻を持ち、決めた時刻は承認を求めた後・期限の前（ADR 0035 の照合と同じ）。
  CHECK (status NOT IN ('approved', 'rejected', 'consumed') OR decided_at IS NOT NULL),
  CHECK (status <> 'pending' OR decided_at IS NULL),
  CHECK (decided_at IS NULL OR (decided_at >= requested_at AND decided_at < expires_at)),
  -- 使用済みは使った時刻と予約を持ち、使ったのは決めた後・期限の前。
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL AND consumed_reservation_id IS NOT NULL)),
  CHECK (consumed_at IS NULL OR (consumed_at >= decided_at AND consumed_at < expires_at))
) STRICT;
CREATE UNIQUE INDEX budget_overage_approvals_one_live ON budget_overage_approvals (request_id)
  WHERE status IN ('pending', 'approved', 'consumed');

-- 承認の request_id・M・枠・予算月・期限は変えない（期限を延ばさない）。
CREATE TRIGGER budget_overage_approvals_fixed BEFORE UPDATE OF approval_id, request_id, pool_id, budget_month, currency, max_liability, overage_remaining, requested_at, expires_at ON budget_overage_approvals
  WHEN NEW.approval_id <> OLD.approval_id OR NEW.request_id <> OLD.request_id OR NEW.pool_id <> OLD.pool_id
    OR NEW.budget_month <> OLD.budget_month OR NEW.currency <> OLD.currency OR NEW.max_liability <> OLD.max_liability
    OR NEW.overage_remaining <> OLD.overage_remaining OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'budget_approval_fixed');
END;

-- 状態の流れ: pending → approved・rejected・expired、approved → consumed・expired。拒否・期限切れ・使用済みは終わり。
-- 決めた時刻は一度だけ記録し、使った時刻と予約は使ったときだけ記録する。
CREATE TRIGGER budget_overage_approvals_status_flow BEFORE UPDATE OF status, decided_at, consumed_at, consumed_reservation_id ON budget_overage_approvals
  WHEN NOT ((NEW.status = OLD.status AND NEW.decided_at IS OLD.decided_at AND NEW.consumed_at IS OLD.consumed_at
        AND NEW.consumed_reservation_id IS OLD.consumed_reservation_id)
      OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') AND NEW.consumed_at IS NULL)
      OR (OLD.status = 'pending' AND NEW.status = 'expired' AND NEW.decided_at IS NULL AND NEW.consumed_at IS NULL)
      OR (OLD.status = 'approved' AND NEW.status = 'consumed' AND NEW.decided_at IS OLD.decided_at)
      OR (OLD.status = 'approved' AND NEW.status = 'expired' AND NEW.decided_at IS OLD.decided_at AND NEW.consumed_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'budget_approval_transition');
END;

-- 使用済みにするのは、その承認の ID・request_id・M・枠・予算月で受け付けた予約だけ。
CREATE TRIGGER budget_overage_approvals_consume_match BEFORE UPDATE OF status ON budget_overage_approvals
  WHEN NEW.status = 'consumed' AND NOT EXISTS (
    SELECT 1 FROM budget_reservations
     WHERE reservation_id = NEW.consumed_reservation_id AND approval_id = NEW.approval_id AND request_id = NEW.request_id
       AND max_liability = NEW.max_liability AND pool_id = NEW.pool_id AND budget_month = NEW.budget_month
       AND currency = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'budget_approval_mismatch');
END;

-- 予算月の状態（ADR 0035 の BudgetCalendarState の 4 項目）。月ごとに 1 行を足し、今の状態は最も新しい月の行。
-- 行は書き換えず消さない（どの月にどのタイムゾーンを使ったかの記録）。月と始まりは前へ戻らない。
CREATE TABLE budget_months (
  month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  month_start INTEGER NOT NULL CHECK (month_start >= 0),
  month_start_time_zone TEXT NOT NULL CHECK (length(month_start_time_zone) BETWEEN 1 AND 64),
  recorded_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER budget_months_no_update BEFORE UPDATE ON budget_months
BEGIN
  SELECT RAISE(ABORT, 'budget_month_record_fixed');
END;
CREATE TRIGGER budget_months_no_delete BEFORE DELETE ON budget_months
BEGIN
  SELECT RAISE(ABORT, 'budget_month_record_fixed');
END;
CREATE TRIGGER budget_months_forward BEFORE INSERT ON budget_months
  WHEN EXISTS (SELECT 1 FROM budget_months WHERE month >= NEW.month OR month_start >= NEW.month_start)
BEGIN
  SELECT RAISE(ABORT, 'budget_month_regression');
END;
