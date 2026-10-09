'use strict';
/**
 * `[CP.8.1c]` — **Las reglas se re-claven a las categorías que CB de verdad tiene.**
 *
 * ── ⛔ El error que corrige ─────────────────────────────────────────────────────────────────
 * La semilla de `20261008155000` nació de medir lo que **ContPAQi asienta**, agrupando por sus
 * CONCEPTOS (`PAGO COMBUSTIBLE`, `PAGO ARRENDADORA HMS`, `PAGO RENTA`…) y mirando a qué cuenta
 * de resultado cargan. Esa medición es correcta y sigue valiendo — **el error fue bautizar las
 * reglas con esos nombres como si fueran categorías de la Fase CB.** No lo son.
 *
 * Medido el 2026-10-09 contra prod:
 *
 *     combustible · mant_reparto · renta_muebles   ->  NO EXISTEN en finance.movement_categories
 *     imss_sua · renta · traslado_valores          ->  existen
 *
 * Y el efecto: las 6 reglas cubrían **17 movimientos de 55,648**, y 12 de ellos eran justamente
 * la categoría sin regla. El volumen real de CB vive en `compra_mercancia` (4,749 / $404M),
 * `compra_tarjeta`, `comision_bancaria` y `nomina` — **ninguna tenía regla**.
 *
 * ⭐ La entrada del puente es `finance.movement_categories.code`. Las reglas tienen que estar
 * claveadas a ESO, no a los conceptos del otro lado.
 *
 * ── ⛔ Por qué entran TODAS en `sin_regla` ──────────────────────────────────────────────────
 * Se intentó derivar el mapa categoría→cuenta pareando el movimiento bancario con su póliza por
 * `(fecha, importe)`. **No es confiable, y se midió en vez de suponerlo:**
 *
 *  · Placebo (desfasar la fecha 37 y 91 días): 463 y 453 pares contra 3,371 del pareo real.
 *    Hay señal —7.3× el piso de ruido— pero el piso es 14% de los pares.
 *  · ⚠️ Y el primer intento estaba peor por un error propio: `analytics.gl_polizas` mezcla
 *    **dos fuentes** (`kepler` 110,007 pólizas con plan corto `511`/`601-014`, y `contpaqi`
 *    19,398 con máscara de 10 dígitos). Sin filtrar `source`, el 85% de los pareos traía el plan
 *    de cuentas equivocado.
 *  · Filtrado bien, **sigue sin servir**: `nomina` → "RENTA BIENES INMUEBLES" (22.5%),
 *    `traspaso_entre_cuentas` → renta (76%, y un traspaso no tiene cuenta de resultado), y los
 *    importes son una astilla del volumen real.
 *
 * Una póliza puede traer decenas de renglones de gasto, así que parear por el total del
 * documento no dice cuál de esos renglones corresponde al pago. **El mapa no es derivable con
 * las llaves disponibles** — lo firma el contador, que es lo que la etapa E3 decía desde el
 * principio.
 *
 * ── Qué se conserva, y dónde ────────────────────────────────────────────────────────────────
 * `cuenta_gasto` queda **NULL en las 19** y `confianza_pct` también: un porcentaje al lado de una
 * cuenta vacía se lee como «esta regla está 97.9% confirmada», y no lo está.
 *
 * La evidencia medida viaja en `concepto_medido` como TEXTO. Así el contador ve de dónde salió
 * cada propuesta sin que el sistema la trate como decidida — y aprobar exige escribir la cuenta,
 * que es exactamente el acto que se le está pidiendo.
 *
 * Idempotente. Sin RLS nuevo ni permisos nuevos: sólo datos de un catálogo que nace vacío de
 * decisiones.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const RULES = 'contpaqi.account_rules';

/** Las claveadas a categorías que NO existen en CB. Nacieron el 2026-10-08 y no sirvieron nunca. */
const INVENTADAS = ['combustible', 'mant_reparto', 'renta_muebles'];

/**
 * Las 19 categorías de salida REALES de `finance.movement_categories`, con la evidencia que
 * tenemos para cada una. El texto es para el contador, no para la máquina.
 */
const CATEGORIAS = [
  ['compra_mercancia', 'Compra de mercancía. 4,749 movs / $404M — el volumen más grande de CB. '
    + 'En ContPAQi los pagos a proveedor cargan a la SUBCUENTA del proveedor (5010xxxxxx/5020xxxxxx, '
    + '6,101 cuentas), así que NO es una cuenta fija: es proveedor -> su subcuenta, resoluble por RFC '
    + 'contra analytics.contpaqi_suppliers (3,411, 99.6% con RFC).'],
  ['traspaso_entre_cuentas', 'Traspaso entre cuentas propias. 1,420 movs / $225M. '
    + 'NO tiene cuenta de resultado: es movimiento entre bancos, neto 0, sin P&L. '
    + 'Probablemente no deba asentarse por este puente.'],
  ['nomina', 'Nómina. 2,295 movs / $26.8M. El pareo por importe propuso "RENTA BIENES INMUEBLES" '
    + 'al 22.5% — es ruido, no una propuesta. Sin evidencia utilizable.'],
  ['compra_tarjeta', 'Compra con tarjeta / TPV. 4,016 movs / $7.0M. Pareo: 5200800000 VARIOS al 20.9%. '
    + 'Concentración baja: sin evidencia utilizable.'],
  ['pago_credito', 'Pago de crédito (capital). 798 movs / $4.5M. Es amortización: toca pasivo, '
    + 'no resultado. Sin evidencia.'],
  ['comisiones_venta', 'Comisiones de venta/operación. 414 movs / $2.7M. Sin evidencia utilizable.'],
  ['gasto_admin', 'Gasto administrativo. 1,264 movs / $2.5M. ⚠️ Es un cajón de sastre: sus conceptos '
    + 'de banco son "VIATICOS AARON", "BONO CAPITAN DE MARCA"… Probablemente deba PARTIRSE antes de '
    + 'mapearse. Pareo: 5200530000 SEGUROS Y FIANZAS al 75% sobre 8 cuentas y sólo $142k.'],
  ['comision_bancaria', 'Comisión bancaria. 2,788 movs / $1.1M. Pareo: 5200530000 SEGUROS Y FIANZAS '
    + 'al 91.6% pero sobre 3 cuentas y $10,350 — muestra demasiado chica para concluir.'],
  ['imss_sua', 'IMSS / SUA. 12 movs. ⛔ Medido sobre los conceptos de ContPAQi ("PAGO IMSS, RCV E '
    + 'INFONAVIT"): se reparte entre subcuentas POR SUCURSAL (RCV CEDIS, IMSS CEDIS…) y concentra '
    + 'sólo 10.2%. No se adivina: o se parte por sucursal, o se declara.'],
  ['renta', 'Arrendamiento. 4 movs en CB. ⭐ PROPUESTA con respaldo: en ContPAQi el concepto '
    + '"PAGO RENTA" carga a 5200510001 RENTA BIENES INMUEBLES en el 97.9% del importe. Coinciden el '
    + 'nombre de la categoría, el del concepto y el de la cuenta — pero es una inferencia ENTRE '
    + 'taxonomías, no una medición de esta categoría.'],
  ['traslado_valores', 'Traslado de valores. 1 mov en CB. ⭐ PROPUESTA con respaldo: el concepto '
    + '"PAGO TRASLADO DE EFECTIVO" carga a 5200680000 TRASLADO DE EFECTIVO en el 100%. '
    + 'Mismo nombre en los tres lados.'],
  ['servicios', 'Servicios (luz/agua/teléfono). Pareo: 5200580000 TELEFONO Y COMUNICACIONES al 26.7%. '
    + 'Baja. ⚠️ Probablemente deba partirse por servicio, como ContPAQi ya lo tiene.'],
  ['impuestos', 'Impuestos / SAT. Pareo: 5200090000 2% SOBRE NOMINA al 65.3% sobre 3 cuentas y $88k. '
    + 'Sugiere que la categoría mezcla impuestos distintos.'],
  ['iva_acreditable', 'IVA acreditable. 4,632 movs. ⚠️ NO es un gasto: es el renglón de impuesto que '
    + 'el armador ya pone aparte (1060000000), tomándolo del CFDI. Esta categoría probablemente NO '
    + 'deba generar una póliza propia.'],
  ['compra_factoraje', 'Compra con factoraje. 183 movs / $15.7M. Toca pasivo (201/210 en Kepler). '
    + 'Sin evidencia de cuenta de resultado.'],
  ['pago_factoraje', 'Pago a factoraje. Amortización de crédito: pasivo, no resultado.'],
  ['pension_alimenticia', 'Pensión alimenticia. Retención de nómina: pasivo, no gasto propio.'],
  ['caja_ahorro', 'Caja de ahorro. Sin cuenta Kepler definida tampoco (kepler_account NULL en CB).'],
  ['devolucion_spei', 'Devolución SPEI. Es un reverso: probablemente no genere póliza propia.'],
];

exports.up = async function up(knex) {
  // 1. Fuera las inventadas. Apuntan a categorías inexistentes: no pueden dispararse nunca y
  //    leerlas induce a creer que el puente cubre algo que no cubre.
  await knex(RULES).where({ tenant_id: TENANT }).whereIn('categoria_code', INVENTADAS).del();

  // 2. Las 19 reales, todas DECLARADAS sin regla.
  for (const [code, evidencia] of CATEGORIAS) {
    await knex.raw(
      `INSERT INTO ${RULES}
         (tenant_id, categoria_code, concepto_medido, cuenta_gasto, cuenta_nombre,
          confianza_pct, estado, medido_en)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'sin_regla', DATE '2026-10-09')
       ON CONFLICT (tenant_id, categoria_code) DO UPDATE
         SET concepto_medido = EXCLUDED.concepto_medido,
             -- ⛔ Se vacían a propósito: la semilla anterior había puesto cuenta y porcentaje en
             -- renta, traslado_valores e imss_sua como si estuvieran decididas, y no lo están.
             -- (sin acentos graves acá: esto vive dentro de un template literal y los cortaría)
             cuenta_gasto    = NULL,
             cuenta_nombre   = NULL,
             confianza_pct   = NULL,
             estado          = 'sin_regla',
             medido_en       = DATE '2026-10-09',
             updated_at      = now()`,
      [TENANT, code, evidencia],
    );
  }
};

exports.down = async function down(knex) {
  const codes = CATEGORIAS.map(([c]) => c);
  await knex(RULES).where({ tenant_id: TENANT }).whereIn('categoria_code', codes).del();
};
