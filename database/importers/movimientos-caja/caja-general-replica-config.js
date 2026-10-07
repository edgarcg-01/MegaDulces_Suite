'use strict';
/**
 * CG.9 — configuración de la RÉPLICA CRUDA de la **CAJA GENERAL** (`BDatos.mdb`), el back-end
 * del Access `Control` donde hoy se captura el efectivo (ADR-070).
 *
 * Reemplaza a `import-caja-general.js`, que era un importer (`script → tabla`) contra la regla
 * principal del proyecto. Acá el .mdb entra por el MISMO carril que Wincaja (motor compartido en
 * `lib/access-replicate.js`) y `analytics.caja_general_*` pasa a ser **vista derive-no-copy** sobre
 * la réplica.
 *
 * Destino: DB `caja_general` @ :5433, schema `cg<sucursal>` — mismo criterio que WR (`w30`, `w32`).
 *
 * ⚠️ El archivo vive en una carpeta llamada `Dulceria` (así lo dejó el Access en 2014) y esa RUTA
 * no se toca — pero lo que replicamos es la caja general, y así se llama en todos lados: DB, schema,
 * watermark, latido y variables de entorno.
 *
 * ⚠️ Jet 32-bit + acceso al share ⇒ **on-prem, en `.249`**, igual que los 3 carriles de Wincaja.
 * No puede correr en `md` (Linux) hasta VL.5. Es la misma restricción, no una nueva.
 */
const MDB_BASE = process.env.CAJA_GENERAL_MDB_BASE || 'Z:/Datos';
const REPLICA_URL = process.env.CAJA_GENERAL_REPLICA_URL || 'postgresql://postgres:superoot@localhost:5433/caja_general';
const ADMIN_URL = process.env.CAJA_GENERAL_REPLICA_ADMIN_URL || 'postgresql://postgres:superoot@localhost:5433/postgres';

/**
 * ⭐ RAMAS = **ARCHIVOS FUENTE**, no sucursales. Es la diferencia con WR, y no es cosmética:
 * `import-caja-general.js` no lee UN `.mdb`, lee **CUATRO**, y cada uno alimenta tablas distintas
 * de `analytics.*`. Medido 2026-09-18 (tamaño · último cambio · qué alimenta):
 *
 *   ✅ `20 Comisionistas/Dulceria/BDatos.mdb`        41.7 MB · hoy    → caja_general_movimientos
 *                                                                      caja_general_cuentas
 *   ✅ `20 Comisionistas/MegaDulces/BMovimientosCajas.mdb`
 *                                                    70.5 MB · hoy    → caja_arqueos  ⭐ la del sensor
 *   ⬜ `Movimientos MegaDulces/SI/Base Movimientos SI.mdb`
 *                                                   587.6 MB · 14/09  → caja_ventas_diarias
 *                                                                      caja_depositos
 *                                                                      caja_sucursales_catalog
 *                                                                      caja_bancos_catalog
 *   ⬜ `Movimientos MegaDulces/NO/Base Movimientos NO.mdb`
 *                                                   482.8 MB · hoy    → las mismas, instancia `NO`
 *
 * ⛔ **Por eso el importer NO se puede retirar todavía.** Retirarlo hoy mataría los arqueos y la
 * espina (ventas diarias → depósito bancario). Se retira POR PARTES, a medida que cada archivo
 * tiene su espejo y su vista. Lo que falta está declarado con ⬜, no dibujado como hecho.
 *
 * ⚠️ Las dos instancias `SI`/`NO` suman **1.07 GB** y `NO` estaba ABIERTA (había `.ldb`) al medir.
 * La copia-sombra las soporta, pero un full-scan hash-delta de ese tamaño en cada pasada es un
 * costo que hay que MEDIR antes de agendarlo — no se suman "porque falta la línea".
 *
 * Y siguen existiendo otros `BDatos.mdb` por sucursal, que son alcance aparte (§11.2 de la fase):
 *   · `7 MKT/Dulceria/BDatos.mdb`  1.9 MB · 19/05/2026
 *   · `99 CC/Dulceria/BDatos.mdb`  2.8 MB · 09/09/2026
 *   · `70 Telemarketing/LFLG/Dulceria/BDatos.mdb`  121 MB · 10/08/2026 ← la instancia MATRIZ
 * ⚠️ Sumarlas NO es sólo agregar la línea: cada una trae su propio catálogo de 122 cuentas, así
 * que el mapa HITL de conceptos (CG.10b) se multiplica.
 */
const BRANCHES = [
  { code: '20', schema: 'cg20', name: 'Caja general viva (BDatos)', mdb: `${MDB_BASE}/20 Comisionistas/Dulceria/BDatos.mdb` },
  { code: 'arq20', schema: 'cgarq20', name: 'Arqueos de caja 20 (BMovimientosCajas)', mdb: `${MDB_BASE}/20 Comisionistas/MegaDulces/BMovimientosCajas.mdb` },
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

/**
 * ⭐ LA IDENTIDAD DE `Doctos`, que el origen NO declara — y que hay que declarar porque la tabla
 * **MUTA** (ver `aplicarPkOverride` en `lib/access-replicate.js`).
 *
 * Sin esto el espejo cae en el surrogate `UNIQUE(_row_hash)` con `DO NOTHING`: al prenderse la
 * bandera `Corte` cambia el hash, el UPSERT inserta una fila NUEVA y la vieja se queda. Cada
 * movimiento capturado y cortado el mismo día entraría DOS VECES (~12k/año).
 *
 * Elegir la identidad NO fue obvio, y cada descarte está medido sobre las 116,503 filas reales
 * (2026-09-18):
 *
 *   `(TipoDto, IdDocto)`                       ✖ colapsa. `IdDocto = 0` es un CENTINELA con 120
 *                                                filas (84 gastos + 30 ingresos + 6 depósitos,
 *                                                repartidas en 76/24/6 fechas distintas), y encima
 *                                                el `DMax+1` del Access dejó pares repetidos de
 *                                                verdad (§5.2 de la fase).
 *   `(… , Fecha, HoraD)`                       ✖ **116,502 de 116,503** — queda UNA colisión:
 *                                                `(2, 1536, 2011-11-29, 14:12:45)` son DOS gastos
 *                                                distintos (Yessy $35 cuenta 1007 · Conchita
 *                                                $5,906 cuenta 1005). `_ocurrencia` no los salva:
 *                                                está particionado por hash y ellos tienen hashes
 *                                                distintos. Un espejo que pierde una fila deja de
 *                                                ser espejo.
 *   `(… , Fecha, HoraD, Cuenta)`               ✔ **116,503 de 116,503 — ÚNICA.**
 *
 * Y ninguna de las cinco es de las que mutan: las que cambian después de capturar son `Corte`
 * (2 valores) y `SaldoD` (15,344). Por eso la identidad aguanta la mutación.
 *
 * ⚠️ Si mañana se suman las otras sucursales, **esto se vuelve a medir contra SU corpus**. Que sea
 * única en la 20 no prueba nada sobre la 99 o la 70.
 */
const PK_OVERRIDE = {
  Doctos: ['TipoDto', 'IdDocto', 'Fecha', 'HoraD', 'Cuenta'],

  // ── `0 T Movimientos` (los ARQUEOS, en BMovimientosCajas.mdb) ──────────────────────────────
  // Mismo caso que `Doctos` y misma trampa: Access **no declara PK** (el descubridor devuelve
  // `pk=[]` en las 13 tablas del archivo) y la tabla **MUTA** — `Cancelado` está en `true` en
  // **6,541 de 30,004** filas, y se prende DESPUÉS de capturar. Sin identidad declarada el espejo
  // cae en `UNIQUE(_row_hash)` + `DO NOTHING`: al cancelarse un arqueo cambia el hash, entra una
  // fila NUEVA y la vieja se queda → el arqueo cancelado seguiría contando.
  //
  // Medido sobre las 30,004 filas reales (2026-09-18), no supuesto:
  //   `(ID)`                 ✔ **30,004 de 30,004 — ÚNICA**, y **cero** nulos.
  //   `(Folio)`              ✖ 23,145 de 30,004 — colapsa 6,859. El folio se REUSA.
  //   `(ID, Almacen, Caja)`  ✔ también única, pero las dos extra no aportan: sobra-llave.
  //
  // Coincide con la identidad que ya usaba `import-caja-general.js` (`mov_id = ID`) — o sea que
  // acá el importer estaba BIEN; el que estaba mal era el de `Doctos`.
  '0 T Movimientos': ['ID'],
};

const WM_INVARIANTE = 'la columna de watermark debe ser la PK completa de la tabla';

/** Sin tablas incrementales no hay excepciones que declarar. Se deja por simetría con WR. */
const WM_SIN_PK = {};

/** Devuelve la columna watermark si la tabla es incremental, o null si va por hash-delta. */
function watermarkCol(table) { return INCREMENTAL[table] || null; }

module.exports = {
  BRANCHES, INCREMENTAL, PK_OVERRIDE, watermarkCol, REPLICA_URL, ADMIN_URL, MDB_BASE,
  WM_INVARIANTE, WM_SIN_PK,
};
