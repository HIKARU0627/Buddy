-- 保存案 0008（B07-07 のレビューの反映、ADR 0042）。付帯クレジットの観測の採用と、予約のクレジットの結び付け。
-- 1. 採用した残高の観測（budget_credit_observations）。本人が書いたファイルの観測を、予約の判定とは別の transaction
--    （budget.credit_adopt）で先に採用して永続化する（判定を拒否しても、判定に使った新しい観測は残る）。採用した観測は書き換え
--    ず消さず（INSERT OR REPLACE でも置き換えない）、採用の順は連番（observation_seq）で決める。同じ周期で観測の時刻が前へ
--    戻る観測（rollback）・開始が古い周期の観測・同じ時刻で内容が違う観測（conflict）は拒否する。ファイルを古い状態へ戻しても、時計を戻しても、採用済みの観測から
--    判定する（一度確認した枯渇を取り消せない）。残高は観測の通貨のまま（予算の通貨への換算は設定の値で、読むときに行う）。
-- 2. 予約のクレジットの結び付け。受付で、周期（credit_cycle_id。0006 からある列）に加えて、受付の時点のクレジットの有効期限
--    （credit_expires_at）と採用した観測の番号（credit_observation_seq）を結び付け、受付から精算まで変えない（trigger）。
--    送出の直前と追加予約は、予約に結び付いた周期を採用済みの観測で確かめ直す。
-- 3. 受付の消費の見積もり（credit_estimate）と、精算した時点の採用の連番（credit_settled_seq）。精算の区分（credit_applied・
--    additional_spend）とは別に、台帳の残りから引く値を持つ。クレジットの対象の要求は、Buddy が割り当てた額に関わらず
--    min(実費, M) を持ち（ほかの予約が残りを占めていて割り当てが 0 でも、provider は消費したかもしれない）、精算した時点で採用済み
--    の最新の観測の連番を持つ。台帳は、その連番以前の観測を基準にしている間だけ見積もりを引く（壁時計の前後に依らない）。
--    精算した後は変えない。0006 までの精算済みの行は、確認済みの消費（credit_applied）を見積もりへ引き継ぐ（連番は空。
--    順序が分からないので、観測の時刻と精算の時刻で比べる）。
CREATE TABLE budget_credit_observations (
  observation_seq INTEGER PRIMARY KEY,
  cycle_id TEXT NOT NULL CHECK (length(cycle_id) BETWEEN 1 AND 128),
  -- 周期の開始（cycle_id の UTC の日付の 0 時）。古い周期の観測を拒否するために持つ。
  cycle_start INTEGER NOT NULL CHECK (cycle_start >= 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > cycle_start),
  status TEXT NOT NULL CHECK (status IN ('observed', 'unknown', 'expired')),
  shared INTEGER NOT NULL CHECK (shared IN (0, 1)),
  organization_ref TEXT NOT NULL CHECK (length(organization_ref) BETWEEN 1 AND 128),
  balance_currency TEXT CHECK (balance_currency IS NULL OR length(balance_currency) = 3),
  balance_amount INTEGER CHECK (balance_amount IS NULL OR (balance_amount >= 0 AND balance_amount <= 999999999999999999)),
  -- 観測の内容の SHA-256（小文字の 16 進）。同じ時刻の観測が同じ内容かを比べる。
  content_id TEXT NOT NULL CHECK (length(content_id) = 64),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  UNIQUE (cycle_id, observed_at),
  CHECK ((balance_currency IS NULL) = (balance_amount IS NULL)),
  CHECK (status <> 'observed' OR balance_amount IS NOT NULL)
) STRICT;

CREATE TRIGGER budget_credit_observations_no_update BEFORE UPDATE ON budget_credit_observations
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_observation_fixed');
END;
CREATE TRIGGER budget_credit_observations_no_delete BEFORE DELETE ON budget_credit_observations
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_observation_fixed');
END;
-- 採用済みの連番は置き換えない（INSERT OR REPLACE は削除の trigger を通らないので、挿入の前に止める）。
CREATE TRIGGER budget_credit_observations_no_replace BEFORE INSERT ON budget_credit_observations
  WHEN NEW.observation_seq IS NOT NULL AND EXISTS (SELECT 1 FROM budget_credit_observations WHERE observation_seq = NEW.observation_seq)
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_observation_fixed');
END;
-- 採用は前へだけ進む。周期の開始は採用済みの最大より古くならず、同じ周期の観測の時刻は採用済みより後でなければならない。
CREATE TRIGGER budget_credit_observations_cycle_forward BEFORE INSERT ON budget_credit_observations
  WHEN EXISTS (SELECT 1 FROM budget_credit_observations WHERE cycle_start > NEW.cycle_start)
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_cycle_regression');
END;
CREATE TRIGGER budget_credit_observations_time_forward BEFORE INSERT ON budget_credit_observations
  WHEN EXISTS (SELECT 1 FROM budget_credit_observations WHERE cycle_id = NEW.cycle_id AND observed_at >= NEW.observed_at)
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_observation_regression');
END;

ALTER TABLE budget_reservations ADD COLUMN credit_estimate INTEGER NOT NULL DEFAULT 0 CHECK (credit_estimate >= 0 AND credit_estimate <= 999999999999999999);
ALTER TABLE budget_reservations ADD COLUMN credit_expires_at INTEGER CHECK (credit_expires_at IS NULL OR credit_expires_at >= 0);
ALTER TABLE budget_reservations ADD COLUMN credit_observation_seq INTEGER CHECK (credit_observation_seq IS NULL OR credit_observation_seq >= 1);
ALTER TABLE budget_reservations ADD COLUMN credit_settled_seq INTEGER CHECK (credit_settled_seq IS NULL OR credit_settled_seq >= 0);
-- 0006 までの精算済みの行: 確認済みのクレジットの消費を、台帳から引く見積もりへ引き継ぐ（trigger を作る前に行う）。
UPDATE budget_reservations SET credit_estimate = credit_applied WHERE status = 'settled';

-- 周期・有効期限・採用した観測の結び付けは、受付で一度だけ書き、精算まで（精算した後も）変えない。
CREATE TRIGGER budget_reservations_credit_cycle_fixed BEFORE UPDATE OF credit_cycle_id ON budget_reservations
  WHEN OLD.status IN ('reserved', 'usage_unknown') AND NEW.credit_cycle_id IS NOT OLD.credit_cycle_id
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_binding_fixed');
END;
CREATE TRIGGER budget_reservations_credit_binding_fixed BEFORE UPDATE OF credit_expires_at, credit_observation_seq ON budget_reservations
  WHEN OLD.status <> 'released'
    AND (NEW.credit_expires_at IS NOT OLD.credit_expires_at OR NEW.credit_observation_seq IS NOT OLD.credit_observation_seq)
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_binding_fixed');
END;
-- 受付で結び付けるのは、周期・有効期限・観測の番号の 3 つがそろうときだけ（どれも空なら結び付けない）。見積もりは精算まで 0。
CREATE TRIGGER budget_reservations_credit_binding_insert BEFORE INSERT ON budget_reservations
  WHEN (NEW.credit_cycle_id IS NULL) <> (NEW.credit_expires_at IS NULL)
    OR (NEW.credit_cycle_id IS NULL) <> (NEW.credit_observation_seq IS NULL)
    OR NEW.credit_estimate <> 0
    OR NEW.credit_settled_seq IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_binding_invalid');
END;
-- 見積もりと精算した時点の連番は、精算した後に変えない。
CREATE TRIGGER budget_reservations_credit_estimate_fixed BEFORE UPDATE OF credit_estimate, credit_settled_seq ON budget_reservations
  WHEN OLD.status = 'settled'
    AND (NEW.credit_estimate <> OLD.credit_estimate OR NEW.credit_settled_seq IS NOT OLD.credit_settled_seq)
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_estimate_fixed');
END;
-- 精算の区分: クレジット・見積もりが正なら周期に結び付いていること、クレジットは見積もりを超えないこと
-- （クレジットを充てた分は必ず台帳から引かれる）。精算するまで見積もりは 0。
CREATE TRIGGER budget_reservations_credit_split_valid BEFORE UPDATE OF status, credit_applied, credit_estimate, credit_settled_seq ON budget_reservations
  WHEN (NEW.status = 'settled'
      AND (((NEW.credit_applied > 0 OR NEW.credit_estimate > 0) AND NEW.credit_cycle_id IS NULL)
        OR NEW.credit_applied > NEW.credit_estimate))
    OR (NEW.status <> 'settled' AND (NEW.credit_estimate <> 0 OR NEW.credit_settled_seq IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'budget_credit_split_invalid');
END;
