# Comercial › Cartera de ventas

La pantalla del supervisor de ventas (`/comercial/cartera`). Las entradas más nuevas van arriba.

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
