# Fase I — ML Credit Risk + WebSocket scaling

**Duración estimada:** 8-12 semanas
**Objetivo:** modelo ML para credit risk, escalado horizontal de WebSocket. Lo que el usuario pidió dejar para el final.

> ⚠️ **Stub — última fase del roadmap**.

---

## Pre-requisitos

- ✅ Fase H operando.
- ✅ **Mínimo 6 meses de pedidos en DB** (data histórica para entrenar el modelo).
- ✅ Carga de usuarios suficiente para justificar replica adicional en Railway.

## Resumen de sprints

| Sprint | Tema | Semanas |
|---|---|---|
| I.0 | Pipeline de features para credit risk | 3 |
| I.1 | Modelo v1: scoring por reglas heurísticas | 2 |
| I.2 | Modelo v2: ML real (XGBoost o similar) | 4 |
| I.3 | WebSocket scaling: Redis adapter | 2 |
| I.4 | Checkpoint | — |

## Sub-componentes

### I.0-I.2 — Credit Risk Scoring

**Features pre-calculadas** (tabla `customer_risk_features`, refresh diario via cron):
- Días promedio de pago (de Fase D, datos de orders).
- Tasa de cancelaciones.
- Frecuencia de compra.
- Mix premium vs económico (ticket promedio).
- Tiempo como cliente.
- **Score de ejecución de la tienda** (de Fase C — input de auditorías).
- Geo / zona (proxy para riesgo regional).

**Output**:
- `risk_score` 0-100.
- `credit_limit_suggested`.
- `alert_level` (verde/amarillo/rojo).

**Stack del modelo**:
- **V1** (Sprint I.1): heurísticas con weights manuales en TypeScript. Sin Python.
- **V2** (Sprint I.2): si V1 valida la idea, montar servicio Python con FastAPI + XGBoost. Hosteado en Railway al lado del API. NestJS llama vía HTTP interno.

**Reentrenamiento**: mensual con data nueva.

### I.3 — WebSocket scaling

Cuando Railway corra 2+ replicas del API, Socket.IO deja de funcionar entre ellas. Solución:

```bash
npm install --workspace=apps/api @socket.io/redis-adapter
```

```ts
import { createAdapter } from '@socket.io/redis-adapter';

// En main.ts:
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
```

Validación: dos instancias del API, evento emitido en instancia A → cliente conectado a B lo recibe.

## Entregables clave

- Tabla `customer_risk_features` + cron de refresh.
- Endpoint `GET /risk/score/:customer_id` que retorna scoring.
- Dashboard de credit alerts en admin.
- Workflow: cliente rojo → bloqueo automático de nuevos pedidos hasta revisión.
- WebSocket funcionando con N replicas.

## Dependencias

- Data transaccional (Fase D + 6 meses calendario).
- Fase H usa el credit risk para autorizar líneas de crédito.
- Redis ya operando (de Fase A).

## Métricas

- Precisión del modelo de risk: comparar predicciones vs morosidad real.
- Reducción de cuentas morosas detectadas tarde: -30% objetivo.
- WS broadcasts funcionando entre replicas sin pérdida.

## Referencias

`PLAN_PLATAFORMA_B2B.md` sección 3 — Fase 4 sub-pilar 3.3.
