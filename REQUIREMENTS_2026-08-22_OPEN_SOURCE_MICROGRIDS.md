# Business and Technical Requirements from the Open Source Microgrids Report

Source document: *The Open Source Opportunity for Microgrids*, Linux Foundation / Futurewei /
Intentional Futures, June 2023 (46 pages, authors Jessica Groopman with Jeffry Lindstrom,
CC BY-ND 4.0). Research conducted Oct 2022 – Mar 2023 from 17 interviews plus a canvass of
open source microgrid projects.

Every claim below is labelled by provenance:

- **[REPORT]** — asserted by the report (a third-party claim, not independently verified here).
- **[REPO]** — verified in this repository at the cited path.
- **[PROPOSAL]** — my recommendation, not present in either.

Nothing in this document is implemented. It is a requirements set, and the audit sections exist
so that we do not build what we already have.

---

## 1. Executive summary

The report's central technical argument is that the microgrid market is blocked on a **missing
middle layer**: heterogeneous field equipment below, applications and markets above, and no
protocol-neutral, semantically consistent control/data layer in between. Its five value
propositions are accessibility, faster design/time-to-market, interoperability and standards
adoption, enabling business models (support, training, certification, customization, modularity),
and market innovation toward resilience at scale. **[REPORT]**

This platform is already a credible instance of that middle layer: it terminates OCPP 1.6J and
2.0.1, OpenADR 2.0b, IEEE 2030.5, Modbus and Matter; it dispatches through a real MILP/stochastic/
CVaR/MPC optimizer; it settles money on a TigerBeetle double-entry ledger and refuses to report
financial or grid success without provider, ledger or telemetry evidence. **[REPO]**

The report exposes eight areas where we are genuinely thin, and they cluster in the parts of the
microgrid business the report says decide adoption in developing markets — **feasibility before
build, electrical truth during operation, prepaid energy access, and bankable evidence after the
fact**:

| # | Gap | Report driver | Priority |
|---|-----|---------------|----------|
| G1 | No network-constrained feasibility (no power-flow / hosting capacity) | GridLAB-D, OpenDSS, "simulation before deployment" **[REPORT]** | P0 |
| G2 | Microgrid autonomy and critical-load service are computed from assumptions, not nameplate data | "prove resilience benefits" **[REPORT]** | P0 |
| G3 | No prepaid / pay-as-you-go energy sale (no OpenPayGo-style tokens) | OpenPayGo, EnAccess, energy access in emerging markets **[REPORT]** | P0 |
| G4 | No customer-side reliability/quality-of-service metrics (SAIDI/SAIFI, unmet load, hours of service) | Husk roadmap KPIs: cost, demand, quality of service, deployment rate **[REPORT]** | P0 |
| G5 | Declared device protocols and certifications are unproven free text; no adapter conformance harness | Low interoperability, "plug and play", "converting anything to anything" **[REPORT]** | P1 |
| G6 | No SunSpec model discovery; every Modbus register map is hand-written per device | Fragmented standards, high customization cost **[REPORT]** | P1 |
| G7 | No asset ownership / finance / revenue-share model; payouts assume the seller owns the asset | Energy-as-a-service, shared savings, prosumer models **[REPORT]** | P1 |
| G8 | No bankability / results-based-finance evidence pack for lenders, regulators and subsidy programs | "Economic hurdles: data sharing of microgrids economics, education on ROI" **[REPORT]** | P1 |

Two further items are strategic rather than functional: OpenFMB profiles on the existing MQTT bus
(G9, P2) and the open-source posture itself — this repository has no LICENSE, CONTRIBUTING,
SECURITY or governance file, so none of the report's ecosystem value propositions are currently
available to us at all (G10, P1, and by far the cheapest item on the list). **[REPO]**

---

## 2. Local audit: what the report asks for and what we already have

Built already — **do not rebuild**:

| Report theme | Existing capability | Evidence **[REPO]** |
|---|---|---|
| Interoperability: OpenADR | OpenADR 2.0b VEN with instruction/payload handling | `services/grid-protocols/internal/openadr/ven.go` |
| Interoperability: IEEE 2030.5 | SEP2 client and models | `services/grid-protocols/internal/sep2/client.go` |
| Interoperability: Modbus | Rust poller, explicit register maps, spooling when the platform is unreachable | `services/modbus-poller/src/` |
| Interoperability: EV charging | OCPP 1.6J and 2.0.1 CSMS, station-owned transaction identity | PRs #3, #25, #26 |
| Interoperability: smart loads | Matter via a real external controller, refuses in-process fallback | `server/services/matter-ingest.ts` |
| Field message bus | MQTT broker integration + Fluvio bridge | `server/integration/mqtt-broker.ts`, `services/mqtt-fluvio-bridge/` |
| Microgrid / islanding | Energy communities with `canIsland`, islanding request that refuses to claim a switchgear transition it cannot perform, operator confirmation path | `server/services/community-energy.ts:684-760` |
| Locational value | Flexibility as a *located* product with `substation`/`feeder`/`transformer` nodes and `link_source` provenance; unverified links never awarded | `drizzle/locational-flexibility-schema.ts` |
| Dispatch optimization | MILP/stochastic/CVaR/MPC over PuLP + HiGHS, bounded controls with validity windows and declared fallback | `services/optimizer/optimizer/`, `server/services/control-validity.ts` |
| Market / trading | P2P, P2B, B2P, B2B with typed counterparties, order fills correlated to orders, settlement only on provider evidence | PRs #36, #37 |
| Money | TigerBeetle double-entry, deterministic ids, idempotent callbacks, independent reconciliation | PR #42, `server/services/ledger/` |
| Open data plumbing | Lakehouse ingestion verified by object read-back + SHA-256 | `services/lakehouse/` |
| Carbon | Carbon credit minting with recorded emission-factor source and period | `server/services/carbon-credits.ts` |
| Analytics / AI | PyTorch + Ray training, verified checkpoints, evidence-gated promotion, drift, continuous training; Ollama diagnostics that refuse without evidence | PRs #47, #49, #50, #51 |
| Digital twin / NOC-SOC | Twin and operations wall rendered only from telemetry that exists | PR #33 |
| Reusable processes | 20 parameterised, resumable Temporal stakeholder journeys | PR #59 |

Partial or absent, verified by search:

- `microgrid` appears in 4 files, all inside the community-energy feature; there is no microgrid
  *site* entity, no electrical topology below the community, and no design-time model. **[REPO]**
- `SAIDI`/`SAIFI`/`CAIDI`, `LCOE`/`capex`/`opex`, `OpenPayGo`, `OpenFMB`, `61850`, `diesel`,
  `bankable`/`investor`/`financier`: **zero matches** across `server`, `client`, `mobile`,
  `shared`, `drizzle`, `services`, `workers`. **[REPO]**
- `SunSpec` appears once, as a column comment in `drizzle/nextgen-vpp-schema.ts:407`. **[REPO]**
- `interconnection` appears once, in a log string. **[REPO]**
- "Power flow" exists only as a PWA visual widget (`client/src/components/PowerFlowWidget.tsx`),
  not as an electrical calculation. The optimizer's dependencies are `pulp` and `highspy` — there
  is no `pandapower`, `opendss` or equivalent, so no dispatch or flexibility award is ever checked
  against voltage or thermal limits. **[REPO]**
- `server/services/compliance-automation.ts:633-653` measures **platform service** availability
  from health checks and labels it `availability_percent` in a compliance report. That is not the
  customer's power availability, and a regulator reading that field would be misled. **[REPO]**
- `server/services/community-energy.ts:616` computes island autonomy as
  `sharedCapacityKw * 2 // Assume 2-hour battery`, and line 621 decides `criticalLoadsServed`
  as "generation + battery > 50% of load". Both produce a confident number from an assumption,
  which is the failure class this platform has otherwise eliminated. **[REPO]**
- `server/services/der-capabilities.ts` stores `protocols: string[]` and
  `certifications: string[]` as free text. Nothing verifies either, so a device can claim
  IEEE 2030.5 conformance it has never demonstrated. **[REPO]**
- `drizzle/schema.ts:128-143` (`assets`) has one `userId` and no owner/operator/financier
  distinction, no funding source, no O&M responsibility and no contract. Every payout therefore
  implicitly pays the registered user. **[REPO]**

Blocked on things we do not have, and out of scope here: real payment/SMS provider credentials,
Mojaloop, a Kafka cluster, production S3, multi-node Ray, physical OCPP/Matter/Modbus hardware,
and any live utility or market-operator endpoint. **[REPO]**

---

## 3. Business requirements

### BR-1 — Feasibility and design study as a first-class platform object (from G1, G6) — P0

A developer, agency or community must be able to model a site before it is built: loads, resource
(solar/wind/hydro/genset), storage, tariff and diesel baseline; and receive a costed,
network-checked recommendation with an auditable record of every input and assumption.

- **Report basis:** open modelling and simulation (GridLAB-D, OpenDSS, pymgrid) as the
  accessibility and time-to-market lever; "if you've seen one microgrid, you've seen one
  microgrid" argues for parameterised design, not bespoke consulting. **[REPORT]**
- **Value:** converts the platform from an operations tool into the tool that wins the project.
  It is also the only credible way to price diesel displacement, which is the actual buying
  trigger for Nigerian commercial and public sites.
- **Acceptance:** a study produces sizing, LCOE, capex/opex, fuel and CO₂ displacement, unmet-load
  percentage and payback; every figure names its input source; a study with no load data is
  **refused**, not defaulted.

### BR-2 — Prepaid / pay-as-you-go energy for mini-grid customers (from G3) — P0

A mini-grid operator must be able to sell energy prepaid: customer buys credit (existing mobile
money path), credit is delivered to a meter, and supply follows the credit balance.

- **Report basis:** OpenPayGo, EnAccess and the emerging-market energy-access value proposition;
  the report's near-term claim is that open source "can help catalyse energy access in developing
  economies". **[REPORT]**
- **Value:** without prepayment there is no mini-grid revenue model in Nigeria or Tanzania. This
  is the single largest addressable-market gap in the platform, and it reuses payments, ledger,
  SMS and metering that already exist.
- **Acceptance:** a token is issued only after a ledger-posted payment; a token is redeemable once;
  balance decrements from metered consumption; a disconnection is an explicit, logged, appealable
  action, never an inferred one; with no meter integration the platform reports **unavailable**
  rather than a balance it cannot enforce.

### BR-3 — Quality-of-service and reliability reporting to customers, regulators and lenders (from G4) — P0

Report service actually delivered: hours of service, SAIDI/SAIFI/CAIDI, unmet demand, availability
per site and per customer class, with data-coverage stated alongside every figure.

- **Report basis:** the Husk roadmap's industry performance indicators — cost, demand, quality of
  service, rate of deployment — as the path to bankability. **[REPORT]**
- **Value:** mini-grid regulation and concessional finance are conditioned on these numbers. Also
  fixes a live misrepresentation risk: today's compliance report labels platform uptime as
  "availability".
- **Acceptance:** metrics are computed from telemetry and recorded outages, never from health
  checks; every metric carries sample coverage and is withheld when coverage is below threshold;
  platform availability and power availability are separately named everywhere they appear.

### BR-4 — Truthful resilience claims (from G2) — P0

Island autonomy, critical-load service and reserve margin must be computed from registered
nameplate energy capacity and a declared critical-load register.

- **Report basis:** the report names inability to prove resilience benefits as a market barrier.
  **[REPORT]**
- **Value:** resilience is what a hospital, water utility or state agency is buying. A number
  derived from "assume a 2-hour battery" cannot survive due diligence and contradicts the
  platform's own evidence standard.
- **Acceptance:** autonomy is `null` with a stated reason when storage capacity or critical loads
  are unregistered; `criticalLoadsServed` is derived from the critical-load register only.

### BR-5 — Asset ownership, finance and revenue sharing (from G7) — P1

Model who owns an asset, who operates it, who financed it (grant, concessional loan, EaaS
provider, community contribution) and how revenue splits between them.

- **Report basis:** enabling microgrid business models — energy-as-a-service, shared savings,
  community and cooperative ownership, utility/community partnerships. **[REPORT]**
- **Value:** unlocks EaaS and third-party-financed deployment, which is how sites get built when
  the host cannot fund capex. Today every payout silently pays the registering user.
- **Acceptance:** a settlement distributes along a versioned revenue-share waterfall on the
  double-entry ledger; shares must sum to 100% or the configuration is refused; a payout with no
  configured waterfall refuses rather than defaulting to the registrant.

### BR-6 — Results-based finance and subsidy verification for government programs (from G8) — P1

Let an agency or donor define a program (e.g. per verified connection, per kWh delivered to a
public facility, per diesel litre displaced), and have the platform produce verified,
tamper-evident claims and disbursement records.

- **Report basis:** the public-sector role — funding priorities, subsidy design, aggregating
  public data; and the report's observation that microgrids lack the subsidy machinery that scaled
  national grids. **[REPORT]**
- **Value:** this is the platform's strongest differentiator with governments: the same evidence
  discipline that refuses to fake a payment can prove a subsidy was earned. It converts our
  evidence architecture into a procurement advantage.
- **Acceptance:** a claim references the telemetry, ledger and reconciliation rows that support it;
  a claim missing any of them is `unverified` and non-payable; every disbursement posts to the
  ledger with the claim id.

### BR-7 — Bankability and investor reporting pack (from G8) — P1

One export: cost per connection, utilization, ARPU, collection rate, availability, tCO₂ avoided,
diesel displaced, portfolio by agency/region, with methodology and coverage.

- **Report basis:** "data sharing of microgrids economics" and "education on value propositions
  and ROI" as named needs. **[REPORT]**
- **Value:** shortens diligence, and is nearly free because the lakehouse and ledger already hold
  the inputs.

### BR-8 — Open-source posture and ecosystem (from G10) — P1

Adopt an explicit licence, contribution, security-disclosure and governance model, plus a
community edition boundary and a published adapter catalogue.

- **Report basis:** the report's business-model section (Red Hat, MongoDB, TensorFlow, Zephyr) —
  monetise support, hosting, certification and integration while the core is open; and its
  finding that >50% of open source microgrid projects come from universities, i.e. the talent
  pipeline is in the open. **[REPORT]**
- **Value:** the whole ecosystem argument — partners, procurement credibility ("inspectable
  code"), and developer supply — is currently unavailable to us for the want of four files.
- **Acceptance:** LICENSE, CONTRIBUTING, SECURITY, GOVERNANCE and CODE_OF_CONDUCT exist; the
  commercial boundary is documented; no credential or tenant data is in history.

### BR-9 — Certified adapter and device catalogue (from G5, G6) — P1

Publish which device models are proven against which protocol, by whom, and when; charge for
certification.

- **Report basis:** interoperability plus the certification/training revenue model. **[REPORT]**
- **Value:** turns integration effort into a reusable, sellable asset and makes procurement
  ("does it work with my inverter?") answerable with evidence.

### BR-10 — Regulatory and interconnection workflow (P2)

Track interconnection applications, permits, tariff approvals and their expiry per site.

- **Report basis:** regulatory barriers and utility interconnection requirements as the top
  non-technical blocker. **[REPORT]**
- **Value:** removes the most common cause of stalled projects from spreadsheets into the platform.

---

## 4. Technical requirements

### TR-1 — Network feasibility service (`services/gridmodel`) — P0, implements BR-1, BR-4

- New Python service alongside `services/optimizer`, exposing power-flow and hosting-capacity
  evaluation over a site network model (pandapower or OpenDSS; both are open source, which is the
  report's point). **[PROPOSAL]**
- Persist the network model in PostgreSQL, extending `grid_nodes` from
  `drizzle/locational-flexibility-schema.ts` with electrical parameters (line impedance, rating,
  transformer capacity, phase) rather than a new topology table. **[REPO]** basis.
- `POST /feasibility` returns per-node voltage and loading, violated limits, and hosting capacity.
- Wire into two existing decisions: the MILP dispatch (`server/services/milp-dispatch.ts`) and
  flexibility award eligibility (`server/services/locational-flexibility.ts`).
- **Refusal semantics:** if the site has no electrical model, feasibility returns
  `model_unavailable` and the award/dispatch is labelled network-unchecked — it must never return
  "feasible".
- **Acceptance:** an award that violates a transformer rating is refused with the violated element
  named; a documented IEEE test feeder reproduces published voltages within tolerance.

### TR-2 — Design study engine — P0, implements BR-1

- `server/services/design-study.ts` + `design_studies` schema: inputs (load profile source,
  resource data source, tariff, diesel price, capex/opex assumptions, discount rate), outputs
  (sizing, LCOE, payback, unmet load, fuel and CO₂ displacement), and a frozen assumption set per
  study version. **[PROPOSAL]**
- Sizing search runs in the optimizer service (it already does MILP over storage and curtailment);
  do **not** add a second solver.
- Load profiles come from existing telemetry where a site is metered, and from a labelled
  synthetic profile otherwise — labelled in the output, per the platform's existing synthetic-data
  rule. **[REPO]**
- PWA page under the existing Grid/Planning nav group; mobile read-only view.
- **Acceptance:** two studies with identical inputs produce identical outputs; changing the diesel
  price changes payback and is recorded as a new study version; a study with neither metered nor
  declared load is refused.

### TR-3 — Prepaid energy and token issuance — P0, implements BR-2

- `prepaid_accounts`, `prepaid_tokens`, `prepaid_ledger_links` in PostgreSQL; balances in Wh and
  minor currency units, no floats. **[PROPOSAL]**
- Token generation implements the OpenPayGo Token specification (open, documented, already used
  across African PAYG solar) so third-party meters and SHS units interoperate rather than
  requiring our own scheme. **[REPORT]** names OpenPayGo; the algorithm itself is external.
- Issuance is a Temporal activity chained after the existing payment + ledger posting: no token
  without a posted credit; deterministic token id from `(paymentId, accountId, sequence)` so a
  retry re-derives the same token instead of vending a second one.
- Consumption decrements from metered energy (`telemetry`), not from time.
- Existing `server/services/sms-commands.ts` gains balance/token-resend commands — the channel a
  rural customer actually has. **[REPO]**
- **Acceptance:** replaying a callback yields one token; a token accepted by a meter simulator
  twice is rejected the second time; with no meter integration configured the API returns
  `unavailable_no_meter_integration`.

### TR-4 — Service reliability metrics — P0, implements BR-3

- `server/services/service-reliability.ts` computing SAIDI/SAIFI/CAIDI, hours of service, unmet
  demand and availability from telemetry gaps plus explicit outage records; reuse the pattern in
  `drizzle/degraded-schema.ts` (open/closed outage rows, one open per subject) for **customer
  supply** outages. **[REPO]** basis.
- Every metric returns `{ value, sampleCoverage, windowStart, windowEnd, method }` and is withheld
  (`null` + reason) below a configured coverage floor.
- Rename the misleading field: `compliance-automation.ts`'s `availability_percent` becomes
  `platform_service_availability_percent`, and power availability is reported separately.
- Surface on the existing NOC/SOC wall and the digital twin. **[REPO]**
- **Acceptance:** a synthetic month with known interruptions reproduces hand-computed SAIDI/SAIFI;
  a site with 40% telemetry coverage reports no SAIDI at a 90% floor.

### TR-5 — Nameplate-based resilience computation — P0, implements BR-4

- Add storage energy capacity (Wh) and a `critical_loads` register (asset, priority, kW,
  autonomy target) to the asset model; the current `assets.capacity` int is overloaded as watts or
  watt-hours by type and cannot answer autonomy questions. **[REPO]**
- Replace `community-energy.ts:616` and `:621` with computation from registered capacity, measured
  SoC and the critical-load register; return `null` with `reason` when inputs are missing.
- **Acceptance:** a community with no registered storage energy reports no autonomy figure; a
  community with registered storage reproduces a hand-computed autonomy; the string
  "Assume 2-hour battery" no longer exists in the codebase.

### TR-6 — Adapter conformance harness and capability proofs — P1, implements BR-5(no), BR-9, G5

- A protocol conformance suite per adapter (OCPP 1.6J, OCPP 2.0.1, OpenADR 2.0b, IEEE 2030.5,
  Modbus/SunSpec, Matter) run against a simulator or real device, writing a
  `conformance_runs` row: adapter, version, device model, test vector set, pass/fail per case,
  operator, timestamp, artefact checksum. **[PROPOSAL]**
- `der_capabilities.protocols` / `.certifications` become references to conformance evidence.
  A claimed protocol with no passing run reads as `claimed_unproven` everywhere it is displayed —
  the platform's existing "declared vs proven" distinction, applied to devices. **[REPO]** basis.
- **Acceptance:** dispatch over a `claimed_unproven` protocol is labelled as such in the control
  record; a certification cannot be created without a passing run id.

### TR-7 — SunSpec model discovery in the Modbus poller — P1, implements BR-9, G6

- Extend `services/modbus-poller` with SunSpec model discovery: locate the SunSpec base register,
  walk the model chain, and derive point maps from the model definitions instead of hand-written
  register lists. Keep the explicit-map path for non-SunSpec devices — the config module correctly
  refuses to guess today, and that must stay true. **[REPO]**
- **Acceptance:** a SunSpec-compliant inverter simulator is polled with no hand-written register
  map; a non-SunSpec device still requires an explicit map; a device that advertises SunSpec but
  fails the chain walk is refused, not partially decoded.

### TR-8 — Asset ownership, finance and revenue-share waterfall — P1, implements BR-5

- `asset_ownership` (owner, operator, financier, share, effective window, funding source: grant /
  concessional / commercial / community / EaaS), `service_contracts` (EaaS, PAYG, shared savings,
  O&M with availability guarantee), `revenue_shares` (versioned waterfall). **[PROPOSAL]**
- Settlement (`server/services/p2p-settlement.ts`, `settlement-ledger.ts`) distributes along the
  waterfall as multiple balanced ledger postings in one transfer set, so partial distribution is
  impossible. **[REPO]** basis.
- **Acceptance:** shares not summing to 100% are refused at configuration time; a settlement
  produces postings whose sum equals the settled amount to the minor unit; a payout with no
  waterfall refuses.

### TR-9 — Program, claim and disbursement engine — P1, implements BR-6

- `programs` (sponsor, metric, rate, cap, eligibility, verification rule, window), `program_claims`
  (subject, period, computed quantity, evidence refs, state:
  `draft|verified|unverified|paid|rejected`), `program_disbursements` (ledger transfer id).
  **[PROPOSAL]**
- Verification is a Temporal workflow reusing existing evidence services (telemetry aggregates,
  reconciliation, lakehouse run checksums); a claim stores the row ids it relied on so an auditor
  can re-derive it. **[REPO]** basis.
- **Acceptance:** a claim whose telemetry coverage is insufficient becomes `unverified` and cannot
  be paid; re-running verification on unchanged data yields an identical quantity; a disbursement
  is idempotent per `(claim, attempt)`.

### TR-10 — Bankability report pack — P1, implements BR-7

- Lakehouse-side report definitions (`services/lakehouse`) producing the BR-7 metric set as a
  dated, checksummed artefact, with a methodology note and coverage per metric; PWA export and a
  read-only investor role. **[PROPOSAL]**
- **Acceptance:** two runs over the same lake snapshot produce identical checksums; any metric
  below coverage floor is printed as "insufficient data", never as zero.

### TR-11 — OpenFMB profiles on the existing bus — P2, implements G9

- Publish and consume OpenFMB-profiled messages over the existing MQTT integration for the DER
  message types we already model (meter reading, breaker/recloser status, ESS status, resource
  status), as an optional profile beside the current topics. **[REPORT]** highlights OpenFMB as
  the ratified interoperable field message bus; **[REPO]** already has the broker and the twin.
- **Acceptance:** a message round-trips against an OpenFMB reference publisher; profile validation
  failures are rejected, not coerced.

### TR-12 — CIM-lite network model import — P2, implements BR-1, BR-10

- Import distribution network topology (feeders, transformers, connection points) from a
  utility-provided CIM/CSV extract to populate `grid_nodes` and set `link_source =
  utility_verified` — today that value exists in the enum but has no ingestion path, so the most
  valuable provenance level is unreachable. **[REPO]**
- **Acceptance:** an import sets `utility_verified` only for links present in the extract; a
  conflicting import is reported as a conflict, not silently overwritten.

### TR-13 — Open-data publication endpoint — P2, implements BR-8

- Aggregated, de-identified site performance and generation time series published on a documented
  schema and licence, with k-anonymity thresholds and an explicit tenant opt-in.
- **Report basis:** open data sharing as a value proposition (Open Power System Data,
  transparency into microgrid performance and finance models). **[REPORT]**
- **Acceptance:** no dataset contains a single-site or single-customer series below threshold;
  every export names its licence and generation time.

### TR-14 — Open-source repository posture — P1, implements BR-8

- LICENSE (my recommendation: Apache-2.0 for the platform core — the licence LF Energy projects
  use, and the one enterprises accept), CONTRIBUTING, SECURITY (disclosure address and SLA),
  GOVERNANCE, CODE_OF_CONDUCT, DCO or CLA, plus an SBOM in CI and a documented community/commercial
  boundary. **[PROPOSAL]**
- **Acceptance:** files present; CI emits an SBOM; a secret scan over full history passes before
  any repository is made public.

---

## 5. Sequencing

- **Phase 1 (P0, truthfulness and market fit):** TR-5, TR-4, TR-3, TR-1, TR-2. Roughly one focused
  session each for TR-5 and TR-4; two to three each for TR-3, TR-1 and TR-2 given the simulators
  and test vectors they need. TR-14 rides along in the first session — it is an hour.
- **Phase 2 (P1, bankability and interoperability proof):** TR-8, TR-9, TR-10, TR-6, TR-7.
- **Phase 3 (P2, ecosystem):** TR-11, TR-12, TR-13, BR-10 workflow.

Estimates are my own throughput, not a team's, and exclude external waits: TR-3 cannot be proven
without a meter or meter simulator, TR-7 without a SunSpec device or simulator, TR-11 without an
OpenFMB reference peer, and TR-12 without a utility extract. Those will be reported as
`blocked`, not `passed`, exactly as the existing journey suite does.

---

## 6. Non-goals and honest limits

- Not building a new standard. The report is explicit that a standard to unify standards is just
  one more standard; TR-6/TR-7/TR-11/TR-12 adopt existing ones.
- Not writing a power-flow solver. TR-1 wraps an existing open source engine.
- Not claiming the market-size and CAGR figures in the report ($11.6B in 2022 to >$50B by 2030,
  17.6% CAGR) as verified; they are the report's citation of Guidehouse and should be attributed
  as such in any investor material. **[REPORT]**
- Not changing the data architecture: PostgreSQL remains the only application data store; the
  lakehouse remains derived; TigerBeetle remains the ledger.
- Not replacing the PWA or React Native apps: every new surface lands in the existing grouped
  navigation and the existing mobile stack.
- These requirements do not raise the platform's production-readiness score by themselves. They
  extend what it can honestly claim; the score still depends on credentials, endpoints and
  hardware we do not have.
