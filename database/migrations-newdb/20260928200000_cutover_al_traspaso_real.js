/**
 * `[VSO.3]` Los tres cortes que dejaban HUECO se mueven al **traspaso real** del POS.
 *
 * ── Qué se arregla, medido contra prod el 2026-09-28 ────────────────────────────────────────
 * `analytics.v_branch_erp_cutover` declara la fecha desde la cual manda Kepler (`>=`) y hasta la
 * cual manda Wincaja (`<`). En tres sucursales la fecha NO coincidía con el día en que el POS
 * realmente cambió de manos, y el resultado es un **hueco**: días con venta real que **ninguna de
 * las dos piernas publica**. No es doble conteo (eso se ve); es plata que desaparece en silencio.
 *
 *   pareja          Wincaja último   Kepler primero   corte viejo   corte real   días   faltante
 *   01 ← 10 PH      2026-06-26       2026-06-27       2026-07-01    2026-06-27     4    $916,629.73
 *   02 ← 42 Piedad  2025-10-09       2025-01-01 (*)   2025-10-01    2025-10-10     9    $620,201.51
 *   08 ← 30 Abastos 2026-09-18       2026-09-19       2026-09-18    2026-09-19     1    $416,953.32
 *                                                                        TOTAL    14  $1,953,784.56
 *
 * El faltante se midió contra el MEJOR TESTIGO disponible por (almacén, día):
 * `GREATEST(kepler_crudo, wincaja_crudo) − publicado`, o sea lo que el ERP tenía y el reporte no
 * publicó. Dos de los tres huecos ya estaban DECLARADOS en el COMMENT de la columna (`[SB.1]`);
 * **el de La Piedad no lo estaba** y salió de volver a medir.
 *
 * (*) ⚠️ La Piedad es el caso que NO se puede resolver mirando sólo el calendario: Kepler `02`
 * tiene datos desde **2025-01-01**, nueve meses ANTES de que Wincaja `42` dejara de operar. Ahí el
 * corte no describe un hecho, **decide** qué pierna manda en la zona de traslape — y la decisión
 * correcta es la que ya estaba tomada (manda Wincaja mientras fue el POS vivo), sólo que la fecha
 * se puso 9 días antes de tiempo. Con el corte en 10-10, los 307 renglones Kepler previos quedan
 * fuera, incluido un disparo suelto de $14,757 el 10-03 que hoy se publica SOLO — o sea un día que
 * el reporte muestra al 18% de su venta real y que el candado de huecos no podía ver, porque
 * pregunta si el día tiene ALGO publicado, no si tiene lo que le toca.
 *
 * ── Qué NO cambia ───────────────────────────────────────────────────────────────────────────
 * Ningún otro corte se toca (`03/04/05` son `-infinity`, `06` y `07` ya empatan al día). No se
 * toca ninguna vista: las dos leen el resolvedor por `EXISTS` desde `[SB.1]`, así que mover la
 * fila alcanza. Y no se toca el criterio: sigue siendo Kepler `>=` / Wincaja `<`.
 *
 * ── Antes / después, al peso ────────────────────────────────────────────────────────────────
 * Medido ANTES de aplicar (publicado por almacén, universo `v_sellout_daily`):
 *   01 $230,400,514.32 · 02 $47,163,795.96 · 08 $356,515,002.16
 * La migración vuelve a medir DESPUÉS y **aborta si el delta no es el esperado** (± $1 por
 * redondeo): un commit que mueve un número no se cierra sin su antes/después.
 *
 * ⚠️ Esto SE VE en pantalla: el sell-out de esos tres almacenes sube. Es venta real que ya estaba
 * en el ERP y el reporte no mostraba, no un ajuste.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** corte viejo → corte real (el traspaso medido), y el faltante que cierra cada uno. */
const CORTES = [
  { kepler: '01', wincaja: '10', viejo: '2026-07-01', nuevo: '2026-06-27', esperado: 916629.73, nombre: 'Padre Hidalgo' },
  { kepler: '02', wincaja: '42', viejo: '2025-10-01', nuevo: '2025-10-10', esperado: 620201.51, nombre: 'La Piedad' },
  { kepler: '08', wincaja: '30', viejo: '2026-09-18', nuevo: '2026-09-19', esperado: 416953.32, nombre: 'Morelia Abastos' },
];

/**
 * Lo PUBLICADO por almacén, reproduciendo el filtro de las dos piernas de `v_sellout_daily`.
 *
 * ⚠️ Los almacenes se interpolan como una lista de `?` generada por longitud, NO como un array
 * ligado a un solo `?`: knex expande los arrays de `raw` de forma distinta a `whereIn` y el mismo
 * placeholder puede terminar siendo una lista o un valor según el contexto. Acá la lista es una
 * constante de este archivo, así que generar los placeholders es exacto y sigue siendo parametrizado.
 */
const PUBLICADO = (n) => `
  WITH pub AS (
    SELECT k.warehouse_code wc, sum(k.monto) m
      FROM analytics.mv_kepler_sales_daily k
     WHERE k.product_deleted = false AND NOT (k.source_branch = '06' AND k.channel = 'ruta')
       AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                    WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch
                      AND k.business_date >= x.cutover_date)
       AND k.warehouse_code IN (${Array(n).fill('?').join(', ')})
     GROUP BY 1
    UNION ALL
    SELECT vl.warehouse_code, sum(vl.monto)
      FROM analytics.mv_wincaja_sales_daily vl
     WHERE vl.product_deleted = false
       AND (vl.wincaja_only = true
            OR EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                        WHERE x.tenant_id = vl.tenant_id AND x.wincaja_source_branch = vl.source_branch
                          AND vl.business_date < x.cutover_date))
       AND vl.warehouse_code IN (${Array(n).fill('?').join(', ')})
     GROUP BY 1)
  SELECT wc, sum(m)::numeric AS m FROM pub GROUP BY 1`;

async function publicado(knex, almacenes) {
  const { rows } = await knex.raw(PUBLICADO(almacenes.length), [...almacenes, ...almacenes]);
  const m = new Map();
  for (const r of rows) m.set(r.wc, Number(r.m) || 0);
  return m;
}

exports.up = async function (knex) {
  // La transacción toma ROW EXCLUSIVE sobre `wincaja.branches` mientras corren los dos escaneos de
  // medición. Es una tabla de 18 filas y los escaneos son de matvistas (lectura), pero esto corre
  // en horario hábil: si un carril de Wincaja está escribiendo el catálogo, se falla rápido en vez
  // de encolarse detrás nuestro.
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  const almacenes = CORTES.map((c) => c.kepler);

  // ⚠️ La fecha se formatea EN SQL con `to_char`, no en JS. `pg` devuelve un `date` como objeto
  // `Date` y `String(d).slice(0,10)` da **"Wed Jul 01"**, no "2026-07-01" — la aserción de abajo
  // abortó con ese texto la primera vez que se corrió esto. Es la misma trampa de `[LC.16]`, donde
  // además corría el DÍA (un `date` llega a medianoche UTC y en hora MX se renderiza el día anterior).
  const vigentes = await knex('analytics.v_branch_erp_cutover')
    .whereIn('kepler_code', almacenes)
    .select('kepler_code', knex.raw(`to_char(cutover_date, 'YYYY-MM-DD') AS cutover_txt`));
  const porCodigo = new Map(vigentes.map((r) => [r.kepler_code, r.cutover_txt]));

  if (CORTES.every((c) => porCodigo.get(c.kepler) === c.nuevo)) {
    console.log('  los tres cortes ya están en el traspaso real — idempotente, skip.');
    return;
  }
  // Aserción: sólo se mueve lo que este archivo midió. Si un corte ya no es el que se midió,
  // alguien lo cambió por otra razón y pisarlo borraría esa decisión sin dejar rastro.
  for (const c of CORTES) {
    const hoy = porCodigo.get(c.kepler);
    if (hoy !== c.viejo && hoy !== c.nuevo) {
      throw new Error(`ABORT: el corte de ${c.nombre} (${c.kepler}) es ${hoy}; esta migración midió ${c.viejo}. Alguien lo movió — re-medir antes de tocarlo.`);
    }
  }

  const antes = await publicado(knex, almacenes);

  // `analytics.v_branch_erp_cutover` es una VISTA sobre `wincaja.branches` (verificado con
  // pg_get_viewdef el 2026-09-28): la fecha se escribe en su columna `kepler_cutover_date`.
  for (const c of CORTES) {
    const n = await knex('wincaja.branches')
      .where({ tenant_id: TENANT, source_branch: c.wincaja })
      .update({ kepler_cutover_date: c.nuevo });
    if (n !== 1) throw new Error(`ABORT: ${c.nombre}: se esperaba actualizar 1 fila de wincaja.branches (source_branch=${c.wincaja}), se actualizaron ${n}.`);
    console.log(`  ${c.nombre} (${c.kepler}←${c.wincaja}): ${c.viejo} → ${c.nuevo}`);
  }

  const despues = await publicado(knex, almacenes);

  let fallas = 0;
  for (const c of CORTES) {
    const d = (despues.get(c.kepler) || 0) - (antes.get(c.kepler) || 0);
    const ok = Math.abs(d - c.esperado) <= 1;
    console.log(`  ${ok ? '✔' : '✖'} ${c.nombre}: publicado ${(antes.get(c.kepler) || 0).toFixed(2)} → ${(despues.get(c.kepler) || 0).toFixed(2)}  (Δ ${d.toFixed(2)}, esperado ${c.esperado.toFixed(2)})`);
    if (!ok) fallas++;
  }
  if (fallas) {
    throw new Error(`ABORT: ${fallas} sucursal(es) no movieron lo medido. Se revierte: un cambio de cifra sin su antes/después comprobado no se aplica.`);
  }
  console.log(`  total recuperado: $${CORTES.reduce((a, c) => a + c.esperado, 0).toFixed(2)}`);
};

exports.down = async function (knex) {
  for (const c of CORTES) {
    await knex('wincaja.branches')
      .where({ tenant_id: TENANT, source_branch: c.wincaja })
      .update({ kepler_cutover_date: c.viejo });
  }
};
