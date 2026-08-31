# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o mqtt-fluvio-bridge ./cmd

# Runtime stage
FROM alpine:latest

# The fluvio transport shells out to the `fluvio` CLI (there is no Go SDK), so
# that binary must be present in this image when stream.transport=fluvio —
# which is the default deployment transport (services/docker-compose.yml sets
# STREAM_TRANSPORT=fluvio). The kafka transport needs nothing beyond the CA
# bundle. Install both; the bridge fails fast at startup if it needs the CLI
# and it is missing, so its absence would be a crash-loop, not a silent no-op.
RUN apk --no-cache add ca-certificates curl \
 && curl -fsS https://packages.fluvio.io/v1/install.sh | bash \
 && mv /root/.fluvio/bin/fluvio /usr/local/bin/fluvio \
 && fluvio version

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/mqtt-fluvio-bridge .
COPY --from=builder /app/config/config.yaml ./config/

# Expose health check port (if added)
EXPOSE 8080

CMD ["./mqtt-fluvio-bridge", "-config", "config/config.yaml"]
