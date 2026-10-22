# Comercial › Cartera de ventas

La pantalla del supervisor de ventas (`/comercial/cartera`). Las entradas más nuevas van arriba.

---

## «Asignar rutas» como menú de vendedores y tablero reducido (MCP.3.10–3.11, 2026-10-22)

### El problema

El tablero mostraba más de lo que el supervisor usa (totales, meta, avance, detalle por cliente) y la
asignación eran dos pantallas sueltas (rutas y «Sucursal por ruta») sin ver al vendedor. Además, la ruta se
leía de `vendor_sales_routes`, que la app del vendedor no usa: una vendedora con agenda los 7 días salía «Sin
ruta asignada», y asignar ahí no le cambiaba nada. Y la sucursal no la podía cambiar el supervisor: el
endpoint pedía administrar TODA la cartera.

### La solución

- **Mis vendedores:** Vendedor · Ruta de hoy · Visitados · Venta hoy, con pestañas, orden, fecha y frescura
  «Venta Kepler» en una sola barra.
- **Asignar rutas:** menú de vendedores → **Resumen** (meta de la catorcena contra lo cobrado; sus días: a
  cuántos visitó, pedidos y cobrado) y **Configurar** (ruta de la semana, sucursal de surtido, meta y clientes a
  visitar).

### Cómo se implementó

- `GET commercial/vendor-routes/supervisor/vendor-summary?user_id&date` (`COMMERCIAL_CARTERA_VER`): cada día de
  la catorcena con el mismo `buildDay` del tablero; la venta Kepler en una consulta; su agenda y las rutas que
  se le pueden poner (de su zona y del tipo de quien consulta).
- Ruta = **agenda semanal** (`public.daily_assignments`): se guarda de lunes a domingo con `POST /daily-assignments`
  (`TRADE_ROUTE_PLAN_GESTIONAR`, que `supervisor_ventas` ya tiene). Es un upsert por día: si se corta a la
  mitad, la pantalla dice cuántos días quedaron y reintentar no duplica. Decisión de David: el vendedor tiene
  una ruta toda la semana; sólo el supervisor varía por día (con la elección del día).
- Sucursal: permiso nuevo `COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR`, módulo propio en el editor de perfiles; los
  dos endpoints de sucursal aceptan esa o la de cartera (`@RequireAnyPermission`). Migración
  `20261022131601_grant_sucursal_de_ruta_supervisor` → `supervisor_ventas`.
- La venta Kepler se lee en un SAVEPOINT: si la vista no responde, se declara «Sin medir» en vez de un 500.

### Por qué se hizo así

- La agenda es la ruta que manda (la usan la app del vendedor y el tablero); escribir en otra tabla era
  escribir donde nadie lee.
- Permiso acotado en vez de darle «administrar cartera»: la sucursal de una ruta mueve la existencia que ve
  el vendedor, **la tienda a la que reporta su arqueo** y la sucursal del alta de sus clientes nuevos. Por eso
  hay que avisar a Edgar antes de repartirlo en prod.
- Los clientes a visitar se derivan de la ruta (no se capturan): un número capturado se desincroniza.

---

## Tablero «Mis vendedores» por tipo de ruta (MCP.3.9, 2026-10-22)

### El problema

El supervisor no tenía dónde ver a su equipo: la cartera sólo servía para asignar rutas, la venta estaba en
otras pantallas y por ruta, y no existía una meta por vendedor. Además veía rutas que no le tocan (un supervisor
de Ruta Vecinal veía las de Ruta Directa).

### La solución

«Mis vendedores» (abre por default): por cada vendedor de su equipo, a qué hora inició y terminó su ruta, qué
clientes visitó y cuáles no, su **venta cobrada en Kepler** del día y de la catorcena, su **meta catorcenal**
(la captura el supervisor) y el avance. Cada supervisor ve sólo su tipo de ruta, también al asignar rutas.

### Cómo se implementó

- `GET commercial/vendor-routes/supervisor/board` y `PUT commercial/vendor-routes/supervisor/targets`
  (`USUARIOS_ASIGNAR_RUTA`). Tabla `commercial.vendor_targets` (meta por vendedor y catorcena, sábado de inicio).
- Venta: `analytics.v_kepler_vecinal_sales_docs` por código de ruta (contado U-D-10, con impuestos, sin
  cancelados). Se atribuye a la RUTA. Ruta Directa no tiene venta en Kepler: se declara «Sin medir».
- Alcance (`route-scope.ts`): puesto con depto `ruta_vecinal` → sólo `route_kind='vecinal'`; `ruta_directa` →
  el resto; superadmin/admin → todo.
- Catorcena: dos semanas de nómina sábado → viernes, ancla `CATORCENA_ANCLA = 2026-10-17` (por confirmar).

### Por qué se hizo así

La venta que cuenta es la cobrada (decisión de David); lo que no se puede medir se declara en vez de pintarse
como $0. El alcance vive en el servidor para que no se pueda saltar desde la pantalla.
