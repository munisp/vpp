# Build stage
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o mqtt-fluvio-bridge ./cmd/main.go

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/mqtt-fluvio-bridge .
COPY --from=builder /app/config/config.yaml ./config/

# Expose health check port (if added)
EXPOSE 8080

CMD ["./mqtt-fluvio-bridge", "-config", "config/config.yaml"]
