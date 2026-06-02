# Runbook — Redis en Railway (Socket.IO adapter)

Para correr el API con `numReplicas >= 2` necesitamos Redis para que los broadcasts de Socket.IO (`/reports` y `/alerts`) lleguen a clientes conectados en cualquier replica.

**Estado**: ⏸️ Pendiente — el código ya está deployable. Falta operar Railway.

---

## Por qué

Sin Redis, `server.to(room).emit(...)` solo alcanza sockets conectados a la **misma replica**. Si pod A emite `low_stock_critical` pero el cliente está conectado al pod B, no recibe nada. Con `@socket.io/redis-adapter`, todos los pods publican/suscriben al mismo bus → el evento llega a todos.

## Pre-requisito

- Código en `apps/api/src/main.ts` ya tiene `ReportsIoAdapter.connectToRedis()`. Si `REDIS_URL` falta, sigue funcionando in-memory (single replica). No rompe nada en deploys sin Redis.

## Pasos (CLI)

```bash
# 1. En el proyecto Railway del API:
railway add --plugin redis

# 2. Linkear el plugin al servicio API:
#    Railway expone REDIS_URL automáticamente si el plugin está en el mismo
#    proyecto. Verificar en la sección Variables del servicio API.

# 3. (Opcional) escalar a 2 replicas para validar:
railway variables set NUM_REPLICAS=2 --service api
```

## Pasos (Dashboard)

1. Railway → proyecto del API → New → Database → Redis.
2. Esperar a que el plugin termine de provisionar (~30s).
3. Ir al servicio del **API** → Variables → confirmar que `REDIS_URL` aparece como variable referenciada del plugin (`${{Redis.REDIS_URL}}`).
4. Trigger redeploy del API → en los logs debería aparecer:
   ```
   [SocketIOAdapter] Conectado a Redis (redis://***@...) — adapter cross-instance ACTIVO.
   [SocketIOAdapter] Redis adapter wired al io server.
   ```
5. Si querés validar multi-instance, en el servicio API → Settings → Scaling → Replicas: `2`.

## Validación

Una vez con 2+ replicas:

```bash
# Terminal 1: cliente WS conectado al endpoint público
node database/http-alerts-ws-test.js

# Terminal 2: trigger una alerta vía REST a la misma URL pública
curl -X POST https://<api>/api/commercial/alerts/test \
  -H "Authorization: Bearer <token>"
```

El cliente del Terminal 1 debe recibir el `alert` aunque su socket esté conectado a otra replica que la que procesó el POST. Sin Redis, ~50% del tiempo NO llegaría.

## Rollback

- Quitar `REDIS_URL` del servicio API → al próximo restart cae a modo in-memory automáticamente.
- Bajar replicas a 1 hasta investigar.
- El plugin Redis puede quedar provisionado sin costo si no hay tráfico.

## Costo

Plan **Hobby**: incluido. Plan **Pro**: ~$5-10/mes por el plugin Redis idle. El uso de Socket.IO adapter es de muy bajo throughput (~kbps).

## Operacional

- Memoria del plugin: 256 MB default es suficiente. El adapter solo guarda metadata de rooms efímera.
- TLS: Railway provisiona `rediss://` (TLS) automáticamente. El cliente `redis` npm lo maneja transparente.
- Persistencia: NO necesaria. Si Redis se cae, los pods siguen sirviendo emits locales y el siguiente restart reconecta solo.

## Riesgos

- Si Redis se cae mid-runtime, el cliente `redis` reintenta con backoff. Eventos emitidos durante el outage se pierden cross-instance (within-instance siguen funcionando).
- El password en logs queda masked con `//***@` → safe de pegar en tickets.
