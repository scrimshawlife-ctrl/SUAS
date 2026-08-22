-- 0010 — Notification subject reference.
--
-- Spec citations:
-- - SUAS-specs DATA_MODEL.md §9 (notifications) — a logical send should be able
--   to reference the workflow entity it was sent for.
-- - SUAS-specs MVP_REFERENCE.md §7.2 — RESPONDER_NOTIFIED is permitted only when
--   the system can see a delivery linked to the request; without a linkage the
--   surface must stay on SEARCHING.
--
-- Implements accepted gap proposal P-12 (docs/SPEC_GAP_PROPOSALS.md,
-- docs/SPEC_DESIGN_GAPS.md G-I-16 / Slice 10 §10 item 1): before this, a
-- delivery could not be joined back to a Support Case / Service Request /
-- Referral, so RESPONDER_NOTIFIED was unreachable. The reference is additive and
-- nullable; existing sends and dedupe behavior are unchanged.

ALTER TABLE notifications
    ADD COLUMN subject_type text,
    ADD COLUMN subject_id   uuid;

-- Look up the sends made for one workflow entity (e.g. a Service Request).
CREATE INDEX notifications_subject_idx
    ON notifications (tenant_id, subject_type, subject_id)
    WHERE subject_type IS NOT NULL;
