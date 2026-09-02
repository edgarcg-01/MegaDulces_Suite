# catalogo-kp

Catálogo público, verificador de precios de mostrador y tienda mayorista de
Mega Dulces. Migrado desde el proyecto standalone `megadulces-api-ready`
(NestJS 10, fuera de este monorepo, corriendo hoy en `.163`) hacia este Nx app
(NestJS 11), preservando su lógica y su fuente de datos.

Plan completo, roadmap por sub-sprint y decisiones de arquitectura en
[`docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](../../docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md).

## Qué hay portado

- **CV.0** — módulo `kp`: lectura de `KP_CONCENTRADA` (schema `kp.*`, espejo
  crudo del ERP Kepler): catálogo, existencias, ventas, y los dos endpoints
  públicos que consumen los verificadores de mostrador (`/api/kp/precio`,
  `/api/kp/precios-todos`).
- **CV.1** — `auth` (JWT propio + bcryptjs sobre `admin.usuarios`) y `admin`
  (CRUD de usuarios del tablero, rol `admin`). Los endpoints de `kp` que
  exigen sesión ya usan `AuthGuard('jwt')` de verdad.

`catalogo` (tablero interno), `tienda` (carrito/checkout/cola de trabajos —
dinero real, Mercado Pago pendiente), `monitor`, `salidas`, `dashboard`
quedan pendientes, uno por sub-sprint. Las rutas `pedidos/pagos/cola` del
`AdminController` original se agregan en CV.5, junto con `tienda` (de la que
dependen) — ver el comentario en `src/admin/admin.controller.ts`.

## Correrlo local

Este app **no tiene alternativa Docker**: `KP_CONCENTRADA` vive on-prem en
`192.168.0.245`, sólo alcanzable desde la red de la oficina Mega Dulces. Sin
esa LAN, no arranca (el provider de conexión hace `throw` a propósito — ver
`src/kp-concentrada/kp-concentrada.module.ts`).

```bash
# .env (raíz del monorepo) necesita:
#   DATABASE_URL_KP_CONCENTRADA=postgresql://catalogo_kp_runtime:PASSWORD@192.168.0.245:5432/KP_CONCENTRADA
#   KP_EXCEL_FOLDER=C:\Users\Administrador\DataCenter\DataBases Sucursales\MES GLOBAL
#   CATALOGO_KP_JWT_SECRET=<propio, NO el JWT_SECRET de la Suite>

nx build catalogo-kp
nx serve catalogo-kp
```

Crear el primer usuario del tablero (no hay seed — igual que en origen, para
no dejar una contraseña en texto plano en el repo):

```sql
-- generar el hash: node -e "require('bcryptjs').hash(process.argv[1],10).then(h=>console.log(h))" "TU_CONTRASENA"
INSERT INTO admin.usuarios (email, nombre, password, rol)
VALUES ('alguien@megadulces.com.mx', 'Nombre', '<hash>', 'admin');
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
