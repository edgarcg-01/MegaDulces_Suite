# `sql/` — ya no vive acá

Los schemas propios de `catalogo-kp` (`admin`, `tienda`, `monitor`) **pasaron a
migraciones Knex de la Suite** en CV.22, a pedido del review del PR #62. Los
`001`–`006` que estaban en esta carpeta ya no existen: su SQL viaja **verbatim**
(mismo texto, mismos comentarios) dentro de las migraciones, para que haya una
sola fuente de verdad y no dos que se desincronicen.

| Antes (a mano con `psql`) | Ahora (`database/migrations-newdb/`) |
|---|---|
| `001_create_users.sql` | `20260905120000_catalogo_kp_admin_usuarios.js` |
| `002_tienda_pedidos.sql` | `20260905120100_catalogo_kp_tienda_pedidos.js` |
| `003_carrito.sql` | `20260905120200_catalogo_kp_tienda_carrito.js` |
| `004_checkout.sql` | `20260905120300_catalogo_kp_tienda_checkout.js` |
| `005_envio_y_avisos.sql` | `20260905120400_catalogo_kp_tienda_envio_avisos.js` |
| `006_errores_web.sql` | `20260905120500_catalogo_kp_monitor_errores.js` |

Se aplican como cualquier otra migración de la plataforma:

```bash
npx knex migrate:latest --knexfile database/knexfile-newdb.js
```

La frontera que el README viejo pedía no aflojar —que el rol de runtime nunca
tenga DDL— se mantiene: las migraciones las corre quien administra la base, no
el app. Lo que cambia es que ahora quedan versionadas y con su propio registro
en `knex_migrations`, en vez de depender de que alguien se acuerde de correr un
`.sql` a mano.

## `007_rol_dedicado.sql` quedó obsoleto (y por eso se borró)

Creaba `catalogo_kp_runtime`, un rol exclusivo de este app. Existía por una
razón concreta: `KP_CONCENTRADA` y `postgres_platform` vivían en el **mismo
cluster** `.245`, y Postgres liga el password al rol del cluster y no a una base
(`docs/GOTCHAS.md` §24) — compartir `app_runtime` entre las dos habría
compartido credencial.

Con el repunte a `postgres_platform` hay **una sola base**, así que el problema
desaparece: el app usa `app_runtime`, que es su rol de runtime y que ya tiene
`USAGE` + `SELECT` sobre `kepler_ods` desde la migración `20260811120000`. Los
`GRANT` de los `001`–`006` ya apuntaban a `app_runtime`, así que se portaron sin
tocarlos.

Si en algún momento se quiere un rol con menos privilegios para el app público
—que sería razonable, porque hoy `app_runtime` puede escribir en toda la
plataforma— es una tarea de DBA sobre el cluster, no una migración de schema.
