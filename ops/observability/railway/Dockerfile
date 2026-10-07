# ─────────────────────────────────────────────────────────────────────────────
# Observabilidad en Railway (INFRA.2, ADR-043) — UN solo servicio.
#
# grafana/otel-lgtm = imagen oficial de Grafana que empaca en un contenedor:
#   OTel Collector (:4317 gRPC / :4318 HTTP)  +  Loki (logs)  +  Tempo (traces)
#   +  Prometheus (métricas)  +  Grafana (:3000, datasources ya cableados).
#
# Por qué 1 servicio y no 5: a 1 dev + Railway al 96% de memoria, cinco servicios
# (Grafana/Loki/Tempo/Prometheus/collector) es demasiada RAM y factura. otel-lgtm
# es el arranque pragmático para diagnosticar el OOM. Si crece, se parte en
# servicios separados o se pasa a Grafana Cloud.
#
# Ventaja Railway: el API y el worker le hablan por la RED PRIVADA
# (otel-lgtm.railway.internal:4318) → tráfico interno GRATIS, sin Cloudflare
# Tunnel. Solo Grafana (:3000) se expone con dominio público para verlo.
#
# ⚠️ otel-lgtm NO es "production-grade" (Grafana lo marca para dev/test): storage
# local, sin HA. Para nuestro uso (métricas/logs/traces de 1 API) sobra. Persistir
# con un Railway Volume (ver runbook).
# ─────────────────────────────────────────────────────────────────────────────
FROM grafana/otel-lgtm:latest

# Dashboard provisionado: aparece solo al arrancar Grafana (carpeta "Trade").
# Convive con el provisioning propio de otel-lgtm (datasources + sus dashboards).
# Rutas de COPY relativas a la RAÍZ del repo (el build context de Railway).
#   - provider yaml → /etc/grafana/provisioning/dashboards/trade.yaml
#   - dashboard json → /etc/grafana/provisioning/dashboards/trade/
COPY ops/observability/railway/grafana/dashboards-provider.yaml /etc/grafana/provisioning/dashboards/trade.yaml
COPY ops/observability/railway/grafana/trade-overview.json      /etc/grafana/provisioning/dashboards/trade/trade-overview.json

# Grafana escucha en 3000 (UI). El OTLP entra por 4317/4318 (solo red privada).
EXPOSE 3000 4317 4318

# El ENTRYPOINT viene de la imagen base (arranca los 5 componentes).
