# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/gridd ./cmd/gridd \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/ocpp-e2e-simulator ./cmd/ocpp-e2e-simulator

FROM gcr.io/distroless/static-debian12:nonroot AS gridd
COPY --from=build /out/gridd /usr/local/bin/gridd
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/gridd"]

FROM gcr.io/distroless/static-debian12:nonroot AS ocpp-e2e-simulator
COPY --from=build /out/ocpp-e2e-simulator /usr/local/bin/ocpp-e2e-simulator
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/ocpp-e2e-simulator"]

# The P0-4 test runner is built from the repository root through
# docker-compose.grid-e2e.yml. It is deliberately a separate final target from
# the production protocol-daemon image above.
FROM node:22.13.0-bookworm-slim AS grid-e2e-test
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["/bin/sh", "-ec", "pnpm exec drizzle-kit migrate && pnpm run seed:platform && pnpm exec vitest run server/grid-dispatch-e2e.test.ts --reporter=verbose"]
