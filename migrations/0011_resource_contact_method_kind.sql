-- 0011 — Resource contact-method scheme discriminator.
--
-- Spec citations:
-- - SUAS-specs RESOURCES.md §2, §6 — `contact_method` is a public/operational
--   contact path, veteran-visible, and never credentials.
-- - SUAS-specs MVP_REFERENCE.md §8 — the resource surface should offer "direct
--   phone/email/web actions where allowed"; that needs the catalog to record
--   *what kind* of contact path a value is, not just the free text.
--
-- Implements accepted gap proposal P-13 (docs/SPEC_GAP_PROPOSALS.md,
-- docs/SPEC_DESIGN_GAPS.md G-I-17 / Slice 10 §10 item 2): before this, the
-- catalog stored `contact_method` as a single unstructured string, so a surface
-- could not know whether a value was a phone number, an email, or a URL. The
-- veteran resource list therefore rendered the value as plain text and offered
-- no direct action, rather than guess a scheme.
--
-- The discriminator is additive and nullable: an existing row (and any value an
-- admin deliberately leaves unstructured) stays NULL and keeps rendering as
-- text. A closed CHECK set keeps the vocabulary owned here rather than in a
-- renderer. FREEFORM is explicit for "recorded, but not an actionable scheme".

ALTER TABLE resources
    ADD COLUMN contact_method_kind text
        CONSTRAINT resources_contact_method_kind_check
        CHECK (contact_method_kind IN ('PHONE', 'EMAIL', 'URL', 'FREEFORM'));
