# Governance

This document says who decides what, so that a contributor can predict how a change will be handled
and an adopter can judge how much of this project depends on one person.

## Current state, stated plainly

This project is maintained by its original author. There is no foundation, no technical steering
committee and no second maintainer today. Treat that as a real adoption risk: if you plan to depend
on this platform for an operating microgrid, either budget for your own fork or ask about the
maintainer arrangements below.

## Roles

**Users** run the platform. Bug reports and field experience carry weight; a report from a running
deployment outranks a theoretical objection.

**Contributors** send pull requests under the Developer Certificate of Origin. No commit access is
required to influence the project.

**Maintainers** review and merge, cut releases, and hold the security mailbox. A contributor is
invited to maintainer after a sustained record of good review judgement — not merely volume of code.
Maintainers are listed in `CODEOWNERS` when there is more than one.

**Lead maintainer** (currently the project author) breaks ties and owns the decisions listed below.

## How decisions get made

Ordinary changes: a maintainer other than the author reviews and merges where one exists; until
then, review is by the author with the reasoning stated in the PR.

Changes that need an explicit decision, recorded in the pull request:

- The data architecture: PostgreSQL as the only application store, TigerBeetle as the ledger, the
  lakehouse as derived. Adding a datastore is a governance decision, not a technical preference.
- Anything that weakens a refusal into a default, or that publishes a figure without its provenance.
- Licence, security policy, and this document.
- Protocol adapters: this project adopts existing standards (OCPP, OpenADR, IEEE 2030.5, Modbus /
  SunSpec, Matter, OpenFMB, CIM) and does not invent a new one.

Disagreement is resolved by discussion in the pull request or issue. If it cannot be, the lead
maintainer decides and writes down why. There is no voting body to appeal to yet, and pretending
otherwise would be dishonest.

## Licence

The platform is released under the [MIT licence](LICENSE), which is also what `package.json`
declares. Apache-2.0 is worth considering instead — it is what LF Energy projects use and what
enterprise legal teams expect, and it grants patent rights that MIT does not — but relicensing is
the copyright holder's decision, not a maintenance detail, so it has not been done unilaterally.
Contributions are accepted under the current licence.

## Community and commercial boundary

The whole platform in this repository is open source under the licence above: the dispatch
optimizer, the ledger integration, the protocol adapters, the network feasibility and design-study
engines, the journeys, the PWA and the mobile app. There is no feature held back and no
"enterprise edition" in a private branch.

What is *not* covered by the licence, and what an operator must supply, is everything with a
counterparty: payment gateway and mobile-money credentials, SMS providers, identity providers,
utility and DSO agreements, metering certification (STS vending keys need an HSM), hosted
infrastructure, and support with a response commitment. Commercial services around those are the
maintainers' to offer and yours to buy or not; none of them gate the code.

## Releases and compatibility

Releases are tagged from `main`. Breaking changes to a tRPC procedure, a database column's meaning
or scale, or an adapter's wire behaviour are called out in the release notes. Migrations are
forward-only; a migration that would silently reinterpret existing rows must instead add a column.

## Security

Security reports follow [SECURITY.md](SECURITY.md) and are handled by the maintainers privately,
ahead of feature work.

## Changing this document

By pull request, decided by the lead maintainer, with the reasoning recorded.
