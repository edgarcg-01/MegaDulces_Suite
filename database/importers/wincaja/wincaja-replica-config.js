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
  Cortes: 'Folio',
  Retiros: 'Folio',
};

/** Devuelve la columna watermark si la tabla es incremental, o null si va por hash-delta. */
function watermarkCol(table) { return INCREMENTAL[table] || null; }

module.exports = { BRANCHES, INCREMENTAL, watermarkCol, REPLICA_URL, ADMIN_URL, MDB_BASE };
