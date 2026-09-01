# OpenSearch with the official Prometheus exporter plugin pre-installed.
# Plugin is version-locked to the OpenSearch version (see
# https://github.com/opensearch-project/opensearch-prometheus-exporter#compatibility-matrix):
#   OpenSearch 3.8.0  <->  prometheus-exporter 3.8.0.0
# Bump BOTH together when upgrading.
FROM opensearchproject/opensearch:3.8.0
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch \
      https://github.com/opensearch-project/opensearch-prometheus-exporter/releases/download/3.8.0.0/prometheus-exporter-3.8.0.0.zip
