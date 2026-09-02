# Migraciones de `catalogo-kp`

Schemas propios de este app dentro de `KP_CONCENTRADA` (`admin`, `tienda`,
`monitor` — `kp.*` lo llena `database/importers/kepler/concentrate-kepler.js`,
no esto). **No son migraciones Knex del framework de la Suite** — se aplican a
mano, en orden, con `psql` como superusuario `postgres`. Es deliberado: el rol
que usa el app en runtime (`catalogo_kp_runtime`, ver `007_rol_dedicado.sql`)
nunca tiene permiso de DDL, así que no puede alterar su propio schema ni el
de `kp`. No aflojar esa frontera.

```bash
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 001_create_users.sql
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 002_tienda_pedidos.sql
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 003_carrito.sql
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 004_checkout.sql
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 005_envio_y_avisos.sql
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 006_errores_web.sql
psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 007_rol_dedicado.sql
```

`001`–`006` son las migraciones originales del proyecto (`megadulces-api-ready`),
portadas sin cambios — ya deben estar aplicadas en el `KP_CONCENTRADA` de
producción. `007` es nueva de esta migración: crea `catalogo_kp_runtime`, un
rol exclusivo de este app que ya no comparte credencial con el `app_runtime`
de `postgres_platform` (ver `docs/GOTCHAS.md` §24). Aplicar `007` es aditivo —
no toca `app_runtime` — y su aplicación contra el cluster real la confirma
quien administre `.245` antes de ejecutarla.
