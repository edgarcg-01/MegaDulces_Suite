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

## La convención (corregida el 2026-10-20)

⛔ **El permiso NO lo puede decir el nombre de la variable**, porque el mismo nombre vive en
todos los entornos con usuarios distintos: en **producción (k3s)** `DATABASE_URL*` lleva el
usuario **con escritura** de la API; en una **máquina de trabajo** llevaba uno de sólo lectura.
Una primera versión de este documento proponía renombrar a `PROD_DB_URL_LECTURA`: medido el
alcance, eran **~700 archivos** (`DATABASE_URL_NEW` sola, 561) más los secretos de k3s, y el
nombre nuevo **mentiría en producción**. Se descartó.

**La convención es por entorno:**

| Entorno | `DATABASE_URL`, `DATABASE_URL_NEW`, `DATABASE_URL_NEW_RUNTIME`, `FLEET_DB_URL` | Para leer producción |
|---|---|---|
| **Producción (k3s)** | pg-prod, usuario **con escritura** de la app (secretos de `ops/k3s/`) | — |
| **Máquina de trabajo** | La base **local de desarrollo** (Docker, `npm run dev:up`) — **nunca** prod | **Sólo `PROD_DB_URL`**, con usuario de **sólo lectura** |

Así, en una máquina de trabajo, **cualquier** nombre `DATABASE_URL*` es seguro por construcción,
y el único camino a prod se llama como lo que es.

## Pendiente (no aplicado — necesita coordinación)

| # | Qué | Por qué no se aplicó todavía |
|---|---|---|
| 1 | El `.env` de la máquina de trabajo: `DATABASE_URL*` y `FLEET_DB_URL` → base local; dejar sólo `PROD_DB_URL` a prod | Varias sesiones usan ese `.env` a la vez: un script que hoy lee prod por `DATABASE_URL_NEW` pasaría a leer la base local sin aviso. Avisar antes |
| 2 | `KEPLER_REPLICA_BASE`: superusuario → usuario de sólo lectura | Hay que **crear** ese usuario en el servidor de réplicas (escritura en prod, la hace Edgar) |
| 3 | Retirar `DB_*` / `NEW_DB_*` por partes | 13 + 2 archivos los leen; revisar uno por uno |
| 4 | Un solo nombre para S3 (`S3_ACCESS_KEY` vs `S3_ACCESS_KEY_ID`) | Toca credenciales de almacenamiento (regla 7) |
| 5 | Quitar `DB_POOL_MAX` del `.env` | Ningún código lo lee; sin riesgo, pero es el `.env` compartido |
