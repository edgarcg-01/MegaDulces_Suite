'use strict';
/**
 * CG.9 — configuración de la RÉPLICA CRUDA de las bases **Dulcería** (`BDatos.mdb`), el back-end
 * del Access `Control` donde hoy se captura el efectivo (ADR-070).
 *
 * Reemplaza a `import-caja-general.js`, que era un importer (`script → tabla`) contra la regla
 * principal del proyecto. Acá el .mdb entra por el MISMO carril que Wincaja (motor compartido en
 * `lib/access-replicate.js`) y `analytics.caja_general_*` pasa a ser **vista derive-no-copy** sobre
 * la réplica.
 *
 * Destino: DB `dulceria` @ :5433, un schema por sucursal — mismo criterio que WR.
 *
 * ⚠️ Jet 32-bit + acceso al share ⇒ **on-prem, en `.249`**, igual que los 3 carriles de Wincaja.
 * No puede correr en `md` (Linux) hasta VL.5. Es la misma restricción, no una nueva.
 */
const MDB_BASE = process.env.DULCERIA_MDB_BASE || 'Z:/Datos';
const REPLICA_URL = process.env.DULCERIA_REPLICA_URL || 'postgresql://postgres:superoot@localhost:5433/dulceria';
const ADMIN_URL = process.env.DULCERIA_REPLICA_ADMIN_URL || 'postgresql://postgres:superoot@localhost:5433/postgres';

/**
 * Sucursales. Hoy sólo la **20 (Comisionistas)** porque es la única que
 * `import-caja-general.js` leía y la única con la caja general VIVA (medido 2026-09-18:
 * `Doctos` con movimientos de ESE MISMO día).
 *
 * Las otras existen y están listas para sumarse cuando se decida el alcance (§11.2 de la fase):
 *   · `7 MKT/Dulceria/BDatos.mdb`            1.9 MB · último cambio 19/05/2026
 *   · `99 CC/Dulceria/BDatos.mdb`            2.8 MB · 09/09/2026
 *   · `70 Telemarketing/LFLG/Dulceria/BDatos.mdb` 121 MB · 10/08/2026 ← la instancia MATRIZ
 * ⚠️ Sumarlas NO es sólo agregar la línea: cada una tiene su propio catálogo de 122 cuentas, así
 * que el mapa HITL de conceptos (CG.10b) se multiplica.
 */
const BRANCHES = [
  { code: '20', schema: 'd20', name: 'Comisionistas (caja general)', mdb: `${MDB_BASE}/20 Comisionistas/Dulceria/BDatos.mdb` },
];

/**
 * ⛔ **NADA VA POR CARRIL INCREMENTAL, Y ESO ESTÁ MEDIDO.**
 *
 * La tentación evidente es `Doctos: 'IdDocto'` — es un consecutivo, parece monótono. Sería
 * EXACTAMENTE el bug que WR.7 ya pagó con `Cortes`/`Retiros`:
 *
 *   La PK de `Doctos` es **(TipoDto, IdDocto)**, de DOS ejes, y el `IdDocto` **reinicia por tipo**.
 *   Medido contra el archivo el 2026-09-18:
 *     TipoDto=1 (ingresos)  23,174 filas · IdDocto 0 → 23,147   ← $654,706,744.79
 *     TipoDto=2 (gastos)    93,127 filas · IdDocto 0 → 93,041   ← $647,725,753.08
 *     TipoDto=3 (depósitos)    166 filas · IdDocto 0 →    160
 *   Un watermark escalar se pararía en 93,041 (el máximo global, que es de gastos) y **los 23,174
 *   ingresos quedarían invisibles PARA SIEMPRE** — no "atrasados": no se vuelven a leer nunca,
 *   porque la marca ya está en su máximo. Son $654.7M.
 *
 * Y hay un segundo motivo, independiente y suficiente por sí solo: **`Doctos` MUTA**. La bandera
 * `Corte` se prende DESPUÉS de insertar la fila (medido: 116,470 en 1 contra 10 en 0), igual que
 * `SaldoD`. El carril incremental no ve updates por definición.
 *
 * Así que todo va por **hash-delta** (full-scan + md5 por fila, UPSERT sólo si cambió). Costo
 * medido del full-scan: 116,480 filas en `Doctos` — del mismo orden que `Precios` de Wincaja
 * (90,185), que ya corre así. Cadencia baja (carril `hash`), no cada 2 minutos.
 *
 * El motor lo respalda igual: `watermarkSeguro()` DEGRADA a hash-delta cualquier tabla cuya PK
 * tenga más de un eje. O sea que aunque alguien declarara `Doctos` acá por descuido, el invariante
 * lo frenaría y lo avisaría. Esto es el cinturón; aquello los tirantes.
 */
const INCREMENTAL = {};

const WM_INVARIANTE = 'la columna de watermark debe ser la PK completa de la tabla';

/** Sin tablas incrementales no hay excepciones que declarar. Se deja por simetría con WR. */
const WM_SIN_PK = {};

/** Devuelve la columna watermark si la tabla es incremental, o null si va por hash-delta. */
function watermarkCol(table) { return INCREMENTAL[table] || null; }

module.exports = {
  BRANCHES, INCREMENTAL, watermarkCol, REPLICA_URL, ADMIN_URL, MDB_BASE,
  WM_INVARIANTE, WM_SIN_PK,
};
