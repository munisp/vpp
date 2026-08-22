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
# that binary must be present in this image when stream.transport=fluvio.
# The kafka transport needs nothing beyond the CA bundle.
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/mqtt-fluvio-bridge .
COPY --from=builder /app/config/config.yaml ./config/

# Expose health check port (if added)
EXPOSE 8080

CMD ["./mqtt-fluvio-bridge", "-config", "config/config.yaml"]
