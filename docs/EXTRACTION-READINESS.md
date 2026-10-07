# Aislamiento de módulos & Extraction-readiness

> Resultado del sprint de aislamiento (`[iso.0]`–`[iso.6]`, 2026-06-03). El monolito
> sigue siendo **un solo deployable**, pero los dominios están separados en libs Nx
> con **fronteras enforced por ESLint**. Un import cross-domain ilegal **rompe el lint**.

## Qué resuelve (y qué NO)

| Nivel | Aísla | Estado |
|---|---|---|
| **Código** | Un cambio en un dominio no puede importar/romper otro (compile-time). Reescritura segura tras el barrel. | ✅ **Sí** |
| **Proceso** | Un crash en runtime tumba el proceso Node entero (1 deployable). | ❌ No (requiere deployable separado) |
| **Datos** | Trade usa DB legacy (`KNEX_CONNECTION`); commercial/logistics usan DB nueva (`KNEX_NEW_DB`) — pools y bases distintas. | ⚠️ Parcial (preexistente) |

**Caveat:** sigue siendo 1 proceso. Si commercial lanza un error no manejado, Trade se cae con él. Para "Trade sobrevive aunque otro reviente" hay que extraer el dominio como servicio aparte (las costuras de este sprint lo dejan listo, ver abajo).

## Mapa de libs

```
libs/
  platform-core/   scope:platform  type:data   infra leaf (DB, tenant, ability, auth, guards,
                                                decorators, ai+ai-product-matcher, cloudinary,
                                                constants, schemas, date). Sin deps de dominio.
  contracts/       scope:shared     type:util   eventos + Ports (interfaces) cross-domain. Sin Nest.
  commercial/      scope:commercial type:feature 15 módulos (commercial-* + portal-ai-order +
                                                ticket-extractor + mega-dulces-sync)
  logistics/       scope:logistics  type:feature 10 módulos logistics-*
  trade/           scope:trade      type:feature 11 módulos (capturas, scoring, planogramas,
                                                reports, websocket, stores, visits, users, data…)
  shared-auth/     scope:shared     type:util   (preexistente)
  shared-scoring/  scope:shared     type:util   (preexistente)
apps/
  api/             scope:api  type:app  composition root. Quedan aquí: auth, auth-mt, cron,
                              tenants-admin + el binding de Ports.
  view/            scope:view type:app  frontend (aún no dividido por dominio — diferido).
```

## Reglas de dependencia (en `eslint.config.js`)

- Cada dominio (`commercial`/`logistics`/`trade`) **solo** puede depender de sí mismo + `platform` + `shared`. **Nunca de un hermano.**
- `platform` es leaf: sin deps de dominio. `contracts`/`shared`: sin deps.
- `api` (composition root) compone todos los dominios.
- Verificado con test negativo: `commercial → logistics` rompe el lint.

## Comunicación cross-domain

| Necesidad | Mecanismo | Ejemplo |
|---|---|---|
| Síncrona + **misma transacción** | **Port** (interface en `contracts` + DI inversion, binding en `app.module`) | `logistics` dispara `fulfillInTransaction` de commercial vía `ORDER_FULFILLMENT_PORT` |
| Side-effect / notificación (no atómica) | **Evento** in-process (`@nestjs/event-emitter`), **emitir POST-COMMIT** | (reservado; bus ya cableado) |
| Intra-dominio | Llamada directa | orders↔pricing↔inventory↔alerts (atómico) |

⚠️ **Eventos: emitir SOLO post-commit.** Acumular en un array dentro de `tk.run(...)`, `return`, y emitir después (patrón ya probado en `daily-captures.service.ts`). Emitir dentro de la trx = listener ve fila no commiteada / notifica algo que hace rollback.

## CI con `nx affected`

```bash
nx affected -t lint --base=origin/main --head=HEAD --parallel=3
nx affected -t build --base=origin/main --head=HEAD
```
Si un cambio en `libs/commercial` marca `logistics` como *affected* → hay acoplamiento ilegal que cazar.

## Checklist para extraer un dominio como servicio aparte

Cuando un dominio (ej. `logistics`) necesite escalar/deployar independiente:

```
[ ] `nx graph` muestra deps del dominio = {platform-core, contracts} solamente
[ ] Imports externos solo vía @megadulces/<dominio> (barrel) — sin deep imports
[ ] Sin import de servicio concreto de un dominio hermano (ya enforced por lint)
[ ] Toda necesidad síncrona cross-domain pasa por un Port de @megadulces/contracts
[ ] Todo side-effect cross-domain es un evento de @megadulces/contracts (post-commit)
[ ] El dominio escribe solo su schema namespace (commercial.* / logistics.*)
[ ] Sin moduleRef.get()/string-token cruzando a otro dominio (review manual — el lint no lo ve)
[ ] Reemplazar el binding del Port en app.module por un provider que devuelva un
    cliente HTTP/RPC contra el servicio extraído (logística no se toca)
[ ] Crear apps/<dominio>-api con su main.ts + AppModule que importe la lib del dominio
[ ] Mover/duplicar la conexión DB del dominio a su deployable
```

El punto clave: **el código del dominio no se reescribe**. Solo cambia el binding (in-process → HTTP) en el composition root y se crea un nuevo `apps/<dominio>-api`.

## Estado de cada dominio (2026-06-03)

| Dominio | deps (no-npm) | Listo para extraer |
|---|---|---|
| `commercial` | platform-core | ✅ (sin deps de hermanos) |
| `logistics` | platform-core, contracts | ✅ (dep a commercial invertida vía Port) |
| `trade` | platform-core, shared-scoring | ✅ |

## Pendiente / diferido
- **Verificación runtime**: correr `node database/run-all-tests.js` (con API levantada, `ENABLE_MULTITENANT=true`, `THROTTLE_DISABLED=true`) → debe seguir **19/19 verde**. Vigilar el hook `shipment.close()→fulfill` (única costura DI-invertida con riesgo runtime).
- **Frontend** (`apps/view`): dividir por dominio con el mismo esquema de tags (no hecho).
- **Deuda preexistente**: `no-explicit-any`/`no-unused-vars` en muchos archivos (ya fallaba antes; ortogonal al aislamiento).
- auth/auth-mt/cron/tenants-admin podrían moverse a platform-core (no requerido para el aislamiento).
