-- 保存案 0007（B07-04、ADR 0037）。予算の門の送出意図と、本人による予算月の確かめ直しの記録。
-- 1. 予約の送出意図（dispatch_intent_at）。Core は provider へ送る直前に、予約が reserved でまだ送出意図がないことを
--    確かめて記録する（08 §3 P01 の reservation_valid）。記録した予約は「送った可能性がある」ので解放しない
--    （ADR 0006 の未送信の解放）。再起動の照合は、送出意図のない reserved の予約だけを解放し、ある予約は usage 不明に
--    する（X28 の仕組み）。0006 から移した行には記録がないので NULL のまま（起点のない 0001 の行は Core が送った
--    可能性があるものとして扱う）。送出意図は一度だけ記録し、消さない。
-- 2. 予算月の確かめ直し（budget_month_confirmations）。予算月の記録（budget_months）は書き換えないので、確かめ直しは
--    別の行として足す。今の月の状態は、最も新しい月の行に、同じ月の最も新しい確かめ直しの始まりと時計の戻りの下限を
--    重ねたもの。
--    - start_reverified: 記録した始まりと tz データで求め直した値が食い違う（U23・invalid_calendar_state）とき、
--      本人が求め直した始まりを確かめた。
--    - clock_regression_accepted: 時計が今の月の始まりより前へ戻った（clock_regressed）とき、本人が今の月のまま
--      受け付けを続けることを確かめた。予算月は戻さず、戻った時計の時刻を下限にする（下限よりさらに戻れば再び保留）。
--    行は書き換えず消さない。
ALTER TABLE budget_reservations ADD COLUMN dispatch_intent_at INTEGER CHECK (dispatch_intent_at IS NULL OR dispatch_intent_at >= 0);

-- 送出意図は reserved の予約に一度だけ記録し、消さない・変えない。
CREATE TRIGGER budget_reservations_dispatch_once BEFORE UPDATE OF dispatch_intent_at ON budget_reservations
  WHEN NEW.dispatch_intent_at IS NOT OLD.dispatch_intent_at
    AND (OLD.dispatch_intent_at IS NOT NULL OR NEW.dispatch_intent_at IS NULL OR OLD.status <> 'reserved')
BEGIN
  SELECT RAISE(ABORT, 'budget_dispatch_intent_fixed');
END;

-- 送出意図を記録した予約は解放しない（送った可能性がある）。
CREATE TRIGGER budget_reservations_dispatched_not_released BEFORE UPDATE OF status ON budget_reservations
  WHEN NEW.status = 'released' AND OLD.dispatch_intent_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'budget_dispatched_not_releasable');
END;

CREATE TABLE budget_month_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  month TEXT NOT NULL REFERENCES budget_months (month),
  kind TEXT NOT NULL CHECK (kind IN ('start_reverified', 'clock_regression_accepted')),
  -- 確かめた時点の記録の始まり（budget_months.month_start、または前の確かめ直しの始まり）。
  previous_month_start INTEGER NOT NULL CHECK (previous_month_start >= 0),
  -- 確かめ直した後の今の月の始まり。
  month_start INTEGER NOT NULL CHECK (month_start >= 0),
  -- 時計の戻りを受け入れた下限（確かめた時点の時計）。start_reverified では NULL。
  regression_floor INTEGER CHECK (regression_floor IS NULL OR regression_floor >= 0),
  confirmed_at INTEGER NOT NULL,
  CHECK ((kind = 'clock_regression_accepted') = (regression_floor IS NOT NULL)),
  CHECK (kind = 'start_reverified' OR month_start = previous_month_start)
) STRICT;

CREATE TRIGGER budget_month_confirmations_no_update BEFORE UPDATE ON budget_month_confirmations
BEGIN
  SELECT RAISE(ABORT, 'budget_month_confirmation_fixed');
END;
CREATE TRIGGER budget_month_confirmations_no_delete BEFORE DELETE ON budget_month_confirmations
BEGIN
  SELECT RAISE(ABORT, 'budget_month_confirmation_fixed');
END;
-- 確かめ直しは今の月（最も新しい月の行）だけに足す。
CREATE TRIGGER budget_month_confirmations_current_month BEFORE INSERT ON budget_month_confirmations
  WHEN NEW.month <> (SELECT max(month) FROM budget_months)
BEGIN
  SELECT RAISE(ABORT, 'budget_month_confirmation_not_current');
END;
