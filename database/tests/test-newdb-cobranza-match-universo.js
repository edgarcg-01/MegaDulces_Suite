#!/usr/bin/env node
/**
 * [CC.8 · CC.9] «Abonos sin cobro»: qué universo se mira, y cuánto cuesta mirarlo.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **El universo de candidatos NO se filtra por `forma_pago`.** Ese campo es un regex sobre
 *     el concepto capturado a mano, y su cajón `'otro'` —el ELSE, o sea *«el texto no trajo la
 *     palabra»*— se lleva el **70% del dinero cobrado**. Filtrar por él era inferir de un
 *     silencio, y dejaba a 10,469 abonos marcados «sin cobro» teniendo uno.
 *  2. **El cruce tiene señal, medida contra su placebo.** Un cruce por importe sin piso de
 *     ruido no significa nada: acá se corre el mismo cruce con las fechas corridas +90 días
 *     —dentro del rango poblado, no fuera, que es como se subestima el ruido— y se afirma el
 *     **margen**, no el porcentaje suelto.
 *  3. **Responde en menos de 5 s.** La forma anterior (un `EXISTS` correlacionado por fila)
 *     **no terminaba en 5 minutos** ni contra la base en la LAN, porque el planificador estima
 *     la CTE de cobros en `rows=1` cuando trae 24 mil y elige un Nested Loop Anti Join.
 *
 * ⛔ El SQL se lee **del servicio real**, no se copia.
 * ⚠️ Sin datos reporta **NO MEDIDO**, nunca ✔.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'collection-deposits', 'collection-deposits.service.ts');
/** Los tres que el filtro viejo dejaba pasar. Se conservan acá para poder REFUTARLO. */
const CON_FICHA = ['deposito', 'transferencia', 'tarjeta'];
const TOPE_MS = 5000;

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** El SQL VIVO de `listUnmatchedBank()`, con sus constantes resueltas como en el servicio. */
function sqlDelServicio(soloHuerfanos) {
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf('const sql = `', src.indexOf('async listUnmatchedBank'));
  const j = src.indexOf('AS rows`;', i);
  if (i < 0 || j < 0) {
    throw new Error('no se encontró el SQL de listUnmatchedBank en collection-deposits.service.ts '
      + '— este test lee el SQL del servicio a propósito; arreglar el marcador, no copiar el SQL.');
  }
  const chunk = src.slice(i, j + 'AS rows`;'.length);
  const num = (n) => {
    const m = src.match(new RegExp(`const ${n} = ([0-9.]+)`));
    if (!m) throw new Error(`no se pudo leer la constante ${n} del servicio`);
    return Number(m[1]);
  };
  return new Function('cond', 'q', 'limit', 'BANK_TOL', 'BANK_DAYS_BEFORE', 'BANK_DAYS_AFTER',
    `${chunk}\nreturn sql;`)([], { solo_huerfanos: soloHuerfanos }, 300,
    num('BANK_TOL'), num('BANK_DAYS_BEFORE'), num('BANK_DAYS_AFTER'));
}
function aPg(sql) {
  let out = '', n = 0, dentro = false;
  for (const ch of sql) { if (ch === "'") dentro = !dentro; out += (ch === '?' && !dentro) ? `$${++n}` : ch; }
  return out;
}

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 300000 });
  await c.connect();
  const dest = (await c.query('SELECT inet_server_addr()::text h, current_database() d')).rows[0];
  console.log(`\n[CC.8·CC.9] universo y costo del cruce  —  ${dest.h || 'local'}/${dest.d}\n`);

  const hay = (await c.query(
    `SELECT count(*)::int n FROM finance.bank_movements m
       JOIN finance.movement_categories c ON c.id = m.category_id AND c.code = 'cobranza'
      WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND m.amount_in > 0`, [TENANT])).rows[0].n;
  if (!hay) {
    NM('no hay movimientos de banco clasificados como cobranza en esta base: no hay cruce que '
      + 'comprobar. Correr contra una base con los estados de cuenta cargados (Fase CB).');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
    await c.end(); process.exit(0);
  }

  // ── 1. El SQL del servicio no menciona forma_pago en el universo de candidatos ──────────
  console.log('1) El universo de candidatos no filtra por forma_pago');
  const sql = sqlDelServicio(undefined);
  // ⚠️ Se miran las LÍNEAS DE CÓDIGO, no los comentarios: el propio SQL explica en un `--` por
  // qué no filtra, y la primera versión de esta aserción se ponía roja con esa explicación.
  // (El strip es por línea; alcanza porque este SQL no tiene `--` dentro de literales.)
  const codigo = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  !/forma_pago/.test(codigo)
    ? P('ninguna línea de código de listUnmatchedBank filtra por forma_pago')
    : F('el SQL volvió a filtrar por forma_pago: vuelve a mirar el 30% del dinero');

  const fp = (await c.query(`
    SELECT round(COALESCE(sum(monto) FILTER (WHERE forma_pago = 'otro'), 0), 2) otro,
           round(COALESCE(sum(monto), 0), 2) total,
           count(*) FILTER (WHERE forma_pago = 'otro')::int n_otro
      FROM analytics.erp_collections
     WHERE tenant_id = $1 AND cobro_date >= date_trunc('year', current_date)`, [TENANT])).rows[0];
  const pctOtro = Number(fp.total) > 0 ? (100 * Number(fp.otro)) / Number(fp.total) : 0;
  pctOtro > 0
    ? P(`el cajón 'otro' pesa ${pctOtro.toFixed(1)}% del dinero cobrado ($${money(fp.otro)}, ${fp.n_otro} cobros) — `
        + 'eso es lo que el filtro dejaba fuera')
    : NM("hoy ningún cobro cae en 'otro': el filtro viejo no excluiría nada y no hay nada que refutar");

  // ── 2. Responde rápido, y da lo mismo con y sin el corte de huérfanos ──────────────────
  console.log('\n2) El cruce responde, y responde rápido');
  const t0 = Date.now();
  const r1 = (await c.query(aPg(sql), [TENANT, TENANT, TENANT])).rows[0];
  const ms = Date.now() - t0;
  const k = r1.kpis || {};
  ms < TOPE_MS
    ? P(`${ms} ms (tope ${TOPE_MS} ms). La forma anterior —EXISTS correlacionado por fila— no terminaba en 5 min`)
    : F(`${ms} ms: por encima del tope de ${TOPE_MS} ms`);
  console.log(`      abonos sin ligar ${k.abonos} · $${money(k.monto)} · huérfanos ${k.huerfanos} `
    + `(${((100 * k.huerfanos) / (k.abonos || 1)).toFixed(1)}%)`);

  const r2 = (await c.query(aPg(sqlDelServicio('1')), [TENANT, TENANT, TENANT])).rows[0];
  Number(r2.kpis.abonos) === Number(k.abonos) && Number(r2.kpis.huerfanos) === Number(k.huerfanos)
    ? P('el corte «sólo huérfanos» recorta las FILAS, no los KPIs (el total no puede depender del filtro de la lista)')
    : F(`solo_huerfanos cambió los KPIs: ${JSON.stringify(r2.kpis)} contra ${JSON.stringify(k)}`);
  const soloH = (r2.rows || []).filter((x) => x.tiene_candidato).length;
  soloH === 0
    ? P('con «sólo huérfanos» no se cuela ninguna fila que tenga candidato')
    : F(`${soloH} filas con candidato aparecieron en el corte de huérfanos`);

  // ── 3. Señal contra placebo, y la refutación del filtro viejo ──────────────────────────
  console.log('\n3) Señal contra ruido — y qué pasaba con el filtro viejo');
  const dep = (await c.query(`
    SELECT m.movement_date::text f, m.amount_in::float monto
      FROM finance.bank_movements m
      JOIN finance.movement_categories c ON c.id = m.category_id AND c.code = 'cobranza'
     WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND m.amount_in > 0
       AND m.movement_date >= date_trunc('year', current_date)
       AND NOT EXISTS (SELECT 1 FROM finance.bank_recon_matches r WHERE r.bank_movement_id = m.id)`,
    [TENANT])).rows;
  const cob = (await c.query(`
    SELECT ec.cobro_date::text f, ec.monto::float monto, ec.forma_pago
      FROM analytics.erp_collections ec
     WHERE ec.tenant_id = $1 AND ec.cobro_date >= date_trunc('year', current_date)`, [TENANT])).rows;

  if (dep.length < 100 || cob.length < 100) {
    NM(`muy pocos datos para medir señal contra ruido (${dep.length} abonos, ${cob.length} cobros)`);
  } else {
    const dias = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
    const correr = (pool) => {
      const idx = new Map();
      for (const x of pool) { const b = Math.round(x.monto); if (!idx.has(b)) idx.set(b, []); idx.get(b).push(x); }
      let casan = 0;
      for (const d of dep) {
        const b = Math.round(d.monto); let hit = false;
        for (const bb of [b - 1, b, b + 1]) {
          for (const x of (idx.get(bb) || [])) {
            if (Math.abs(x.monto - d.monto) <= 1.0) { const dd = dias(x.f, d.f); if (dd >= -6 && dd <= 1) { hit = true; break; } }
          }
          if (hit) break;
        }
        if (hit) casan++;
      }
      return (100 * casan) / dep.length;
    };
    // ⚠️ El placebo se corre DENTRO del rango poblado. Con un desplazamiento que caiga en meses
    // vacíos el ruido sale artificialmente bajo — ya pasó: +180 d daba 1.1% y el real era 7.6%.
    const shift = (rows, d) => rows.map((x) => ({ ...x, f: new Date(Date.parse(x.f) + d * 86400000).toISOString().slice(0, 10) }));
    const conFicha = cob.filter((x) => CON_FICHA.includes(x.forma_pago));
    const senal = correr(cob), ruido = correr(shift(cob, 90));
    const senalV = correr(conFicha), ruidoV = correr(shift(conFicha, 90));

    senal - ruido > 20
      ? P(`señal ${senal.toFixed(1)}% contra un piso de ruido de ${ruido.toFixed(1)}% → margen ${(senal - ruido).toFixed(1)} pp`)
      : F(`margen de sólo ${(senal - ruido).toFixed(1)} pp: el cruce no se distingue del azar`);
    // ⚠️ NEGATIVA: el filtro viejo tiene que salir MEDIBLEMENTE peor, o quitarlo no probó nada.
    senal - senalV > 10
      ? P(`prueba negativa: con el filtro viejo la señal cae a ${senalV.toFixed(1)}% (margen ${(senalV - ruidoV).toFixed(1)} pp) — `
          + `${(senal - senalV).toFixed(1)} pp menos`)
      : F(`el filtro viejo daba ${senalV.toFixed(1)}% y el nuevo ${senal.toFixed(1)}%: quitarlo no cambió nada medible`);
    // El ruido NO es despreciable: por eso la pantalla propone y el humano liga.
    ruido > 2
      ? P(`el ruido es ${ruido.toFixed(1)}% — o sea que ~1 de cada ${Math.round(100 / ruido)} «candidatos» puede ser azar: `
          + 'la pantalla PROPONE, nunca liga sola')
      : NM(`ruido de ${ruido.toFixed(1)}%: tan bajo que no obliga a nada, pero el auto-ligado sigue prohibido por criterio`);
  }

  // ── 4. [CC.10] El trabajo le llega a alguien, y el que mide tiene quién lo mire ─────────
  console.log('\n4) La bandeja y su latido');
  const SCAN = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
    'collection-deposits', 'cobranza-gap-scanner.service.ts');
  const HEALTH = path.join(__dirname, '..', '..', 'apps', 'api', 'src', 'modules',
    'db-health', 'db-health.service.ts');
  const MEWORK = path.join(__dirname, '..', '..', 'libs', 'trade', 'src', 'lib', 'users', 'me-work.ts');

  /**
   * ⚠️ **Un archivo que no se puede leer es NO MEDIDO, no ✘.** Corriendo dentro del contenedor
   * de prod el código fuente puede no estar montado, y la primera versión de estas aserciones
   * reportaba «falta el latido» —un rojo— cuando lo que faltaba era el archivo. Un rojo falso
   * enseña a ignorar el tablero igual que un verde falso.
   */
  const leer = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  const afirmar = (src, etiqueta, cond, siNo) => {
    if (src === null) { NM(`${etiqueta}: no se pudo leer el fuente desde acá (correr desde el repo)`); return; }
    cond ? P(etiqueta) : F(siNo);
  };

  // ⛔ El latido sin su umbral es verde incondicional: el sensor cae en `cfg ? classify : 'ok'`.
  const scanSrc = leer(SCAN);
  const healthSrc = leer(HEALTH);
  afirmar(scanSrc !== null && healthSrc !== null ? '' : null,
    "el cron 'cobranza_gap' late Y tiene su umbral en CRON_JOBS (sin el umbral, un cron parado se ve verde)",
    /jobKey:\s*'cobranza_gap'/.test(scanSrc || '') && /key:\s*'cobranza_gap'/.test(healthSrc || ''),
    'el scanner no late o le falta su entrada en CRON_JOBS: el cron nacería invisible');

  // ⚠️ Las dos consultas —la de la pantalla y la del scanner— comparten criterio pero NO código.
  // Si una cambia y la otra no, el latido mediría algo distinto de lo que la gente ve.
  afirmar(scanSrc,
    'el scanner usa la misma forma de cruce que la pantalla (cubetas + anti-join de ligados)',
    ['cubeta', 'ligados', 'cobx', "kepler_doc_tipo = 'UA0501'", "c.code = 'cobranza'"]
      .every((t) => (scanSrc || '').includes(t)),
    'el scanner se separó de la pantalla: mediría algo distinto de lo que la gente ve');

  // La bandeja de «Mi trabajo» cuenta EN VIVO, no de finance.findings — ver el porqué allá.
  const meworkSrc = leer(MEWORK);
  const i = (meworkSrc || '').indexOf("id: 'cobranza-abonos-sin-ligar'");
  const bloque = i >= 0 ? meworkSrc.slice(i, i + 2200) : '';
  afirmar(meworkSrc,
    'la bandeja cuenta en vivo sobre bank_movements, no desde finance.findings (que ya murió con 82,377 sin triage)',
    i >= 0 && bloque.includes('finance.bank_movements') && !bloque.includes('finance.findings'),
    'la bandeja volvió a colgarse de finance.findings: reconstruye el cementerio de [SN.18]');

  const t1 = Date.now();
  const band = (await c.query(`
    SELECT count(*) FILTER (WHERE m.recon_status = 'pending')::int abiertas,
           count(*) FILTER (WHERE m.recon_status <> 'pending'
                              AND m.updated_at > now() - interval '30 days')::int cerradas_30d
      FROM finance.bank_movements m
      JOIN finance.movement_categories c ON c.id = m.category_id
     WHERE m.tenant_id = $1 AND c.code = 'cobranza' AND m.amount_in > 10000
       AND m.deleted_at IS NULL AND m.movement_date >= current_date - 45`, [TENANT])).rows[0];
  const msB = Date.now() - t1;
  msB < 1000
    ? P(`la bandeja cuenta en ${msB} ms — corre en cada carga de «Mi trabajo», así que tiene que ser barata`)
    : F(`la bandeja tarda ${msB} ms: es una portada, no un reporte`);
  Number(band.cerradas_30d) > 0
    ? P(`la cola se trabaja: ${band.cerradas_30d} ligados en 30 días contra ${band.abiertas} abiertos`)
    : NM(`0 cerrados en 30 días sobre ${band.abiertas} abiertos — la bandeja nace congelada, y eso es `
        + 'un dato sobre quién la tiene a cargo, no sobre el código');

  // ── 5. [CC.11] El depósito sin cobro puede decir de quién es ───────────────────────────
  console.log('\n5) De quién es un depósito que Kepler no registró');
  const tieneCols = (await c.query(`
    SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema='finance' AND table_name='bank_movements'
       AND column_name IN ('customer_code','customer_nota','customer_declared_by','customer_declared_at')`)).rows[0].n;
  if (Number(tieneCols) !== 4) {
    NM(`falta la migración 20260924210000 (${tieneCols}/4 columnas): no hay dónde declarar el cliente`);
  } else {
    P('las 4 columnas de cliente declarado existen (código, nota, quién y cuándo)');

    // ⛔ El freno que importa: si el UPSERT del importador las incluyera en su `merge()`, un
    // re-import del Excel borraría el trabajo humano SIN avisar. Es el mismo criterio con el
    // que ya se protegen `category_id` y `classified_by`.
    const BANK = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'bank',
      'finance-bank.service.ts');
    if (fs.existsSync(BANK)) {
      const src = fs.readFileSync(BANK, 'utf8');
      const i = src.indexOf("onConflict(['tenant_id', 'client_uuid'])");
      const merge = i >= 0 ? src.slice(i, i + 700) : '';
      i >= 0 && !/customer_code|customer_declared/.test(merge)
        ? P('el UPSERT del importador NO pisa las columnas declaradas por humanos (igual que category_id)')
        : F('el merge() del importador incluye las columnas del cliente: un re-import las borraría en silencio');
    } else {
      NM('no se encontró finance-bank.service.ts para comprobar el merge del importador');
    }

    // La declaración tiene que VIAJAR hasta la pantalla, no sólo existir en la tabla.
    const r5 = (await c.query(aPg(sqlDelServicio('1')), [TENANT, TENANT, TENANT])).rows[0];
    const fila = (r5.rows || [])[0] || {};
    ['customer_code', 'customer_nombre', 'customer_declared_by'].every((k) => k in fila)
      ? P('la consulta de la pantalla devuelve el cliente declarado, su nombre y quién lo dijo')
      : F(`a las filas les faltan campos de cliente: ${Object.keys(fila).join(', ')}`);
    typeof r5.kpis?.con_cliente === 'number'
      ? P(`el KPI «ya con dueño» viaja: ${r5.kpis.con_cliente} de ${r5.kpis.huerfanos} huérfanos`)
      : F('falta el KPI con_cliente');

    // ⚠️ NEGATIVA: un código inventado tiene que ser RECHAZADO. Una declaración falsa se ve
    // igual de firme que una buena, y encima lleva firma.
    const inventado = (await c.query(
      `SELECT count(*)::int n FROM kepler_ods.kdud WHERE btrim(c2) = 'ZZ-NO-EXISTE-9999'`)).rows[0].n;
    Number(inventado) === 0
      ? P('prueba negativa: el código de control no existe en kdud — la validación del servicio tiene contra qué fallar')
      : NM('el código de control existe en el catálogo: no se puede ejercer la validación');
  }

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n✘ ', e.message); process.exit(1); });
