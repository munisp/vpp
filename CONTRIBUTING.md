# Contributing

Thank you for wanting to work on this. This platform aggregates distributed energy resources,
dispatches them, and settles money against what was delivered. The bar for a change is therefore
higher than "it works on my machine": a wrong number here becomes a wrong invoice or a wrong
setpoint.

## The one rule that matters

**Never make the platform claim something it has not established.** If the evidence for an answer is
missing — no telemetry, no credentials, no solve, no provider response — return a refusal or a null
with a stated reason. Do not return a plausible-looking placeholder, a zero, a default, or an
optimistic status.

Concretely, in this codebase that means:

- A missing interval is a silent meter, not zero demand.
- An unreachable service is `service_unavailable`, not a finding about the site.
- A metric below its coverage floor is withheld with a reason, never printed as 0.
- A capability with no proof reads as declared, not as available.
- A settlement posts balanced double-entry movements or does not post at all.

A pull request that makes a failure look like a success will be rejected even if every test passes.

## Development setup

Prerequisites: Node 20 with pnpm (see `packageManager` in `package.json`), Python 3.12, Go 1.22,
Rust stable, and a local PostgreSQL 16.

```bash
pnpm install
export DATABASE_URL="postgresql://vpp:vpp@127.0.0.1:5432/vpp"
npx drizzle-kit migrate
pnpm dev
```

PostgreSQL is the only application data store. TigerBeetle holds ledger movements, the lakehouse is
derived and rebuildable, Redis is cache and rate-limit state, Kafka carries events written by the
transactional outbox. Do not add another database.

Per-service environments (each has its own `requirements.txt`):
`services/optimizer`, `services/lakehouse`, `services/ml`, `services/gridmodel`,
`services/grid-protocols` (Go), `services/modbus-poller` (Rust), `mobile` (Expo).

## Before you open a pull request

```bash
pnpm check                                   # TypeScript
pnpm test                                    # vitest
pnpm build                                   # client + server bundles
(cd services/optimizer && ./.venv/bin/python -m pytest)
(cd services/grid-protocols && go test ./...)
(cd services/modbus-poller && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
```

Run the suites for the languages you touched; CI runs all of them.

## Pull requests

- One concern per PR. Keep the diff to the files the change needs.
- Explain *why* in the description, and say plainly what you did **not** verify. "Untested against a
  real meter" is a useful sentence; silence about it is not.
- Add tests that would fail without your change. Do not edit an existing test to make it pass.
- Database changes go through drizzle migrations, with constraints that make the dishonest state
  unrepresentable (a status without its reason, a recommendation on a failed study). Prefer a CHECK
  constraint over a comment.
- Money is integer minor units. Energy is watt-hours, power is watts, prices are cents/kWh at the
  service boundary; several tables store scaled integers (`_x100`, `_ppm`) — check the column
  comment before you write a number into it.
- New user-facing surfaces land in the existing grouped PWA navigation and the existing React Native
  stack, and must show provenance (what the figure came from) next to the figure.

## Certificate of origin

Contributions are accepted under the Developer Certificate of Origin 1.1
(<https://developercertificate.org>). Sign off each commit:

```bash
git commit -s -m "Your message"
```

`Signed-off-by:` states that you wrote the patch or have the right to submit it under this
repository's licence. No copyright assignment is asked for and no CLA is required.

## Reporting bugs and security issues

Functional bugs: open an issue with the version or commit, what you expected, what happened, and how
to reproduce it. Security issues: **do not** open an issue — follow [SECURITY.md](SECURITY.md).

## Conduct and decisions

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md); how decisions get made and
who makes them is in [GOVERNANCE.md](GOVERNANCE.md).
