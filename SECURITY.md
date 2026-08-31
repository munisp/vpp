# Security policy

This platform dispatches grid assets and moves money. A defect here can curtail a hospital's
supply or credit the wrong account, so security reports are handled ahead of feature work.

## Reporting a vulnerability

Report privately, not in a public issue or pull request:

- Use **GitHub private vulnerability reporting**: open this repository on GitHub, go to
  **Security → Advisories → Report a vulnerability**, and submit the draft advisory. It is
  visible only to the maintainers until (and unless) an advisory is published.
- If private vulnerability reporting is not enabled on the repository, open a minimal public
  issue asking a maintainer for a private contact channel — do not include any detail of the
  finding in that issue.

No general security mailbox is published for this repository: a policy that names an unread
mailbox is worse than none, and the GitHub advisory workflow is the channel that is actually
monitored.

Please include the affected component (API, worker, adapter, mobile app), the version or commit,
what an attacker gains, and a reproduction. If you have a patch, attach it privately rather than
opening a PR that describes the flaw.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | 3 business days |
| Initial assessment and severity | 10 business days |
| Fix or documented mitigation for critical severity | 30 days |
| Public advisory and credit (if you want it) | with the fix release |

Severity follows CVSS v3.1. Anything that lets an unauthenticated caller dispatch an asset, read
another tenant's data, or create a ledger movement is treated as critical regardless of score.

We will tell you what we found even when the answer is "this is not a vulnerability", and we will
not report you for testing against your own deployment.

## Scope

In scope: the API and tRPC routers, the Temporal workers, the protocol adapters
(`services/grid-protocols`, `services/modbus-poller`), the optimizer, gridmodel, lakehouse and ML
services, the PWA and the React Native app, and the deployment manifests in this repository.

Out of scope: findings that require an operator to disable a documented safety control; reports
against third-party services (payment gateways, brokers, identity providers) — report those to the
provider; volumetric denial of service; and missing hardening on a local development compose file.

## Please do not

- Test against a deployment you do not operate, or against real grid assets.
- Run load or fuzzing tools against a production or utility-connected instance.
- Access, modify or exfiltrate data belonging to other people. Stop at proof of access.

## Known exposure in this repository's history

`docs/VAPID_KEYS_SETUP.md` published a working Web Push (VAPID) keypair in earlier commits. The
working tree no longer contains it, but git history does, and history is not rewritten here. That
keypair must be treated as compromised: never configure it, and generate a fresh one per deployment
with `npx web-push generate-vapid-keys`. Any deployment that used it should rotate now — the
private half lets a third party sign push messages your users' browsers will accept as ours.

CI runs a full-history secret scan (`.github/workflows/ci.yml`, job `secret-scan`) so the next one
is caught in the pull request rather than after publication. Known test fixtures and documentation
placeholders are listed explicitly in `.gitleaks.toml`; add to that allowlist only a value you have
confirmed is not a credential.

## Operating this platform safely

- Every dependency this platform talks to is configured by environment variable and refuses rather
  than falls back: no gateway credentials means payments report unavailable, not success. Keep it
  that way when you extend it.
- `RATE_LIMIT_STORE=memory` multiplies every limit by your replica count. Production requires Redis.
- Only PostgreSQL DSNs are accepted; a DSN for any other store is refused at configuration time.
- Secrets belong in your secret manager. `.env` is for local development and is git-ignored.
