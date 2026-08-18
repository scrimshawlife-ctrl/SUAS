# SUAS

Shut Up and Serve (SUAS) is the implementation repository for the consent-governed veteran support coordination platform specified in [`scrimshawlife-ctrl/SUAS-specs`](https://github.com/scrimshawlife-ctrl/SUAS-specs).

## Current implementation status

- Application code: not yet started
- Specification lifecycle: `draft`
- Implementation authority: `NOT_YET_RELEASED`
- Pilot readiness: `NOT_READY`
- Production readiness: `NOT_READY`

The current specs preflight is merged to `SUAS-specs/main` at commit `96631dc1cf09768a8fe5550e620e3e1bde5377c9`, but that merged draft is **not** implementation authority. The first implementation-authoritative specification cut occurs only when the owner completes the staged acceptance path and SPEC-016 marks a named release `RELEASED_FOR_IMPLEMENTATION`.

## Governing rules

1. `SUAS-specs` is canonical. This repository implements released contracts; it does not redefine them.
2. Every implementation PR must cite the released spec file, section, stack version, lifecycle, and applicable runtime artifact versions.
3. If code needs a rule that is absent from released specs, return the gap to `SUAS-specs` rather than inventing behavior here.
4. Preserve the referenced MVP visual/interaction model once `MVP_REFERENCE.md` is released, including the action-first veteran and responder/QRF flows.
5. Keep rides, temporary shelter/rooms, food, and peer-support integrations provider-neutral. Vendor SDKs belong behind adapters, not in domain modules.
6. Preserve stateless horizontal application semantics, durable production-critical jobs, command/provider idempotency, tenant isolation, and replay-safe events as released.
7. No automated emergency dispatch, diagnosis, suicidality determination, or safety-critical generative AI.
8. Do not claim HIPAA compliance while the legal classification remains unresolved.

See [AGENTS.md](AGENTS.md) and [IMPLEMENTATION_BOOTSTRAP.md](IMPLEMENTATION_BOOTSTRAP.md).
