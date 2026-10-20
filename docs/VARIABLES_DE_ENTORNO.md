# Variables de entorno — qué es cada una, a dónde apunta y con qué permiso

> ⛔ **Este archivo es PÚBLICO (el repo lo es). Nunca lleva un valor real**: ni contraseñas, ni
> tokens, ni usuarios. Sólo nombres, propósito, destino y permiso.
>
> Medido el **2026-10-20** sobre el `.env` de la máquina de trabajo (48 variables) conectándose
> con cada URL en **sólo lectura** y preguntándole a la base `current_user`, `rolsuper` y
> `has_table_privilege`. Re-medir: el script de la sesión PM (`permisos-urls.js`) — o a mano con
> esas tres funciones. **Si este documento y una medición nueva discrepan, gana la medición.**

## Por qué existe

El `.env` acumuló nombres de épocas distintas (base vieja/nueva, Railway/md) y **no dice qué
permiso tiene cada credencial**. Cinco variables apuntan a la **misma** base de producción con el
**mismo** usuario de sólo lectura bajo cinco nombres distintos, y una credencial de
**superusuario** se llama como si fuera una URL más. Eso invita a equivocarse en las dos
direcciones: creer que se puede escribir donde no, o no darse cuenta de que se puede escribir
donde sí.

## Bases de datos

| Variable | Apunta a | Permiso medido | Lo usa | Estado |
|---|---|---|---|---|
| `PROD_DB_URL` | **pg-prod** (`md:5434`, base `railway`, `system_identifier` `7688376744939610156`) | **Sólo lectura** (0 de 788 tablas escribibles) | Scripts de verificación, `check:mig-colisiones` | ✅ **Nombre canónico** para leer prod |
| `DATABASE_URL` | pg-prod, mismo usuario | Sólo lectura | API/Knex en local, scripts | ⚠️ En otros proyectos este nombre es *la base de la app con escritura*. Aquí lee prod. Ver propuesta |
| `DATABASE_URL_NEW` | pg-prod, mismo usuario | Sólo lectura | Smoke tests, scripts heredados de "la base nueva" | ⚠️ **Duplicado** de `PROD_DB_URL` (resto de la migración A.0-multitenant) |
| `DATABASE_URL_NEW_RUNTIME` | pg-prod, mismo usuario | Sólo lectura | Runtime heredado | ⚠️ **Duplicado** |
| `FLEET_DB_URL` | pg-prod, mismo usuario | Sólo lectura | Flota GPS | ⚠️ **Duplicado.** `CLAUDE.md` dice que apunta a Railway: **ya no**, apunta a md |
| `DB_HOST/PORT/NAME/USER/PASSWORD` | `localhost:5433/postgres_platform` | No medido | Código que arma la conexión por partes | ⚠️ **Describe OTRA base** que `DATABASE_URL`. Según qué lea cada script, cae en local o en prod |
| `NEW_DB_HOST/PORT/NAME/USER/PASSWORD` | `localhost:5433/postgres_platform` | No medido | Ídem | ⚠️ Duplicado de `DB_*` |
| **`KEPLER_REPLICA_BASE`** | Servidor de réplicas (`md:5433`, base `postgres`) | ⛔ **SUPERUSUARIO** (`postgres`) | Ingesta / réplicas por sucursal | ⛔ **El riesgo real.** Una credencial de superusuario del servidor con las 8 réplicas, en el `.env` de una máquina de trabajo y con un nombre que no lo dice |
| `KEPLER_PUSH_URL` | `192.168.9.95:5432/md_00` | Usuario propio; **escribe en 2 de 360 tablas** | `kepler-requisition-sink.adapter.ts` (envía requisiciones de reabasto a Kepler) | ⚠️ La fase CA documentó que `md_00` en `.9.95` es **base de prueba, no el CEDIS real**. **Confirmar** si sigue siéndolo: es un camino que **escribe** |
| `DATABASE_URL_KEPLER_CONSOLIDADO` | `localhost:5433/kepler_consolidado` | No medido | Importers de venta (`mart.ventas_enriched`) | ⚠️ La ingesta se mudó a `md` el 2026-09-11. En local hay algo escuchando en 5433, sin identificar |
| `ODS_SOURCE_BASE` | `localhost:5433/postgres` | No medido | Ingesta ODS | ⚠️ Ídem |
| `REDIS_URL` | `localhost:6379` | — | Colas/caché | ⚠️ **Nada escucha** en ese puerto en esta máquina |

## Servicios externos

| Variable | Qué es | Estado |
|---|---|---|
| `JWT_SECRET` | Firma de los tokens de sesión | Secreto. Debe ser distinto por entorno |
| `CLOUDINARY_*` | Imágenes (Cloudinary) | `.env.example` pide además `CLOUDINARY_API_SECRET` y `CLOUDINARY_URL`, que **no** están |
| `S3_*` | Almacenamiento de archivos (`S3_ENDPOINT` = `storageapi.dev`) | `.env.example` usa `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`; el `.env` usa `S3_ACCESS_KEY`/`S3_SECRET_KEY`. **Dos nombres para lo mismo** |
| `ANTHROPIC_API_KEY`, `VOYAGE_*`, `GROQ_API_KEY`, `AI_PRODUCT_MATCH_MAX_ITEMS` | IA (Claude, embeddings Voyage, transcripción Groq) | — |
| `MAPBOX_TOKEN`, `DENUE_TOKEN` | Mapas y directorio INEGI | — |
| `MAGNI_USER/PASS` | GPS de flota (MagniTracking) | `.env.example` tiene además `MAGNI_USER2/PASS2` |
| `WHATSAPP_PROVIDER`, `WHATSAPP_TENANT_ID` | WhatsApp | — |
| `STORE_INGEST_URL` + `STORE_INGEST_KEY` | Envío de tickets de tienda en vivo | ⚠️ Apunta a **Railway** (`megadulces.up.railway.app`), la **producción vieja congelada desde el 23-sep** |
| `FEEDS_INGEST_KEY` | Llave del servicio `feeds-ingest` | No está en `.env.example` |

## Banderas

| Variable | Valor hoy | Qué hace |
|---|---|---|
| `NODE_ENV` | `development` | — |
| `ENABLE_MULTITENANT` | `true` | — |
| `DISABLE_CRONS` | `true` | Evita que una API local corra los `@Cron`. **Debe quedarse en `true` en cualquier máquina de trabajo.** No está en `.env.example` |
| `DB_POOL_MAX` | — | ⚠️ **Ningún código la usa.** Se puede quitar |

## `.env.example` vs `.env`

- `.env.example` tiene **90** variables; el `.env` de trabajo, **48**. De las 48 que faltan, muchas son
  de cosas retiradas (`RAILWAY_*`, `LEGACY_DATABASE_URL`, `TARGET_DB_URL`, `RAILWAY_PGVECTOR_URL`…).
- Seis que el código **sí** usa no están en el ejemplo: `KEPLER_PUSH_URL`, `REDIS_URL`,
  `ODS_SOURCE_BASE`, `FEEDS_INGEST_KEY`, `KEPLER_REPLICA_BASE`, `DISABLE_CRONS`. Un dev nuevo no
  sabe que existen.

## Propuesta de nombres (pendiente de decisión — no aplicada)

Que **el nombre diga el permiso y el destino**:

| Hoy | Propuesto | Por qué |
|---|---|---|
| `PROD_DB_URL`, `DATABASE_URL_NEW`, `DATABASE_URL_NEW_RUNTIME`, `FLEET_DB_URL` (y `DATABASE_URL` en la máquina de trabajo) | **`PROD_DB_URL_LECTURA`** — una sola | Cinco nombres para lo mismo es la trampa |
| `DATABASE_URL` | La base **local de desarrollo** (Docker, `npm run dev:up`), con escritura | Que el nombre estándar nunca lleve a prod |
| `KEPLER_REPLICA_BASE` (superusuario) | **`REPLICAS_DB_URL_LECTURA`** con un usuario de sólo lectura; el superusuario **fuera** del `.env` de trabajo | Nadie necesita superusuario para leer réplicas desde una laptop |
| `DB_*` / `NEW_DB_*` por partes | Retirar; todo por URL | Dos descripciones de la base que no coinciden |
| `S3_ACCESS_KEY` vs `S3_ACCESS_KEY_ID` | Un solo nombre | — |

⛔ Renombrar variables **toca credenciales** (regla 7 de `CLAUDE.md`): requiere autorización
explícita, cambiar el código que las lee **en el mismo commit**, y los manifiestos de `ops/`.
