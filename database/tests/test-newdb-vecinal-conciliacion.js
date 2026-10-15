'use strict';
/**
 * `[VEC.10]` Candado de la conciliación de la vecinal contra el DINERO.
 *
 *   node database/tests/test-newdb-vecinal-conciliacion.js
 *
 * Sólo lee. No escribe una sola fila.
 *
 * ── Qué protege, y por qué cada aserción ────────────────────────────────────────────────────
 *
 * La vecinal se timbra en una caja registradora de la sucursal (`U-D-10` = *"Ticket Contado
 * Caja N"*) y su dinero se cuenta en el arqueo de esa caja. Este candado vigila las cuatro cosas
 * que pueden romper ese enganche **en silencio**:
 *
 *  1. **La forma.** `CREATE OR REPLACE VIEW` NO hereda `security_invoker` ni el `GRANT`. Esta
 *     casa ya perdió uno así y sólo lo vio una aserción de metadata (ADR-057).
 *
 *  2. **La premisa del veredicto.** `faltante`/`sobrante` cuelgan del signo de
 *     `cash_cuts.efectivo_diff`, que es una columna de otra fase. Si alguien invierte esa
 *     convención, la vista llamaría sobrante a un faltante **y nadie lo notaría**.
 *
 *  3. **La premisa de `[VEC.8]`: que `U-D-12` es espejo y no dinero.** De eso depende que el
 *     sell-out esté sobrando 62% y no que la pantalla esté faltando. Se prueba **refutando la
 *     hipótesis contraria**: si el arqueo contara la re-factura, `arqueo_venta` estaría pegado a
 *     `vecinal + refactura`. Se exige que NO lo esté.
 *
 *     ⛔ La primera versión de esta prueba era CIRCULAR — definía "caja pura" por la misma
 *     igualdad que después afirmaba. Un test así pasa siempre.
 *
 *  4. **La cobertura.** Sin arqueo detrás, la vista no cierra nada y se leería como "todo
 *     cuadra". Medido el 2026-10-13: 568 de 569 día-caja = 99.8%.
 *
 * ⚠️ Lo que no se puede medir se reporta `NO MEDIDO`, nunca ✔. Un período sin re-factura no
 * prueba que el arqueo la ignore: prueba que no hubo con qué probarlo.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c';
const GATE_MS = 1000;
const COBERTURA_MIN = 90; // medido 99.8%; por debajo de 90 la vista deja de cerrar nada

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const money = (v) => '$' + Number(v || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const url = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [VEC.10] la vecinal contra el dinero que se contó en SU caja ===\n');
  try {
    // ── 1. Forma ────────────────────────────────────────────────────────────────────────────
    const meta = (await db.raw(
      `SELECT c.relname::text AS vista,
              COALESCE(c.reloptions::text,'') LIKE '%security_invoker%' AS invoker,
              has_table_privilege('app_runtime', c.oid, 'SELECT') AS lee_runtime
         FROM pg_class c
        WHERE c.relnamespace='analytics'::regnamespace
          AND c.relname IN ('v_vecinal_conciliacion','v_vecinal_no_suma')
        ORDER BY 1`)).rows;
    t('las dos vistas existen', meta.length === 2, `encontradas: ${meta.map((m) => m.vista).join(', ') || 'ninguna'}`);
    for (const m of meta) {
      t(`${m.vista}: security_invoker`, m.invoker === true);
      t(`${m.vista}: app_runtime puede leerla`, m.lee_runtime === true);
    }
    if (meta.length !== 2) throw new Error('faltan las vistas: el resto del candado no aplica');

    // ── 2. La premisa del signo de efectivo_diff ────────────────────────────────────────────
    const signo = (await db.raw(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE round(efectivo_diff,2) = round(efectivo_esperado - efectivo_contado,2))::int AS ok
         FROM analytics.cash_cuts
        WHERE efectivo_esperado IS NOT NULL AND efectivo_contado IS NOT NULL`)).rows[0];
    if (!Number(signo.n)) noMedido('efectivo_diff = esperado − contado', 'analytics.cash_cuts sin filas comparables');
    else {
      t(`efectivo_diff es (esperado − contado) en las ${signo.n} filas`, signo.ok === signo.n,
        `${signo.n - signo.ok} filas con la convención invertida: el veredicto faltante/sobrante saldría al revés`);
    }

    // ── 3. Cobertura del arqueo ─────────────────────────────────────────────────────────────
    const cob = (await db.raw(
      `SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE veredicto='sin_arqueo')::int AS sin_arqueo,
              count(DISTINCT warehouse_code)::int AS sucursales,
              round(sum(vecinal),2) AS vecinal
         FROM analytics.v_vecinal_conciliacion WHERE tenant_id = ?`, [T])).rows[0];
    if (!Number(cob.filas)) noMedido('cobertura del arqueo', 'ninguna ruta vecinal vendió: no hay universo');
    else {
      const pct = ((cob.filas - cob.sin_arqueo) / cob.filas) * 100;
      t(`cobertura del arqueo ${pct.toFixed(1)}% sobre ${cob.filas} día-caja (${cob.sucursales} sucursales, ${money(cob.vecinal)})`,
        pct >= COBERTURA_MIN,
        `${cob.sin_arqueo} día-caja sin arqueo: ese dinero no se puede juzgar`);
    }

    // ── 4. ⭐ La premisa de [VEC.8]: el arqueo IGNORA la re-factura ──────────────────────────
    //
    // Se refuta la hipótesis contraria en vez de confirmar la propia. Si el arqueo contara
    // `U-D-12`, `arqueo_venta` estaría a menos de $1 de `vecinal + refactura`.
    const esp = (await db.raw(
      `WITH r AS (
         SELECT c.warehouse_code, c.business_date, c.vecinal, c.arqueo_venta, s.refactura
           FROM analytics.v_vecinal_conciliacion c
           JOIN analytics.v_vecinal_no_suma s
             ON s.warehouse_code = c.warehouse_code AND s.business_date = c.business_date
          WHERE c.tenant_id = ? AND c.arqueo_venta IS NOT NULL
            AND COALESCE(s.refactura,0) > 0
            AND c.veredicto NOT IN ('dia_en_curso','sin_arqueo','arqueo_abierto')
       )
       SELECT count(*)::int AS n,
              count(*) FILTER (WHERE abs(arqueo_venta - vecinal) < abs(arqueo_venta - (vecinal + refactura)))::int AS mas_cerca_ud10,
              count(*) FILTER (WHERE abs(arqueo_venta - (vecinal + refactura)) <= 1)::int AS igual_a_la_suma,
              round(sum(refactura),2) AS refactura
         FROM r`, [T])).rows[0];
    if (!Number(esp.n)) {
      noMedido('el arqueo ignora la re-factura (U-D-12)', 'ningún día-caja con re-factura: no hay con qué probarlo');
    } else {
      t(`el arqueo IGNORA la re-factura: 0 de ${esp.n} día-caja igualan vecinal+U-D-12 (${money(esp.refactura)} en juego)`,
        Number(esp.igual_a_la_suma) === 0,
        `${esp.igual_a_la_suma} día-caja donde el arqueo SÍ iguala la suma: U-D-12 sería dinero y [VEC.8] hay que remedirla`);
      t(`y ${esp.mas_cerca_ud10} de ${esp.n} están más cerca de U-D-10 que de la suma`,
        Number(esp.mas_cerca_ud10) > Number(esp.n) / 2,
        'la mayoría debería parecerse a U-D-10; si no, la caja está mezclando algo más');
    }

    // ── 5. Prueba NEGATIVA: el veredicto tiene que poder dar distinto de "cuadra" ───────────
    //
    // Un semáforo que siempre da verde no es un semáforo. Si el único estado presente fuera
    // `cuadra`, este candado estaría aprobando sin discriminar nada y lo dice.
    const estados = (await db.raw(
      `SELECT veredicto, count(*)::int AS n FROM analytics.v_vecinal_conciliacion
        WHERE tenant_id = ? GROUP BY 1 ORDER BY 2 DESC`, [T])).rows;
    const distintos = estados.filter((e) => e.veredicto !== 'cuadra').length;
    if (!estados.length) noMedido('el veredicto discrimina', 'la vista está vacía');
    else {
      t(`el veredicto discrimina: ${estados.length} estados presentes (${estados.map((e) => `${e.veredicto}:${e.n}`).join(' · ')})`,
        distintos > 0,
        'sólo aparece "cuadra": el veredicto no está separando nada y no se puede confiar en su verde');
    }

    // ── 6. `contado_en_cero` NO se mezcla con `faltante` ────────────────────────────────────
    //
    // Medido el 2026-10-13: 43 cortes declaran CERO efectivo contado habiendo esperado, por
    // $416,406.67. Antes de separarlos, $43,248.56 de los $49,748.27 de "faltante" del período
    // eran turnos que nadie contó. Llamar a eso faltante inventa la causa.
    const cero = (await db.raw(
      `SELECT count(*)::int AS mal
         FROM analytics.v_vecinal_conciliacion
        WHERE tenant_id = ? AND veredicto = 'faltante'
          AND efectivo_contado = 0 AND efectivo_esperado > 0`, [T])).rows[0];
    t('ningún turno con cero contado se publica como "faltante"', Number(cero.mal) === 0,
      `${cero.mal} filas mezclan "nadie contó" con "falta dinero"`);

    // ── 7. La ausencia NUNCA se dibuja como cero (ADR-056) ─────────────────────────────────
    const ceros = (await db.raw(
      `SELECT count(*)::int AS mal
         FROM analytics.v_vecinal_conciliacion
        WHERE tenant_id = ? AND veredicto = 'sin_arqueo'
          AND (arqueo_venta IS NOT NULL OR efectivo_diff IS NOT NULL)`, [T])).rows[0];
    t('sin arqueo ⇒ las cifras del arqueo llegan NULL, no 0', Number(ceros.mal) === 0,
      `${ceros.mal} filas sin arqueo traen un número: se leería como "contaron cero"`);

    // ── 8. El panel tiene que abrir ─────────────────────────────────────────────────────────
    const t0 = Date.now();
    await db.raw(
      `SELECT warehouse_code, caja, business_date, vecinal, arqueo_venta, efectivo_diff, veredicto
         FROM analytics.v_vecinal_conciliacion
        WHERE tenant_id = ? AND business_date >= current_date - 45`, [T]);
    const ms = Date.now() - t0;
    t(`el panel (45 días) responde en ${ms} ms (gate ${GATE_MS} ms)`, ms <= GATE_MS,
      `${ms} ms: por encima del gate deja de poder ser vista`);

    // ── 8b. `[VEC.12.1]` La venta de LA RUTA no es la de su caja ───────────────────────────
    //
    // El detalle de una ruta mostraba `vecinal` —el total de la caja— bajo una columna que el
    // lector leía como suya. Medido el 2026-10-14 sobre abril→octubre: de 735 día-caja-ruta,
    // **310 (42%) comparten caja** y ahí el total infla 5.05× de media, 85.6× en el peor caso.
    // En PH el 14-oct la pantalla decía $18,694 donde `1V001` había vendido $6,662.41.
    const comparte = (await db.raw(
      `WITH r AS (
         SELECT warehouse_code wh, caja, business_date d, route_no, sum(total) ruta
           FROM analytics.v_kepler_vecinal_sales_docs
          WHERE tenant_id = ? AND business_date >= current_date - 180
          GROUP BY 1,2,3,4),
       c AS (SELECT wh, caja, d, count(*) rutas, sum(ruta) caja_total FROM r GROUP BY 1,2,3)
       SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE c.rutas > 1)::int AS compartidas,
              round(max(c.caja_total / NULLIF(r.ruta,0)), 2) AS peor_factor
         FROM r JOIN c ON c.wh = r.wh AND c.caja = r.caja AND c.d = r.d`, [T])).rows[0];

    if (!Number(comparte.compartidas)) {
      noMedido('la venta de la ruta no es la de su caja',
        'en este período ninguna caja la comparten dos rutas: no hay con qué distinguir');
    } else {
      // ⛔ Prueba NEGATIVA: si `vecinal` sirviera como venta de la ruta, el factor sería 1.00 en
      // todas. Se exige que NO lo sea — o sea, que las dos cifras sean realmente distintas.
      t(`la caja NO sirve de proxy de la ruta: ${comparte.compartidas} de ${comparte.filas} día-caja `
        + `comparten caja, factor hasta ${comparte.peor_factor}×`,
        Number(comparte.peor_factor) > 1.01,
        'ninguna caja compartida infla: la columna por ruta no estaría corrigiendo nada');
    }

    // Y la invariante que el endpoint tiene que cumplir: lo de la ruta nunca excede lo de la caja.
    const excede = (await db.raw(
      `WITH r AS (
         SELECT warehouse_code wh, caja::integer caja, business_date d, sum(total) ruta
           FROM analytics.v_kepler_vecinal_sales_docs
          WHERE tenant_id = ? AND business_date >= current_date - 180
          GROUP BY 1,2,3,route_no)
       SELECT count(*)::int AS mal
         FROM r JOIN analytics.v_vecinal_conciliacion c
           ON c.tenant_id = ? AND c.warehouse_code = r.wh AND c.caja = r.caja
          AND c.business_date = r.d
        WHERE r.ruta > c.vecinal + 0.01`, [T, T])).rows[0];
    t('la venta de una ruta nunca excede lo vecinal de su caja', Number(excede.mal) === 0,
      `${excede.mal} filas donde la parte es mayor que el todo: el join de caja está mal`);

    // ── 8c. `[VEC.14]` El NETO: el negocio cuenta sin IVA ni IEPS ──────────────────────────
    //
    // La vista publica `ieps` y `neto` porque `impuesto` sola (= `c14`) deja el IEPS adentro.
    // Las tasas se arbitran con el DINERO, no con la documentación.
    const cols = (await db.raw(
      `SELECT count(*) FILTER (WHERE attname = 'ieps')::int AS tiene_ieps,
              count(*) FILTER (WHERE attname = 'neto')::int AS tiene_neto
         FROM pg_attribute
        WHERE attrelid = 'analytics.v_kepler_vecinal_sales_docs'::regclass
          AND attnum > 0 AND NOT attisdropped`)).rows[0];
    t('la vista canónica publica `ieps` y `neto`',
      Number(cols.tiene_ieps) === 1 && Number(cols.tiene_neto) === 1,
      'sin esas columnas cada consumidor re-deriva el neto y el que netee sólo por IVA se queda corto');

    if (Number(cols.tiene_ieps) !== 1) {
      noMedido('el neto cuadra y el IEPS pesa', 'la migración [VEC.14] no está aplicada acá');
    } else {
      const imp = (await db.raw(
        `SELECT round(sum(total),2) AS bruto, round(sum(impuesto),2) AS iva,
                round(sum(ieps),2) AS ieps, round(sum(neto),2) AS neto,
                count(*)::int AS docs, count(*) FILTER (WHERE ieps > 0)::int AS con_ieps
           FROM analytics.v_kepler_vecinal_sales_docs
          WHERE tenant_id = ? AND business_date >= current_date - 120`, [T])).rows[0];

      // La identidad que la pantalla publica. Tolerancia $1 por el redondeo de presentación.
      const esperado = Number(imp.bruto) - Number(imp.iva) - Number(imp.ieps);
      t(`el neto es bruto − IVA − IEPS: ${Number(imp.neto).toFixed(2)} sobre ${Number(imp.bruto).toFixed(2)}`,
        Math.abs(Number(imp.neto) - esperado) <= 1,
        `la columna neto no reproduce la resta: ${imp.neto} contra ${esperado.toFixed(2)}`);

      /**
       * ⛔ **Prueba NEGATIVA — el atajo que esto existe para impedir.** Si bastara dividir entre
       * 1.16, o netear sólo con `impuesto`, el IEPS sería despreciable. Se exige que NO lo sea.
       * Medido 2026-10-15 sobre jul–oct: **$198,536.34 en 4,585 de 7,253 documentos (63%)**.
       *
       * ⚠️ Si algún período no tuviera IEPS, esto NO pasa a ✔: reporta NO MEDIDO. Un mes sin
       * IEPS no prueba que el atajo sirva — prueba que no hubo con qué refutarlo.
       */
      if (!Number(imp.con_ieps)) {
        noMedido('netear sólo por IVA deja el IEPS adentro (prueba negativa)',
          'ningún documento del período lleva IEPS: no hay con qué distinguir');
      } else {
        const pct = (Number(imp.ieps) / Number(imp.bruto)) * 100;
        t(`prueba negativa: el IEPS NO es despreciable — ${Number(imp.ieps).toFixed(2)} `
          + `(${pct.toFixed(2)}% del bruto) en ${imp.con_ieps} de ${imp.docs} documentos`,
          Number(imp.ieps) > 0 && pct > 0.5,
          'el IEPS es ruido: netear sólo por IVA daría igual y la columna no aporta');
      }

      // ⭐ R2: la tasa se arbitra con el dinero. En los tickets de tasa ÚNICA el IVA tiene que
      //    pegarse a 16% — si no se pega en ninguno, `c14` no es lo que creemos que es.
      const tasa = (await db.raw(
        `SELECT count(*)::int AS n
           FROM analytics.v_kepler_vecinal_sales_docs
          WHERE tenant_id = ? AND business_date >= current_date - 120
            AND impuesto > 0
            AND round(impuesto / NULLIF(total - impuesto, 0), 4) BETWEEN 0.1595 AND 0.1605`, [T])).rows[0];
      t(`\`impuesto\` se comporta como IVA 16% en ${tasa.n} documentos de tasa única`,
        Number(tasa.n) > 0,
        'ningún documento se pega al 16%: la columna no es el IVA y el neto estaría mal');
    }

    // ── 8d. `[VEC.15]` La identidad CABECERA ↔ LÍNEAS, que cierra a centavos ───────────────
    //
    // Edgar: *"¿ya tenemos una conciliación que no haya ninguna diferencia?"*. La había, pero con
    // un renglón sin nombre: la pantalla publica `kdm1.c16` y el sell-out suma `kdm2.c13`, y entre
    // los dos quedaba una diferencia que se rotulaba «prorrateo del descuento» sin demostrarla.
    //
    // ⭐ **El patrón estaba en las filas incorrectas.** De los 22 documentos de sep-2026 que no
    // cuadraban, en TODOS la diferencia excedía al descuento por un factor de 1.07–1.10. Eso es
    // exactamente lo que `ERP_KEPLER` §2.6 ya había decodificado: **`c13` está SIN impuesto y el
    // total está CON impuesto**. La identidad completa es:
    //
    //     Σ kdm2.c13  =  kdm1.c16  +  c13 × (1 + (c14+c15)/(c16−c14−c15))
    //
    // Medido contra prod el 2026-10-15: julio **$0.06** (0 de 1,689 docs fallan) · septiembre
    // **$0.70** (1 de 2,553) · octubre **$0.02** (0 de 1,371). Eso es redondeo, no descuadre.
    //
    // ⛔ **Agosto es la excepción, y NO es la fórmula**: 28 documentos ($26,016.13) del **17-ago**
    // en las sucursales 02 y 05. Ese día la ingesta de `kdm2` llegó incompleta — y el hueco
    // excede a la vecinal: **167 documentos de venta y $45,033.28** sin un solo renglón, de los
    // que sólo el 54% es vecinal. Los días 15, 16, 18 y 19 tienen CERO. Se declara, no se absorbe.
    const EXC = `(btrim(h.sucursal) IN ('02','05') AND h.c9::date = DATE '2026-08-17')`;
    const ident = (await db.raw(
      `WITH d AS (
         SELECT btrim(h.sucursal) s, h.c5::integer cj, btrim(h.c6) f,
                h.c16 total, COALESCE(h.c13,0) dd, COALESCE(h.c14,0) iva, COALESCE(h.c15,0) ieps
           FROM kepler_ods.kdm1 h
          WHERE h.c2='U' AND h.c3='D' AND h.c4::integer=10
            AND btrim(COALESCE(h.c12,'')) ~ '^[0-9]V[0-9]'
            AND btrim(COALESCE(h.c1,'')) = btrim(h.sucursal)
            AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
            AND h.c9::date >= current_date - 60 AND h.c9::date < current_date
            AND NOT ${EXC}),
       l AS (
         SELECT d.s, d.cj, d.f, sum(x.c13) lineas
           FROM d JOIN kepler_ods.kdm2 x
             ON btrim(x.sucursal)=d.s AND x.c2='U' AND x.c3='D' AND x.c4::integer=10
            AND x.c5::integer=d.cj AND btrim(x.c6)=d.f AND btrim(x.c1)=d.s
          GROUP BY 1,2,3)
       SELECT count(*)::int AS docs,
              round(sum(l.lineas - d.total
                   - d.dd*(1+(d.iva+d.ieps)/NULLIF(d.total-d.iva-d.ieps,0))),2) AS residuo,
              count(*) FILTER (WHERE abs(l.lineas - d.total
                   - d.dd*(1+(d.iva+d.ieps)/NULLIF(d.total-d.iva-d.ieps,0))) > 0.02)::int AS fallan,
              round(sum(d.dd),2) AS descuento_neto
         FROM d JOIN l ON l.s=d.s AND l.cj=d.cj AND l.f=d.f`)).rows[0];

    if (!Number(ident.docs)) {
      noMedido('la identidad cabecera ↔ líneas cierra', 'no hay documentos vecinales en los 60 días');
    } else {
      // Tolerancia $5 sobre decenas de miles de documentos: lo medido es $0.02–$0.70 al mes.
      t(`cabecera + descuento con impuesto = líneas en ${ident.docs - ident.fallan} de ${ident.docs} `
        + `documentos · residuo ${Number(ident.residuo).toFixed(2)}`,
        Math.abs(Number(ident.residuo)) <= 5,
        `residuo ${ident.residuo}: la venta vecinal dejó de cuadrar contra sus propios renglones`);

      /**
       * ⛔ **Prueba NEGATIVA — el renglón que esto existe para no volver a dar por bueno.** Si
       * bastara el descuento TAL CUAL (`c13`, sin impuesto), la identidad cerraría igual. Se
       * exige que NO: con el descuento neto el residuo tiene que ser materialmente peor.
       *
       * ⚠️ Si en el período no hubo descuentos, esto NO pasa a ✔ — reporta NO MEDIDO. Un mes sin
       * descuento no prueba que haya que brutearlo: prueba que no hubo con qué distinguirlo.
       */
      if (Math.abs(Number(ident.descuento_neto)) < 1) {
        noMedido('el descuento hay que brutearlo (prueba negativa)',
          'no hubo descuentos en el período: las dos fórmulas dan lo mismo');
      } else {
        const crudo = (await db.raw(
          `WITH d AS (
             SELECT btrim(h.sucursal) s, h.c5::integer cj, btrim(h.c6) f, h.c16 total, COALESCE(h.c13,0) dd
               FROM kepler_ods.kdm1 h
              WHERE h.c2='U' AND h.c3='D' AND h.c4::integer=10
                AND btrim(COALESCE(h.c12,'')) ~ '^[0-9]V[0-9]'
                AND btrim(COALESCE(h.c1,'')) = btrim(h.sucursal)
                AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
                AND h.c9::date >= current_date - 60 AND h.c9::date < current_date
                AND NOT ${EXC}),
           l AS (
             SELECT d.s, d.cj, d.f, sum(x.c13) lineas
               FROM d JOIN kepler_ods.kdm2 x
                 ON btrim(x.sucursal)=d.s AND x.c2='U' AND x.c3='D' AND x.c4::integer=10
                AND x.c5::integer=d.cj AND btrim(x.c6)=d.f AND btrim(x.c1)=d.s
              GROUP BY 1,2,3)
           SELECT round(sum(l.lineas - d.total - d.dd),2) AS residuo
             FROM d JOIN l ON l.s=d.s AND l.cj=d.cj AND l.f=d.f`)).rows[0];
        t(`prueba negativa: con el descuento SIN impuesto el residuo salta a ${Number(crudo.residuo).toFixed(2)}`,
          Math.abs(Number(crudo.residuo)) > 5,
          'las dos fórmulas dan lo mismo: la corrección por impuesto no está probando nada');
      }
    }

    // ── 9. `[VEC.11]` El puente Kepler ↔ Suite CIERRA ──────────────────────────────────────
    //
    // El panel publica una resta: lo que muestra esta pantalla, más el prorrateo del descuento,
    // más el telemarketing, más la re-factura, menos lo que la matvista todavía no refrescó,
    // tiene que dar **lo que el sell-out publica**. Si deja de cerrar, el panel está afirmando
    // una aritmética falsa — y eso es peor que no tener puente.
    //
    // ⛔ Se mide sobre un MES CERRADO, no sobre los últimos 45 días: en el rango que incluye hoy
    // el residuo depende de a qué hora corrió el refresco nocturno, así que un candado así
    // parpadearía por motivos que no son un defecto.
    const mesCerrado = (await db.raw(
      `SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')::date
                                           - interval '1 month'),'YYYY-MM-DD') AS ini,
              to_char((date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')::date)
                       - interval '1 day')::date,'YYYY-MM-DD') AS fin`)).rows[0];

    /** Los cinco sumandos y el destino, con el MISMO corte de fechas. */
    const SQL_PUENTE = `
      WITH so AS (
        SELECT COALESCE(sum(monto),0) AS sellout, max(business_date) AS hasta
          FROM analytics.mv_kepler_sales_daily
         WHERE tenant_id = ?::uuid AND channel = 'preventa'
           AND business_date >= ?::date AND business_date <= ?::date),
      doc AS (
        SELECT COALESCE(sum(total),0) AS pagina FROM analytics.v_kepler_vecinal_sales_docs
         WHERE tenant_id = ?::uuid AND business_date >= ?::date AND business_date <= ?::date),
      lin AS (
        SELECT COALESCE(sum(importe) FILTER (WHERE doc_tipo = 10),0) AS ud10,
               COALESCE(sum(importe) FILTER (WHERE doc_tipo = 8),0) AS tele,
               COALESCE(sum(importe) FILTER (WHERE es_refactura),0) AS espejo,
               COALESCE(sum(importe) FILTER (WHERE business_date > (SELECT hasta FROM so)),0) AS por_refrescar
          FROM analytics.v_kepler_sales_lines
         WHERE tenant_id = ?::uuid AND es_vecinal
           AND business_date >= ?::date AND business_date <= ?::date)
      SELECT doc.pagina, lin.ud10, lin.tele, lin.espejo, lin.por_refrescar, so.sellout,
             round(lin.ud10 + lin.tele + lin.espejo - lin.por_refrescar - so.sellout, 2) AS residuo
        FROM doc, lin, so`;
    const P = [T, mesCerrado.ini, mesCerrado.fin, T, mesCerrado.ini, mesCerrado.fin, T, mesCerrado.ini, mesCerrado.fin];
    const pu = (await db.raw(SQL_PUENTE, P)).rows[0];

    if (!Number(pu.sellout) || !Number(pu.pagina)) {
      noMedido(`el puente Kepler ↔ Suite cierra (${mesCerrado.ini})`,
        'el mes cerrado no tiene venta vecinal o la matvista no lo cubre: no hay con qué probarlo');
    } else {
      // Tolerancia $1: los sumandos se redondean al peso para mostrarse. Medido 2026-10-14 sobre
      // prod: agosto $0.05 · septiembre $0.37. Julio da $327.84 y por eso el panel lo DECLARA.
      t(`el puente cierra en ${mesCerrado.ini.slice(0, 7)}: residuo ${Number(pu.residuo).toFixed(2)} `
        + `(pantalla ${Number(pu.pagina).toFixed(2)} → sell-out ${Number(pu.sellout).toFixed(2)})`,
        Math.abs(Number(pu.residuo)) <= 1,
        `residuo ${pu.residuo}: la resta que el panel publica NO da, y el lector no tiene cómo saberlo`);

      /**
       * ⛔ **Prueba NEGATIVA — el bug que esto existe para impedir.** La primera versión tomaba
       * la re-factura y el telemarketing de `v_vecinal_no_suma`, que agrega la **cabecera**
       * (`c16`), mientras el sell-out está hecho de **líneas** (`c13`). Mezclar granos dejó el
       * puente abierto por $2,762.84 en septiembre, y la cifra se veía razonable.
       *
       * Acá se arma el puente a propósito con el grano equivocado y se exige que NO cierre. Si
       * algún día cerrara, los dos granos coincidirían y esta aserción quedaría vacua — por eso
       * reporta NO MEDIDO en vez de ✔ cuando no hay descuento que prorratear.
       */
      const mal = (await db.raw(`
        WITH so AS (
          SELECT COALESCE(sum(monto),0) AS sellout
            FROM analytics.mv_kepler_sales_daily
           WHERE tenant_id = ?::uuid AND channel = 'preventa'
             AND business_date >= ?::date AND business_date <= ?::date),
        doc AS (
          SELECT COALESCE(sum(total),0) AS pagina FROM analytics.v_kepler_vecinal_sales_docs
           WHERE tenant_id = ?::uuid AND business_date >= ?::date AND business_date <= ?::date),
        ns AS (
          SELECT COALESCE(sum(refactura),0) AS espejo, COALESCE(sum(telemarketing),0) AS tele
            FROM analytics.v_vecinal_no_suma
           WHERE tenant_id = ?::uuid AND business_date >= ?::date AND business_date <= ?::date)
        SELECT round(doc.pagina + ns.tele + ns.espejo - so.sellout, 2) AS residuo
          FROM doc, ns, so`, P)).rows[0];
      const dif = Math.abs(Number(mal.residuo));
      if (dif === 0) {
        noMedido('mezclar cabecera y línea NO cierra (prueba negativa)',
          'en este mes los dos granos coinciden: la prueba no puede distinguir');
      } else {
        t(`prueba negativa: armado con el grano de CABECERA el puente NO cierra (${dif.toFixed(2)})`,
          dif > 1,
          'el puente cierra igual con el grano equivocado: no está probando nada');
      }
    }
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
