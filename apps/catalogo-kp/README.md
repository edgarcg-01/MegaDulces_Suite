# catalogo-kp

Catálogo público, verificador de precios de mostrador y tienda mayorista de
Mega Dulces. Migrado desde el proyecto standalone `megadulces-api-ready`
(NestJS 10, fuera de este monorepo, corriendo hoy en `.163`) hacia este Nx app
(NestJS 11), preservando su lógica y su fuente de datos.

Plan completo, roadmap por sub-sprint y decisiones de arquitectura en
[`docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](../../docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md).

## Qué hay portado (CV.0)

Sólo el módulo `kp` — lectura de `KP_CONCENTRADA` (schema `kp.*`, espejo crudo
del ERP Kepler): catálogo, existencias, ventas, y los dos endpoints públicos
que consumen los verificadores de mostrador (`/api/kp/precio`,
`/api/kp/precios-todos`). Los endpoints que en origen exigían sesión responden
**503** (`PendingAuthGuard`) hasta que CV.1 porte `auth` — no quedan abiertos
por accidente.

`auth`, `catalogo` (tablero interno), `admin` (confirmación de pedidos),
`tienda` (carrito/checkout/cola de trabajos — dinero real, Mercado Pago
pendiente), `monitor`, `salidas`, `dashboard` quedan pendientes, uno por
sub-sprint.

## Correrlo local

Este app **no tiene alternativa Docker**: `KP_CONCENTRADA` vive on-prem en
`192.168.0.245`, sólo alcanzable desde la red de la oficina Mega Dulces. Sin
esa LAN, no arranca (el provider de conexión hace `throw` a propósito — ver
`src/kp-concentrada/kp-concentrada.module.ts`).

```bash
# .env (raíz del monorepo) necesita:
#   DATABASE_URL_KP_CONCENTRADA=postgresql://catalogo_kp_runtime:PASSWORD@192.168.0.245:5432/KP_CONCENTRADA
#   KP_EXCEL_FOLDER=C:\Users\Administrador\DataCenter\DataBases Sucursales\MES GLOBAL

nx build catalogo-kp
nx serve catalogo-kp
```

## Deployment

**On-prem, no Railway** — ninguna base de Kepler es alcanzable desde Railway
(mismo principio ya aceptado para `kepler-consolidado`, ver
`FASE_KV_EXPLOTACION_KEPLER.md` §0, A1). Sigue corriendo en `.163` (o donde
decida operaciones), compilado desde este monorepo. No tiene
`railway.catalogo-kp.json` ni Dockerfile — es el primer app Nx de la Suite sin
ciclo de vida en Railway.

## Rol de base de datos

Usa `catalogo_kp_runtime` (dedicado, ver `sql/007_rol_dedicado.sql`), **no**
`app_runtime` — ese rol es compartido con `postgres_platform` en el mismo
cluster `.245`, y Postgres liga el password al rol del cluster, no a una base
(`docs/GOTCHAS.md` §24).
