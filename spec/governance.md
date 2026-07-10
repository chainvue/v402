# v402 Governance

**Status:** First draft (v0.x era)
**Steward:** chainvue (Robert Lech)

## BDFL model for v0.x

During v0.x the spec is governed under a Benevolent Dictator For Life (BDFL) model:
chainvue (Robert Lech) has final decision authority over all normative changes.

This is explicit and deliberate, not an oversight. In the design-fluid phase a
standard needs fast, coherent iteration more than it needs committee process.
The tradeoff is honest: adopters get speed and a single accountable steward;
they give up formal veto power — mitigated by the forkability guarantee below.

## Change-proposal process

1. **GitHub issue** describing the problem and proposed change (wire-format
   changes must state their semver impact — see below).
2. **Discussion** on the issue; the steward may request a prototype or test vectors.
3. **PR** against `spec/` including updated test vectors where the wire format
   is affected.
4. **BDFL review** — accepted, rejected with rationale, or deferred.

Editorial fixes (typos, clarifications with no normative effect) may go straight
to PR.

## Spec versioning (semver)

- **MAJOR** (`0.x → 1.0`, `1.x → 2.0`) — breaking wire-format change. Servers
  MAY run multiple MAJOR versions in parallel but are not required to.
- **MINOR** (`0.1 → 0.2`) — new optional fields, new schemes, backward-compatible
  additions. Servers MUST remain compatible with prior MINOR versions of the
  same MAJOR.
- **PATCH** (`0.1.1`) — clarifications and typo fixes. No client changes, no
  version bump in signed payloads.

Protocol version and scheme versions are **separate namespaces**: schemes
(e.g. `verus-prepaid-sig/0.1`) version independently of the protocol envelope
(`v402/0.1`). A scheme can release without a protocol bump and vice versa.

## Deprecation policy

- Discovery (`.well-known/v402`) advertises `deprecatedVersions` ("still works,
  plan migration") and `sunsetDates`.
- Minimum **6 months** between sunset announcement and removal after a MAJOR release.
- After the sunset date a server MAY remove support for the deprecated version.

## Transition to a Technical Steering Committee (TSC)

The BDFL model ends and a TSC forms at whichever comes first:

- the spec reaches **v1.0**, or
- there are **5+ independent implementations** in active use.

TSC composition and voting rules will be proposed via the change process above
before the transition, with implementers represented.

## Trademark & long-term stewardship

chainvue holds naming/stewardship of "v402" during v0.x. If adoption warrants,
donation of the mark and spec to a neutral foundation is an explicitly
acknowledged option.

## "What if chainvue disappears"

The spec is CC-BY-4.0 and the reference implementation Apache-2.0. Both are
permanently forkable; no license, patent, or trademark mechanism in this project
can lock adopters in. Continuity in the worst case is a community fork with
attribution — by design.
