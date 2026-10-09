/* eslint-disable no-console */
/**
 * `[RD.57]` CANDADO de la capa de datos de «Rentabilidad por ruta»:
 * `analytics.v_rd_route_km_daily` + `analytics.v_rd_expense_period` + `analytics.fn_expense_family`.
 *
 * ── Lo que vigila, y por qué cada cosa ───────────────────────────────────────────────────
 *
 * **1. ⭐ Las trampas EXISTEN en el dato.** Antes de comprobar que cada guarda funciona, se
 * comprueba que **hay algo que guardar**: que de verdad hay ruta-día con dos aparatos (unidad +
 * dashcam) y que de verdad hay un salto de odómetro. Sin eso, las guardas serían no-ops y un
 * verde se leería igual que «no hay problema». Es la misma lección de `[LC.15]`: *sin sembrado,
 * la puerta es un no-op, y un no-op se lee igual que «no hay duplicados»*.
 *
 * **2. Lo que no se midió sale NULL, nunca 0.** Un `km = 0` significa «el camión reportó y no se
 * movió». `cobertura_insuficiente` y `odometro_reiniciado` tienen que salir con `km IS NULL`
 * (ADR-056). Dibujar 0 ahí convierte una ausencia en un hecho.
 *
 * **3. Un tracker por ruta y día.** La dashcam es un SEGUNDO aparato sobre el MISMO camión y
 * trae su propio odómetro (la 321: 26,810 contra 61,349). Dos filas = kilometraje duplicado.
 *
 * **4. El gasto cuadra al centavo con su fuente.** La vista agrupa y clasifica; no puede perder
 * ni inventar un peso respecto de `analytics.expense_entries`.
 *
 * **5. Una clave de departamento = un nombre.** `CANINDO RD.` y `CANINDO RD` son la misma clave
 * con dos grafías. Agrupar por nombre parte el total en dos **sin avisar**.
 *
 * **6. El grano se DECLARA.** `Canindo 501-505` no tiene GPS y `MORELIA MADERO RD` gasta sin
 * tener rutas en el resolvedor: tienen que salir como ausencia con nombre, no faltar en silencio.
 *
 * **7. PRUEBA NEGATIVA del clasificador.** `fn_expense_family` tiene que separar de verdad: si
 * todo cayera en `otros` el verde no significaría nada. Y se le pasan casos conocidos.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-rentabilidad.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 120000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;

  console.log('\n[RD.57] candado de la capa de datos de rentabilidad por ruta');
  const dest = await q("select current_database() db, inet_server_addr()::text host");
  console.log(`  destino: ${dest[0].db} @ ${dest[0].host || 'local'}\n`);

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('— 0. los objetos existen y respetan el RLS de quien lee —');
  const meta = await q(`select c.relname, c.reloptions::text opts
                          from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname='analytics'
                           and c.relname in ('v_rd_route_km_daily','v_rd_expense_period')`);
  check('existen las dos vistas', meta.length === 2, JSON.stringify(meta.map((m) => m.relname)));
  check('las dos con security_invoker',
    meta.length === 2 && meta.every((m) => (m.opts || '').includes('security_invoker=true')),
    JSON.stringify(meta.map((m) => m.opts)));
  const fn = await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='analytics' and p.proname='fn_expense_family'`);
  check('existe el clasificador compartido fn_expense_family', fn[0].n === 1);

  if (meta.length !== 2) {
    console.log('\n  ⛔ sin las vistas no hay nada más que medir');
    await db.end();
    process.exit(1);
  }

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 1. ⭐ las trampas EXISTEN en el dato (si no, las guardas son no-ops) —');
  const dosAparatos = await q(`select count(*)::int n from analytics.v_rd_route_km_daily
                                where trackers_del_dia > 1`);
  if (dosAparatos[0].n > 0) {
    check('hay ruta-día con DOS aparatos sobre el mismo camión', true, `filas=${dosAparatos[0].n}`);
  } else {
    noMedido('la guarda de la dashcam', 'ninguna ruta tiene dos trackers hoy: no se puede probar');
  }

  const reinicio = await q(`select count(*)::int n from analytics.v_rd_route_km_daily
                             where veredicto = 'odometro_reiniciado'`);
  if (reinicio[0].n > 0) {
    check('hay al menos un salto de odómetro que la banda atrapa', true, `filas=${reinicio[0].n}`);
  } else {
    noMedido('la banda [0,600] del odómetro', 'ningún salto en el dato de hoy: la guarda no se ejerce');
  }

  // El piso de la banda se prueba con el dato: si existiera un factor menor, la banda estaría mal.
  const banda = await q(`select max(km)::int km_max, min(km)::int km_min
                           from analytics.v_rd_route_km_daily where km is not null`);
  check('ningún kilometraje publicado se sale de [0,600]',
    banda[0].km_max === null || (banda[0].km_min >= 0 && banda[0].km_max <= 600),
    JSON.stringify(banda[0]));

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 2. lo no medido sale NULL, nunca 0 —');
  const ver = await q(`select veredicto, count(*)::int filas, count(km)::int con_km
                         from analytics.v_rd_route_km_daily group by 1 order by 1`);
  ver.forEach((r) => console.log(`     ${r.veredicto}: ${r.filas} filas, ${r.con_km} con km`));
  const ausencias = ver.filter((r) => r.veredicto === 'cobertura_insuficiente' || r.veredicto === 'odometro_reiniciado');
  check('cobertura_insuficiente y odometro_reiniciado nunca publican cifra',
    ausencias.every((r) => r.con_km === 0),
    JSON.stringify(ausencias));
  const quieto = ver.find((r) => r.veredicto === 'sin_movimiento');
  check('sin_movimiento SÍ publica cifra (es un 0 medido, no una ausencia)',
    !quieto || quieto.con_km === quieto.filas,
    quieto ? `${quieto.con_km}/${quieto.filas}` : 'sin filas');
  check('las dos ausencias tienen etiquetas distintas',
    new Set(ver.map((r) => r.veredicto)).size >= 2,
    JSON.stringify(ver.map((r) => r.veredicto)));

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 3. un tracker por ruta y día —');
  const dup = await q(`select count(*)::int n from (
      select route_code, dia from analytics.v_rd_route_km_daily
       group by 1,2 having count(*) > 1) x`);
  check('nunca dos filas para la misma ruta y día', dup[0].n === 0, `duplicados=${dup[0].n}`);
  const gano = await q(`select count(*)::int n from analytics.v_rd_route_km_daily
                         where trackers_del_dia > 1 and tracker_nombre ~* 'DASHCAM|[(]CAM[)]'`);
  check('con dos aparatos nunca gana la cámara', gano[0].n === 0, `cámaras elegidas=${gano[0].n}`);

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 4. el gasto cuadra al centavo con su fuente —');
  const vista = await q(`select round(sum(importe)::numeric,2) total, sum(lineas)::int lineas
                           from analytics.v_rd_expense_period`);
  const fuente = await q(`select round(sum(e.importe * case when e.cargo_abono='A' then -1 else 1 end)::numeric,2) total,
                                 count(*)::int lineas
                            from analytics.expense_entries e
                            join commercial.commission_periods p
                              on p.tenant_id = e.tenant_id and e.fecha >= p.date_from and e.fecha <= p.date_to
                           where e.dpto is not null and e.dpto_nombre is not null
                             and btrim(regexp_replace(e.dpto_nombre,'[. ]+$','')) ~ '(^|[^A-Za-z])RD([^A-Za-z]|$)'`);
  check('importe idéntico al centavo',
    Number(vista[0].total) === Number(fuente[0].total),
    `vista ${vista[0].total} vs fuente ${fuente[0].total}`);
  check('mismo número de renglones',
    Number(vista[0].lineas) === Number(fuente[0].lineas),
    `vista ${vista[0].lineas} vs fuente ${fuente[0].lineas}`);

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 5. una clave de departamento = un nombre normalizado —');
  const grafias = await q(`select dpto, count(distinct dpto_norm)::int nombres
                             from analytics.v_rd_expense_period group by 1 order by 1`);
  grafias.forEach((r) => console.log(`     ${r.dpto}: ${r.nombres} nombre(s)`));
  check('ninguna clave trae dos grafías',
    grafias.every((r) => r.nombres === 1), JSON.stringify(grafias));
  // Prueba negativa del colapso: la fuente SÍ tiene más de una grafía por clave.
  const crudas = await q(`select count(*)::int n from (
      select dpto from analytics.expense_entries
       where dpto is not null and dpto_nombre is not null
         and btrim(regexp_replace(dpto_nombre,'[. ]+$','')) ~ '(^|[^A-Za-z])RD([^A-Za-z]|$)'
       group by dpto having count(distinct dpto_nombre) > 1) x`);
  if (crudas[0].n > 0) {
    check('y la fuente SÍ traía claves con varias grafías (la normalización no es un no-op)',
      true, `claves afectadas=${crudas[0].n}`);
  } else {
    noMedido('la normalización de grafías', 'la fuente ya viene limpia: el colapso no se ejerce');
  }

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 6. el grano se declara: lo que no se puede atribuir tiene nombre —');
  const rutasKm = (await q(`select distinct route_code from analytics.v_rd_route_km_daily`)).map((r) => r.route_code);
  const canindoConGps = rutasKm.filter((r) => ['501', '502', '503', '504', '505'].includes(r));
  check('Canindo 501-505 no publica kilometraje (no tiene GPS)',
    canindoConGps.length === 0, `con gps=${canindoConGps.join(',') || 'ninguna'}`);
  const sinPlaza = await q(`select count(*)::int n from analytics.v_rd_expense_period
                             where veredicto_plaza = 'plaza_sin_rutas'`);
  check('el departamento que gasta sin rutas sale declarado, no ausente',
    sinPlaza[0].n > 0, `filas=${sinPlaza[0].n}`);
  const plazaNulaSinVeredicto = await q(`select count(*)::int n from analytics.v_rd_expense_period
                                          where plaza is null and veredicto_plaza <> 'plaza_sin_rutas'`);
  check('no hay plaza nula sin su veredicto', plazaNulaSinVeredicto[0].n === 0);

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 7. PRUEBA NEGATIVA del clasificador de gasto —');
  const casos = [
    ['COMBUSTIBLES VENTAS', null, 'combustible'],
    ['GASOLINA LOGISTICA', null, 'combustible'],
    ['ARRENDAMIENTO VEHICULAR', null, 'vehiculo'],
    ['SEGURO VEHICULOS', null, 'vehiculo'],
    ['LLANTA NUEVA', null, 'vehiculo'],
    ['COMISIONES DE VENTAS', null, 'personal'],
    ['NOMINA BANCOS', null, 'personal'],
    ['GPS', null, 'tecnologia'],
    ['RENTA DE LOCAL', null, 'local'],
    ['VITRINAS VITROLERO Y EXHIBIDOR', null, 'otros'],
  ];
  for (const [concepto, cuenta, esperado] of casos) {
    const r = await q('select analytics.fn_expense_family($1, $2) f', [concepto, cuenta]);
    check(`"${concepto}" → ${esperado}`, r[0].f === esperado, `dio ${r[0].f}`);
  }
  const fams = await q(`select count(distinct familia)::int n,
                               round((sum(importe) filter (where familia='otros')) / nullif(sum(importe),0) * 100, 1) pct_otros
                          from analytics.v_rd_expense_period`);
  check('el clasificador separa de verdad (4+ familias)', fams[0].n >= 4, `familias=${fams[0].n}`);
  check('«otros» no se come la mitad del gasto',
    fams[0].pct_otros === null || Number(fams[0].pct_otros) < 50, `otros=${fams[0].pct_otros}%`);

  // ───────────────────────────────────────────────────────────────────────────────────────
  // `[RD.58]` La serie publica venta por kilómetro, y eso tiene un denominador que puede
  // estar incompleto. Lo que se vigila no es la fórmula: es que la guarda SIRVA.
  console.log('\n— 7b. ⭐ el denominador incompleto: la guarda del $/km —');
  const cobertura = await q(`
    WITH per AS (SELECT id, period_no, date_from, date_to FROM commercial.commission_periods WHERE anio = 2026),
    km AS (
      SELECT per.period_no, k.route_code, sum(k.km)::bigint km, count(*)::int dias_con_senal,
             (per.date_to - per.date_from + 1)::int dias_de_la_quincena
        FROM per JOIN analytics.v_rd_route_km_daily k
          ON k.dia >= per.date_from AND k.dia <= per.date_to
       GROUP BY 1,2,5)
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE dias_con_senal < dias_de_la_quincena)::int parciales,
           count(*) FILTER (WHERE dias_con_senal >= dias_de_la_quincena)::int completas
      FROM km`);
  const cob = cobertura[0];
  console.log(`     ${cob.filas} ruta-quincena · ${cob.completas} completas · ${cob.parciales} parciales`);
  if (cob.parciales > 0) {
    check('⭐ el caso parcial EXISTE en el dato (la guarda no es un no-op)',
      true, `parciales=${cob.parciales}`);
  } else {
    noMedido('la guarda del denominador', 'hoy no hay ninguna quincena con GPS parcial: no se ejerce');
  }

  // ⭐⭐ CONTROL: sin la guarda, el artefacto vuelve. Una guarda cuyo efecto no se puede medir
  // es indistinguible de no tenerla. Se calcula el $/km de las dos formas sobre las MISMAS
  // filas y se exige que la versión sin guarda publique cifras que la guarda descarta.
  const placebo = await q(`
    WITH per AS (SELECT id, period_no, date_from, date_to FROM commercial.commission_periods WHERE anio = 2026),
    lin AS (
      SELECT per.period_no, (per.date_to - per.date_from + 1)::int dias_q, l.route_code, l.subtotal
        FROM per
        JOIN commercial.commission_runs r ON r.period_id = per.id AND r.deleted_at IS NULL
        JOIN commercial.commission_run_lines l
          ON l.run_id = r.id AND l.deleted_at IS NULL AND l.beneficiario = 'chofer'),
    km AS (
      SELECT per.period_no, k.route_code, sum(k.km)::bigint km, count(*)::int dias_senal
        FROM per JOIN analytics.v_rd_route_km_daily k
          ON k.dia >= per.date_from AND k.dia <= per.date_to
       GROUP BY 1,2)
    SELECT
      round(max(li.subtotal / nullif(k.km,0)) FILTER (WHERE k.dias_senal <  li.dias_q), 2) AS peor_parcial,
      round(max(li.subtotal / nullif(k.km,0)) FILTER (WHERE k.dias_senal >= li.dias_q), 2) AS peor_completa,
      count(*) FILTER (WHERE k.dias_senal < li.dias_q AND k.km > 0)::int AS descartadas
      FROM lin li JOIN km k ON k.route_code = li.route_code AND k.period_no = li.period_no`);
  const pb = placebo[0];
  console.log(`     sin guarda el $/km llega a ${pb.peor_parcial} · con guarda el máximo es ${pb.peor_completa}`);
  if (pb.descartadas > 0 && pb.peor_parcial !== null && pb.peor_completa !== null) {
    check('⭐⭐ CONTROL: la guarda descarta cifras más altas que cualquiera que publica',
      Number(pb.peor_parcial) > Number(pb.peor_completa),
      `parcial ${pb.peor_parcial} vs completa ${pb.peor_completa} · ${pb.descartadas} descartadas`);
  } else {
    noMedido('el control de la guarda', 'no hay ruta-quincena parcial CON venta: el efecto no se puede medir');
  }

  // ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n— 8. el costo de leer: la pantalla no puede esperar —');
  const t0 = Date.now();
  await q(`select count(*) from analytics.v_rd_expense_period where anio = 2026`);
  const msG = Date.now() - t0;
  check('v_rd_expense_period de un año responde bajo 1 s', msG < 1000, `${msG} ms`);
  const t1 = Date.now();
  await q(`select count(*) from analytics.v_rd_route_km_daily
            where dia >= current_date - 30`);
  const msK = Date.now() - t1;
  check('v_rd_route_km_daily de 30 días responde bajo 1 s', msK < 1000, `${msK} ms`);

  await db.end();
  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ NO MEDIDO\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
