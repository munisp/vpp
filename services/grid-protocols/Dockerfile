# Build stage — Go version matches go.mod (go 1.22)
FROM golang:1.22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git

# Copy go mod files first for layer caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the daemon (cmd/gridd). cmd/conformance is a one-shot CLI and is not
# part of the runtime image.
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o gridd ./cmd/gridd

# Runtime stage
FROM alpine:latest

# ca-certificates: outbound HTTPS to the platform/VTN/SEP2 endpoints.
# wget comes from busybox and is used by the compose healthcheck.
RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/gridd ./gridd

# The daemon refuses to start without a config file that enables at least one
# protocol; deployments mount their own config at config/config.yaml (see
# config.example.yaml) and keep secrets in the environment.

# Admin/command API (also serves /health)
EXPOSE 9100

CMD ["./gridd", "-config", "config/config.yaml"]
