# catalogo-kp

Catálogo público, verificador de precios de mostrador y tienda mayorista de
Mega Dulces. Migrado desde el proyecto standalone `megadulces-api-ready`
(NestJS 10, fuera de este monorepo, corriendo hoy en `.163`) hacia este Nx app
(NestJS 11), preservando su lógica.

Plan completo, roadmap por sub-sprint y decisiones de arquitectura en
[`docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md`](../../docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md).

## De dónde lee (CV.22 — cambió)

**`postgres_platform`, schema `kepler_ods.*`.** Hasta CV.21 leía `kp.*` en la
base `KP_CONCENTRADA`; el review del PR #62 lo rechazó porque esa es una copia,
y la regla #1 del proyecto es *cero copias, todo del ODS*.

Las dos tienen la misma forma —`concentrate-kepler.js` arma `kp.<tabla>` como
todas las sucursales `md.*` más una columna `sucursal`, que es exactamente lo
que `replicate-ods-live.js` deja en `kepler_ods.<tabla>`— así que el cambio fue
un rename de schema, no de semántica. El mapeo:

| Antes | Ahora |
|---|---|
| `kp.kdii` (productos) | `kepler_ods.kdii` |
| `kp.kdil` (existencia) | `kepler_ods.kdil` |
| `kp.kdig` / `kdik` (línea, almacén) | `kepler_ods.kdig` / `kdik` |
| `kp.kdm2` (precio cobrado) | `kepler_ods.kdm2` |
| `kp.sync_control` (frescura del ETL) | `analytics.cron_runs` (`cdc_wal_<suc>`) |

Y sus propios `admin.*` / `tienda.*` / `monitor.*` viven en esa misma base, como
migraciones Knex (ver [`sql/README.md`](sql/README.md)).

### ⚠️ Tres tablas todavía no llegan al ODS

`kdie` (familias), `kdif` (subfamilias) y `kdms` (sucursales) **no están en el
set que el CDC embarca a prod**. El launcher `run-ods-live-loop.cmd` lista hoy:

```
kdm1,kdm2,kdij,kdue,kdii,kdil,kdik,kdig,kdib,kdid,kduv,kdud,kdb1,kdco,kdc3,kdpv_folio_caja,kdxd,kdxe,kdc2*
```

Hasta que se les sume `kdie,kdif,kdms` (son catálogos chicos, van por el carril
hash — mismo criterio que el de las tablas de finanzas en
`RUNBOOK_REPLICACION_LOGICA.md` §8.E), las pantallas que los usan quedan vacías:
el árbol familia/subfamilia del catálogo interno y el listado de sucursales.
**Es cambio de operación, no de código, y hay que reiniciar el loop ODS después.**

## Qué hay portado

- **CV.0** — módulo `kp`: catálogo, existencias, ventas, y los dos endpoints
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

```bash
# .env (raíz del monorepo) necesita:
#   DATABASE_URL_NEW=postgresql://app_runtime:PASSWORD@<host>:5432/postgres_platform
#   KP_EXCEL_FOLDER=C:\Users\Administrador\DataCenter\DataBases Sucursales\MES GLOBAL
#   CATALOGO_KP_JWT_SECRET=<propio, NO el JWT_SECRET de la Suite>
#
# Opcionales:
#   CATALOGO_KP_SUCURSAL=03   ← ver "Sucursal del catálogo" abajo
#   CATALOGO_KP_TENANT_ID     ← default = tenant de Mega Dulces

npx knex migrate:latest --knexfile database/knexfile-newdb.js   # una vez
nx build catalogo-kp
nx serve catalogo-kp
```

El provider de conexión hace `throw` en boot si falta `DATABASE_URL_NEW`: es
deliberado — sin base este app no hace nada, y es mejor que reviente al arrancar
a que devuelva 500s intermitentes.

Crear el primer usuario del tablero (no hay seed — igual que en origen, para
no dejar una contraseña en texto plano en el repo):

```sql
-- generar el hash: node -e "require('bcryptjs').hash(process.argv[1],10).then(h=>console.log(h))" "TU_CONTRASENA"
INSERT INTO admin.usuarios (email, nombre, password, rol)
VALUES ('alguien@megadulces.com.mx', 'Nombre', '<hash>', 'admin');
```

## Sucursal del catálogo (decisión abierta)

`kepler_ods.kdii` trae **una fila por producto y por sucursal**. Las consultas
portadas no filtran sucursal, y `KP_CONCENTRADA` tenía la misma forma, así que
eso ya era así antes de CV.22 — el repunte no lo introduce.

El default sigue siendo **no filtrar**, para reproducir exactamente lo que hace
la versión que corre en `.163`. Cuando se confirme contra datos cuántas filas
por código hay realmente y si los precios difieren entre sucursales, se setea
`CATALOGO_KP_SUCURSAL` y queda acotado sin tocar código. **No se cambió a ciegas
porque es el camino del precio.**

## Piezas por caja

Se toman de `analytics.v_product_box_factor` (join canónico
`catalog.products.sku = btrim(kdii.c1)`), no de `kdii.c84` crudo: la vista
arbitra entre override humano, c84, etiquetera y `factor_sale`, y aplica la
guarda anti-pallet. Regla dura del proyecto, ver
[`docs/UNIDADES_DE_MEDIDA.md`](../../docs/UNIDADES_DE_MEDIDA.md). Si esa lectura
falla, se degrada a `c84` y se avisa en el log — el catálogo no se cae.

## Deployment

Con la lectura en `postgres_platform`, **se cae la restricción de LAN** que
tenía este app: ya no depende de una base que sólo se ve desde la oficina. Sigue
sin `railway.catalogo-kp.json` ni Dockerfile hasta que se decida dónde corre;
esa decisión ya no está bloqueada por la red.

## Rol de base de datos

`app_runtime`, el rol de runtime de `postgres_platform` — que ya tiene `USAGE` +
`SELECT` sobre `kepler_ods` desde la migración `20260811120000`. El rol dedicado
`catalogo_kp_runtime` quedó obsoleto: existía porque `KP_CONCENTRADA` y
`postgres_platform` compartían cluster (`docs/GOTCHAS.md` §24), y ahora hay una
sola base. Ver [`sql/README.md`](sql/README.md).
