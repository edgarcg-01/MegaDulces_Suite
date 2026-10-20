# Migraciones escritas que todavía NO pueden aplicarse

Knex **no mira esta carpeta** (`knexfile-newdb.js` apunta sólo a `migrations-newdb/`).
Un archivo acá está terminado pero **frenado por un dato que no cuadra**, no por un error
de código. Se vuelve a `migrations-newdb/` **sin cambiarle el nombre** en cuanto su
condición se cumpla, y se aplica con `apply-one-migration-prod.js` como cualquier otra.

Por qué existe esta carpeta: el despliegue es por commit y la compuerta de migraciones
frena a TODO el equipo ante una migración pendiente. Dejar acá la que no puede entrar es
lo que permite que el resto de la fila avance, sin borrar el trabajo de nadie.

⛔ **Al devolver una migración, BORRÁ la copia de acá en el mismo commit.** Una copia que
queda después de volver no es «la que espera»: es una versión VIEJA con el mismo nombre que
la aplicada, y el siguiente que la lea va a diagnosticar contra código que ya no corre.

---

Hoy la carpeta está **vacía**.

## Historial

- `20261006230000_rd_route_photo_fdw.js` — `[RD.34]`. Salió el 2026-10-06 (`7e5dc07cc`)
  porque la ruta 502 no cuadraba (2.19 % contra 1 % de tolerancia). **Volvió a
  `migrations-newdb/` el 2026-10-07, modificada** (`ad3257fc2`), y `analytics.v_rd_route_photo`
  y `mv_rd_route_photo` existen en prod (verificado 2026-10-19). La copia de acá quedó
  olvidada hasta el 2026-10-19, que se borró (`[OPS.LIMPIEZA.1]`).
