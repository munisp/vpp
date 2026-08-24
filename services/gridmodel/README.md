# Network feasibility service

Power flow, limit checking and hosting capacity over a site's electrical model,
on the open-source [pandapower](https://www.pandapower.org/) engine. It answers
one question the platform could not answer before: *can the network physically
carry this dispatch or this flexibility award?*

The TypeScript server calls it over HTTP through
`server/services/network-feasibility.ts`, which is used by
`server/services/milp-dispatch.ts` (dispatch) and
`server/services/locational-flexibility.ts` (award eligibility).

## No plausible-looking output

A feasibility answer only means something against a model that can actually be
solved, so every case where it cannot be is a distinct status — never `feasible`:

| Situation | Result |
| --- | --- |
| No electrical model, or a bus with no topology | `model_unavailable` with the reason; the caller labels the decision network-unchecked |
| A bus islanded from every source | `model_unavailable`, naming the island |
| An injection or hosting query at an unknown bus | `model_unavailable`, naming the bus |
| Solver did not converge | `not_converged`; no voltages are reported |
| Solved, but outside a voltage band or element rating | `violations`, each naming the element and the candidate references that caused it |
| Solved within every limit | `feasible` |
| Missing `GRIDMODEL_AUTH_TOKEN` in production | the service refuses to answer |

The statuses are returned with HTTP 200 on purpose: a caller must be able to
distinguish "there is no model" from "this is not feasible", because the first
labels a decision as unchecked and the second refuses it.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and the engine version |
| `POST` | `/feasibility` | Power flow, limit check and hosting capacity for a network, its loads/generation, and candidate changes |

Authentication is the `x-gridmodel-token` header, checked against
`GRIDMODEL_AUTH_TOKEN`.

## Hosting capacity

`hosting_capacity` queries answer "how much more can this bus take (or export)
before something breaks?" The search brackets upward and then bisects, and the
value returned is one that itself solves within every limit — not a bracket
midpoint — so connecting exactly the reported headroom is safe. Each result names
the limiting element and the limit kind, or reports `capped: true` when the
search ceiling was reached before anything was violated.

## Engine validation

`tests/test_validation.py` checks the solved voltage of a two-bus constant-power
case against the closed-form solution of the receiving-end quadratic (agreement
to 1e-5 pu), checks that far-end export raises voltage, and checks that losses
are positive and bounded. The reference is arithmetic, not another program, so
the test cannot pass by the engine agreeing with itself.

Deliberately not claimed: the IEEE 4-node and 13-node distribution test feeders
publish per-phase solutions for unbalanced four-wire networks. `runpp` is a
positive-sequence solver, so those published tables are out of scope for this
engine and no test asserts otherwise. Everything the platform reports from this
service is a balanced positive-sequence result and the UI says so.

## Running locally

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest
GRIDMODEL_AUTH_TOKEN=dev uvicorn gridmodel.service:app --port 8098
```

`numba` is not a dependency. When it is importable pandapower JIT-compiles the
solve; when it is not, the service passes `numba=False` instead of warning on
every request.
