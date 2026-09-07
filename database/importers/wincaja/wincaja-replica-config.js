'use strict';
/**
 * Fase WR — configuración de la RÉPLICA CRUDA continua de las bases Wincaja (Access 97 → Postgres).
 * Destino (decisión Edgar 2026-08-18): DB centralizada `wincaja` @ :5433, un schema por sucursal.
 *
 * Credenciales locales del contenedor pgvector-md (:5433, donde viven kepler_md_XX). El password
 * `superoot` es COMPARTIDO y está pendiente de rotar — no hardcodear en scripts que se compartan;
 * override por env cuando toque.
 */
/**
 * ⚠️ `Z:` es una unidad MAPEADA y los mapeos de Windows son POR SESIÓN de login: un servicio, una
 * tarea como SYSTEM o un PM2 levantado en otra sesión puede no verla NUNCA. Preferí una ruta UNC
 * (\\servidor\share\...) en WINCAJA_MDB_BASE — no depende de la sesión. El default queda en Z: por
 * compatibilidad con la box actual; el replicador hace preflight y avisa si no la alcanza.
 */
const MDB_BASE = process.env.WINCAJA_MDB_BASE || 'Z:/Salidas/Bases/Actuales';
const REPLICA_URL = process.env.WINCAJA_REPLICA_URL || 'postgresql://postgres:superoot@localhost:5433/wincaja';
const ADMIN_URL = process.env.WINCAJA_REPLICA_ADMIN_URL || 'postgresql://postgres:superoot@localhost:5433/postgres';

/**
 * Sucursales objetivo. Canindo `50` migró su POS a Kepler `06` (Fase Canindo) → fuera.
 * PH `10` congelada 31/05 → histórico (no continuo).
 * CEDIS Irapuato `00`: hay DOS archivos, pero el bueno es **`… MOV.MDB`** — es la DB COMPLETA y
 *   ACTUAL (catálogo lleno Articulos 15446/Precios 90185 + movimientos MaestroMovAlmacen 3239…).
 *   El `0 BPIRAPUATO.mdb` (sin MOV) es un snapshot de catálogo VIEJO/parcial con movimientos=0 →
 *   se ignora (verificado 2026-08-18). Por eso `w00` se replica solo del MOV.
 * Rutas: se agregan tras probar el loop en 30/32.
 */
const BRANCHES = [
  { code: '30', schema: 'w30', name: 'Morelia Abastos', mdb: `${MDB_BASE}/30 MORELIA ABASTOS.MDB` },
  { code: '32', schema: 'w32', name: 'Morelia Madero', mdb: `${MDB_BASE}/32 MORELIA MADERO.MDB` },
  { code: '00', schema: 'w00', name: 'CEDIS Irapuato', mdb: `${MDB_BASE}/0 BPIRAPUATO MOV.MDB` },
];

/**
 * Carril de LECTURA desde Access (separado del conflict-target de escritura, ver access-mirror.js):
 *  - INCREMENTAL: `SELECT ... WHERE <col> > watermark` — append-only y monótono (barato).
 *  - todo lo demás: full-scan + hash-delta — captura UPDATES (Saldo, Precio, Existencia, Costo…).
 *
 * OJO: MovimientoClientes/MovimientoProveedores NO son incremental (su `Saldo`/`FechaUltimoPago`
 * MUTAN al aplicar pagos) → van por hash-delta aunque parezcan movimientos.
 */
const INCREMENTAL = {
  MaestroMovAlmacen: 'Consecutivo',
  DetallesMovAlmacen: 'Consecutivo',
  PagosDia: 'Consecutivo',
  Arqueos: 'Consecutivo',
  // ⛔ `Cortes` y `Retiros` ESTABAN acá con watermark `Folio` y NO pueden estar — ver
  //    `WM_INVARIANTE` abajo. Su PK es `(Folio, Caja)`: el `Folio` **reinicia por caja**, así que
  //    una marca escalar sobre `Folio` deja CIEGAS a todas las cajas cuyo folio quede por debajo
  //    del máximo global. Medido el 2026-09-07 contra el archivo:
  //      · w30.Cortes  → la marca quedó en 174,815 (caja 70). Las otras **5 de 6 cajas** viven
  //        entre 663 y 7,157 → 162 de 193 filas invisibles; la réplica tenía 110.
  //      · w30.Retiros → marca 88,154 (caja 32). 5 de 6 cajas por debajo → 2,939 de 4,193 filas;
  //        la réplica tenía 2,675 de 4,193.
  //      · w32: Cortes 193 de 226 · Retiros 3,764 de 4,344.
  //    Y no se recuperaba solo: la marca ya estaba en el máximo, así que esas filas **no se iban a
  //    leer nunca más**. Son cortes de caja y retiros de efectivo — dinero. Pasan a hash-delta
  //    (full-scan): 193 y 4,193 filas, el escaneo es barato.
};

/**
 * `[WR.7]` INVARIANTE del carril incremental: **la columna de watermark tiene que ser TODA la
 * identidad de la tabla.** Si la PK tiene un segundo eje, la marca escalar es ciega para los demás
 * valores de ese eje — no "se atrasa": no los vuelve a leer jamás. Lo aplica
 * `watermarkSeguro()` en el replicador, y lo vigila `test-wincaja-replica-fidelidad.js`.
 *
 * Estado medido de las 4 que quedan (PK del espejo en `:5433/wincaja`):
 *   MaestroMovAlmacen  PK (Consecutivo)  == watermark  → OK, probado
 *   Arqueos            PK (Consecutivo)  == watermark  → OK, probado
 *   DetallesMovAlmacen SIN PK                          → ver `WM_SIN_PK`
 *   PagosDia           SIN PK                          → ver `WM_SIN_PK`
 */
const WM_INVARIANTE = 'la columna de watermark debe ser la PK completa de la tabla';

/**
 * Tablas incrementales que el origen declara SIN PK, así que el invariante no se puede *probar*
 * contra la PK. Se permiten sólo declaradas acá con el motivo, y el motivo tiene que ser una razón
 * de por qué la columna es monótona GLOBAL (no por caja, no por día, no por sucursal).
 * Esto no es un permiso: es la deuda escrita con nombre — si el motivo resulta falso, es el mismo
 * agujero que Cortes/Retiros.
 */
const WM_SIN_PK = {
  DetallesMovAlmacen: 'Consecutivo es el número del MOVIMIENTO PADRE (MaestroMovAlmacen), cuya PK '
    + 'sí es (Consecutivo) y es monótona global: el detalle hereda una marca que ya está probada. '
    + 'Riesgo residual declarado: si a un movimiento ya leído se le AGREGAN renglones después, esos '
    + 'renglones quedan por debajo de la marca. No medido.',
  PagosDia: 'Consecutivo propio, monótono global (33,927 filas / 33,927 valores distintos en el '
    + 'corte Actuales de la 30, medido 2026-09-07). Sin segundo eje.',
};

/** Devuelve la columna watermark si la tabla es incremental, o null si va por hash-delta. */
function watermarkCol(table) { return INCREMENTAL[table] || null; }

module.exports = {
  BRANCHES, INCREMENTAL, watermarkCol, REPLICA_URL, ADMIN_URL, MDB_BASE,
  WM_INVARIANTE, WM_SIN_PK,
};
