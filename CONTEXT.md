# CONTEXT.md — SUAS implementation context

Read this before implementation work.

## What SUAS is

Shut Up and Serve is a consent-governed veteran support coordination platform.

Mission: coordinate the shortest safe and consented path between a veteran's current need and an available human or material support resource.

Canonical loop:

`SIGNAL → NEED → CONSENT → COORDINATION → FULFILLMENT → FOLLOW-UP → SETTLEMENT`

MVP categories:

- `FOOD`
- `TRANSPORTATION`
- `SHELTER` — temporary shelter/accommodation, not permanent housing
- `PEER_SUPPORT`

## What SUAS is not

- EHR
- diagnosis system
- suicide-prediction product
- automated emergency-dispatch system
- clinical efficacy measurement product
- production billing/Medi-Cal system

## Canonical repositories

- Specs: `scrimshawlife-ctrl/SUAS-specs`
- Implementation: `scrimshawlife-ctrl/SUAS`

Specs are authority. Implementation gaps return to specs.

## Released implementation contract

- spec version: `0.1.5`
- implementation authority: `RELEASED_FOR_IMPLEMENTATION`
- current implementation stage: `SPEC-017`
- production/pilot readiness: `NOT_READY`

Use `FABLE_HANDOFF.md`, `AGENTS.md`, and `SPEC017_PLAN.md` in this repo, then the released `HANDOFF.md` and `ENVIRONMENT.md` in `SUAS-specs`.

## Architecture

Default architecture is a scalable modular monolith with:

- stateless application instances;
- PostgreSQL logical system of record;
- durable async-work abstraction;
- persistent command idempotency;
- replay-safe Domain Events;
- provider-neutral capability ports;
- Manual/Fake adapters before real provider adapters;
- strict tenant isolation;
- bounded/paginated growing APIs.

## Core domain distinctions

Do not alias:

- Check-In ≠ Support Signal
- Support Case ≠ Service Request
- Referral ≠ Service Request
- Assignment ≠ Fulfillment
- Fulfillment Attempt ≠ Fulfillment
- Follow-Up ≠ Case Note
- Settlement ≠ Fulfillment or clinical outcome

## UX reference

The existing SUAS MVP is the visual/interaction reference. Preserve its action-first veteran/QRF/resource/responder/admin experience. Required production divergences include truthful availability, no unsupported proximity guarantee, no continuous GPS requirement, no hidden future-category workflow, and no unapproved safety copy.

## Current production-unavailable surfaces

Do not make operational by implementation default:

- real production infrastructure/provider side effects;
- real veteran data/live pilot;
- production Support Signal scoring;
- official safety/crisis copy;
- real external transportation/shelter/food/peer provider adapters;
- production SLO/RTO/RPO targets;
- sensitive aggregate reporting.

## Engineering rule

Prefer the simplest implementation mechanism that proves the released invariant. Do not introduce distributed-system complexity without measured need and a released spec change.
