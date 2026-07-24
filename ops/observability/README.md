# Observabilidad + uptime (self-hosted en .249)

## Uptime Kuma — usalo ya

Monitorea la URL pública de Railway y te avisa cuando se cae.

```bash
docker compose -f ops/observability/docker-compose.yml up -d uptime-kuma
```

1. Abrí `http://localhost:3001`, creá el usuario admin.
2. Add New Monitor → tipo HTTP(s) → URL = `https://<tu-app>.railway.app/api/health` → intervalo 60s.
3. Settings → Notifications → WhatsApp/Telegram/Email para las alertas.

## Error tracking

**Ahora (prod en Railway): usá Sentry SaaS free tier.** Railway (nube) no alcanza
un GlitchTip en tu LAN. Creá un proyecto en [sentry.io](https://sentry.io) (free:
5K eventos/mes), copiá los DSN (uno para el API Node, uno para Angular) y seteálos
como env en Railway (`SENTRY_DSN`) + en el build de Angular (`view` environment).
El SDK ya está wireado en el código (inerte sin DSN).

**Después (prod on-prem): GlitchTip.** Mismo SDK, solo cambiás el DSN al de GlitchTip.

```bash
# generá el secret y el dominio primero (ver .env.example)
export GLITCHTIP_SECRET_KEY=$(openssl rand -hex 32)
docker compose -f ops/observability/docker-compose.yml up -d gt-postgres gt-redis glitchtip-migrate glitchtip-web glitchtip-worker
```

Abrí `http://localhost:8000`, creá la cuenta + organización + proyecto, y usá ese DSN.
