# Simulación de la bitácora de autorización contra prod, con ROLLBACK (`[GP.A.2]`)

Pedido de Edgar (2026-11-20): «apliquemos una simulación con la BD de producción». Antes de aplicar la migración
`20261120145451_gpa2_bitacora_autorizacion_pedidos.js`, se corre **la migración real** y **las verificaciones de la
bitácora** dentro de UNA transacción de pg-prod que al final se deshace.

```bash
node ops/prod/simulacion-bitacora-autorizacion/simular.js
```

## Qué hace

1. **Foto de antes**, con otra conexión y en sólo lectura: si existe la tabla, la restricción de tipos del interruptor,
   los renglones `autorizacion`, la llave `FINANCE_PEDIDOS_AUTORIZAR` y si la migración ya está en `knex_migrations`
   (si ya está, se niega: esto es para antes de aplicarla).
2. **Una sesión de psql** por `pgprod.sh` en `md`: `BEGIN`, `lock_timeout` 3 s, `statement_timeout` 20 s.
3. **La migración real** (`up`, dos veces: tiene que ser idempotente), con Knex mandando cada sentencia a esa sesión.
4. **`SET LOCAL ROLE app_runtime`** y las verificaciones de `database/tests/_lib/bitacora-autorizacion.js` (las mismas
   de la prueba local), con las sentencias leídas del servicio.
5. **`ROLLBACK`**, y la **foto de después** con otra conexión: tiene que ser idéntica. Si no, sale con código 2.

Cada sentencia lleva un `SAVEPOINT` antes: una prueba negativa (un error esperado) no tira la transacción.
⚠️ `pgprod.sh` se come las diagonales invertidas: una sentencia con diagonal se rechaza antes de mandarse.

`SIM_PSQL_LOCAL="<psql local -At>"` lo corre contra un Postgres desechable, sólo para probar el script.

## Controles del instrumento

- Con `COMMIT` en lugar de `ROLLBACK` (copia mutante, contra un Postgres desechable), el control dice «⛔ CAMBIÓ» y
  sale con código 2.

## Resultado

| Fecha | Resultado |
|---|---|
| 2026-11-20 | **1ª corrida: la migración FALLÓ en prod** y se deshizo: sembraba el interruptor con tope 0, y prod exige vacío o mayor que 0 (`kepler_push_switch_tope_ck`). La base desechable no tenía esa restricción. Arreglo: sin tope = sólo a mano (D-A14). |
| 2026-11-20 | **2ª corrida: 19 de 19**, 89 sentencias en 6.3 s, la llave tocó 45 roles (en true sólo `credito_cobranza`). Control: prod quedó idéntica. |
