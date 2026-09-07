/* eslint-disable no-console */
/**
 * LC.14 (Fase LC, ADR-052) — Siembra `finance.purchase_book_history` con la lista EXACTA de
 * lo que sí entró al libro de compras histórico, por UUID.
 *
 * Fuente: la hoja **`XML`** del workbook "LIBRO DE COMPRAS", 15,417 renglones con UUID por
 * renglón del libro (llave `# COMPRA` = `mes.N`, la misma de las hojas mensuales). Nadie la
 * había abierto: se creía que el workbook tenía 54 hojas y tiene 58.
 *
 * Para qué: hoy el anti-duplicado es heurístico POR IMPORTE (dos facturas del mismo monto
 * casan igual). Esta hoja lo vuelve **exacto por UUID hasta jul-2026**, que es el cierre
 * definitivo del riesgo de doble registro para todo ese periodo.
 *
 * Es un sembrado **ONE-OFF, no un feed**. De aquí en adelante la prueba exacta la va a dar
 * ContPAQi mismo (LC.15: leer de vuelta el UUID que ponemos en el Concepto del movimiento).
 * Correrlo dos veces es idempotente — UPSERT por `(tenant_id, source, source_key)`.
 *
 * ── Los cuatro auto-chequeos ──────────────────────────────────────────────────────────────
 * Bloquean `--apply` si no pasan, y es la diferencia entre un seeder y una bomba. El riesgo
 * de fondo: **el workbook es mutable**. Si la contadora agrega `AGO26` a la hoja, sembrar a
 * ciegas deja el histórico corto y SUB-PROTEGE en silencio — el peor modo de falla, porque
 * un límite de cobertura invisible se ve igual que "no hay riesgo".
 *
 * Flags: --apply · --file <ruta del xlsx> · --force (salta el chequeo de totales) ·
 *        --allow-invalid (siembra aunque haya UUID malformados)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const ExcelJS = require('exceljs');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const ALLOW_INVALID = process.argv.includes('--allow-invalid');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; };
const XLSX = arg('--file', process.env.LIBRO_COMPRAS_XLSX || 'C:/Users/Sistemas/Desktop/LIBRO DE COMPRAS 2026-.xlsx');
const SOURCE = 'historico_xlsx';

/**
 * Lo medido el 2026-09-03 corriendo esto mismo. Si el archivo se movió de aquí, hay que
 * volver a mirarlo antes de sembrar.
 *
 * Ojo `filas`: son los renglones con UUID **válido**, no las filas de la hoja. La hoja tiene
 * 15,417 renglones; 296 no traen UUID y 10 lo traen roto.
 */
const ESPERADO = {
  filas: 15121, uuids: 15120, total: 2015523050.81, desde: '2022-01', hasta: '2026-07',
  // Defectos CONOCIDOS del workbook, medidos. Se bloquea ante la SORPRESA, no ante lo que
  // ya se miró: un chequeo que siempre truena enseña a pasarle --force sin leerlo.
  malformados: 10,   // UUID rotos, casi todos de ABR23 (ver la reparación más abajo)
  repetidos: 1,      // DA573CB9-… en JUL23.152 y SEP23.194: doble registro real, $133,073.28
};
const TOLERANCIA = 0.005; // 0.5%

const RE_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const txt = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((x) => x.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
};
const num = (v) => {
  if (v && typeof v === 'object' && v.result !== undefined) return Number(v.result) || 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** La fecha viene como texto ISO o como Date, según el renglón. Las dos. */
const mesDe = (...vals) => {
  for (const v of vals) {
    if (v instanceof Date) return v.toISOString().slice(0, 7);
    const m = txt(v).match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
};

(async () => {
  console.log(`▸ hoja XML de ${XLSX}\n`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('XML');
  if (!ws) { console.error('ERROR: el workbook no tiene hoja "XML".'); process.exit(1); }

  const filas = [];
  const malos = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const uuidCrudo = txt(row.getCell(13).value).trim();
    const compra = txt(row.getCell(2).value).trim();
    if (!uuidCrudo && !compra) continue;
    if (!RE_UUID.test(uuidCrudo)) {
      if (uuidCrudo) malos.push({ fila: r, compra, uuid: uuidCrudo.slice(0, 44) });
      continue;
    }
    filas.push({
      source_key: compra || `fila.${r}`,
      cfdi_uuid: uuidCrudo.toUpperCase(),
      anio_mes: mesDe(row.getCell(4).value, row.getCell(3).value),
      emisor_rfc: txt(row.getCell(5).value).trim().toUpperCase().slice(0, 13) || null,
      folio: txt(row.getCell(12).value).trim().slice(0, 60) || null,
      importe: num(row.getCell(11).value),
    });
  }

  const uuids = new Set(filas.map((f) => f.cfdi_uuid));
  const total = filas.reduce((a, f) => a + f.importe, 0);
  const meses = [...new Set(filas.map((f) => f.anio_mes).filter(Boolean))].sort();
  console.log(`  ${filas.length} renglones · ${uuids.size} UUID distintos · ${total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`);
  console.log(`  rango ${meses[0]} → ${meses[meses.length - 1]} (${meses.length} meses)\n`);

  // ── Chequeo 1: ¿es el archivo que se midió? ───────────────────────────────────────────
  let bloquea = false;
  const fuera = (a, b) => Math.abs(a - b) / Math.max(b, 1) > TOLERANCIA;
  const movido = fuera(filas.length, ESPERADO.filas) || fuera(uuids.size, ESPERADO.uuids)
    || fuera(total, ESPERADO.total) || meses[meses.length - 1] !== ESPERADO.hasta;
  if (movido) {
    console.log('  ⚠ EL ARCHIVO SE MOVIÓ respecto de lo que se midió el 2026-09-03:');
    console.log(`      filas  ${filas.length} vs ${ESPERADO.filas}`);
    console.log(`      UUID   ${uuids.size} vs ${ESPERADO.uuids}`);
    console.log(`      total  ${total.toFixed(2)} vs ${ESPERADO.total}`);
    console.log(`      hasta  ${meses[meses.length - 1]} vs ${ESPERADO.hasta}`);
    console.log('      Si la contadora agregó un mes, esto es correcto y hay que actualizar ESPERADO.');
    console.log('      Corre con --force cuando lo hayas mirado.');
    if (!FORCE) bloquea = true;
  } else {
    console.log('  ✓ el archivo cuadra con lo medido (filas, UUID, total y último mes)');
  }

  // ── Chequeo 2: forma del UUID ─────────────────────────────────────────────────────────
  if (malos.length > ESPERADO.malformados) {
    console.log(`\n  ⚠ ${malos.length} renglones con UUID malformado — se esperaban ${ESPERADO.malformados}. Hay ${malos.length - ESPERADO.malformados} nuevos:`);
    malos.slice(0, 8).forEach((m) => console.log(`      fila ${m.fila} (${m.compra}): "${m.uuid}"`));
    if (!ALLOW_INVALID) bloquea = true;
  } else if (malos.length) {
    console.log(`  ✓ ${malos.length} UUID malformados, los ${ESPERADO.malformados} conocidos (se omiten): ${malos.map((m) => m.compra).join(', ')}`);
  } else {
    console.log('  ✓ todos los UUID tienen forma válida');
  }
  const sinMes = filas.filter((f) => !f.anio_mes);
  if (sinMes.length) {
    console.log(`\n  ⚠ ${sinMes.length} renglón(es) sin mes legible — se omiten (la columna anio_mes es NOT NULL)`);
  }

  // ── Chequeo 3: duplicados de UUID ─────────────────────────────────────────────────────
  const porUuid = new Map();
  for (const f of filas) porUuid.set(f.cfdi_uuid, (porUuid.get(f.cfdi_uuid) ?? 0) + 1);
  const repetidos = [...porUuid.entries()].filter(([, n]) => n > 1);
  if (repetidos.length) {
    // No es un problema del seeder: es un hallazgo. El libro manual registró la misma
    // factura dos veces, y la PK por source_key hace que sobrevivan como evidencia.
    const montoDup = filas.filter((f) => porUuid.get(f.cfdi_uuid) > 1).reduce((a, f) => a + f.importe, 0);
    const nuevos = repetidos.length > ESPERADO.repetidos;
    console.log(`\n  ${nuevos ? '⚠' : '·'} ${repetidos.length} UUID aparecen más de una vez en el libro (${filas.length - uuids.size} renglones de más, ${montoDup.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })})${nuevos ? ` — se esperaba ${ESPERADO.repetidos}` : ', el conocido'}.`);
    console.log('      Se conservan TODOS: es evidencia de doble registro histórico, no ruido.');
    if (nuevos && !FORCE) bloquea = true;
    repetidos.slice(0, 5).forEach(([u, n]) => {
      const ks = filas.filter((f) => f.cfdi_uuid === u).map((f) => f.source_key).join(', ');
      console.log(`      ${u} ×${n} → ${ks}`);
    });
  }

  const aSembrarPreliminar = filas.filter((f) => f.anio_mes);

  // Mismo criterio que los importers hermanos: SSL sólo contra el proxy de Railway. La LAN
  // (.245, localhost) no lo soporta y responde "the server does not support SSL".
  const pg = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();

  // ── Chequeo 4: los que no están en el ADD ─────────────────────────────────────────────
  // Contesta la pregunta abierta del doc de la fase en la misma corrida del sembrado.
  const lista = [...uuids];
  const { rows: falt } = await pg.query(
    `WITH x AS (SELECT unnest($2::text[]) AS u)
     SELECT count(*)::int AS faltan,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fiscal.cfdis c WHERE upper(c.uuid) = x.u))::int AS existen_otro_tenant
       FROM x
      WHERE NOT EXISTS (
        SELECT 1 FROM fiscal.cfdis c WHERE c.tenant_id = $1 AND upper(c.uuid) = x.u)`,
    [TENANT, lista],
  );
  console.log(`\n  ${falt[0].faltan} de ${uuids.size} UUID del libro NO están en fiscal.cfdis de este tenant.`);

  // Los que SÍ están. Lo usan el diagnóstico de abajo y la reparación.
  const { rows: enDb } = await pg.query(
    `SELECT upper(uuid) u FROM fiscal.cfdis WHERE tenant_id = $1 AND upper(uuid) = ANY($2::text[])`,
    [TENANT, lista],
  );
  const hay = new Set(enDb.map((x) => x.u));

  if (falt[0].faltan) {
    const { rows: det } = await pg.query(
      `WITH x AS (SELECT unnest($2::text[]) AS u)
       SELECT count(*) FILTER (WHERE c.rol <> 'recibidas')::int AS otro_rol,
              count(*) FILTER (WHERE c.receptor_rfc IS DISTINCT FROM (
                SELECT receptor_rfc FROM fiscal.cfdis WHERE tenant_id=$1 AND source='contpaqi_add'
                 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1))::int AS otro_receptor,
              count(*) FILTER (WHERE c.tipo_comprobante <> 'I')::int AS otro_tipo,
              count(*)::int AS hallados_sin_filtro
         FROM x JOIN fiscal.cfdis c ON upper(c.uuid) = x.u AND c.tenant_id = $1`,
      [TENANT, lista],
    );
    console.log(`      de los que SÍ están (sin filtrar rol/tipo): ${det[0].hallados_sin_filtro}`);
    console.log(`      con otro rol: ${det[0].otro_rol} · otro receptor: ${det[0].otro_receptor} · otro tipo: ${det[0].otro_tipo}`);

    // En qué meses del LIBRO caen los que faltan, contra el arranque real del ADD. Si se
    // concentran antes de la primera factura que el ADD conoce, la explicación es esa y la
    // pregunta queda cerrada; si están repartidos, hay algo más y hay que mirarlo.
    const faltantes = new Map();
    for (const f of aSembrarPreliminar) faltantes.set(f.cfdi_uuid, f.anio_mes);
    const porMes = new Map();
    for (const [u, mes] of faltantes) if (!hay.has(u)) porMes.set(mes, (porMes.get(mes) ?? 0) + 1);
    const { rows: arranque } = await pg.query(
      `SELECT to_char(min(fecha), 'YYYY-MM') AS primer_mes FROM fiscal.cfdis
        WHERE tenant_id = $1 AND source = 'contpaqi_add'`, [TENANT],
    );
    const desde = arranque[0].primer_mes;
    const previos = [...porMes.entries()].filter(([m]) => m < desde).reduce((a, [, n]) => a + n, 0);
    console.log(`      el ADD arranca en ${desde}; ${previos} de los ${falt[0].faltan} son de meses ANTERIORES.`);
    const posteriores = [...porMes.entries()].filter(([m]) => m >= desde).sort();
    if (posteriores.length) {
      console.log(`      los ${falt[0].faltan - previos} restantes, por mes: ${posteriores.map(([m, n]) => `${m}:${n}`).join(' ')}`);
    }
  }

  // ── Reparación de los UUID corridos de abr-2023 ───────────────────────────────────────
  // El workbook tiene ~155 de los 263 renglones de ABR23 con el UUID corrido un carácter.
  // 148 quedaron con 36 chars (válidos a la vista, apuntando a nada). Se recuperan quitando
  // el último carácter, pero SÓLO cuando ese prefijo identifica a UN único CFDI: si casa
  // con varios o con ninguno, se deja como está y se declara. La fila reparada lleva `nota`
  // — no puede pasar por literal del workbook.
  const noHallados = aSembrarPreliminar.filter((f) => !hay.has(f.cfdi_uuid));
  let reparadas = 0, ambiguas = 0, irrecuperables = 0;
  if (noHallados.length) {
    const prefijos = [...new Set(noHallados.map((f) => f.cfdi_uuid.slice(0, -1)))];
    const { rows: cand } = await pg.query(
      `WITH p AS (SELECT unnest($2::text[]) AS pref)
       SELECT p.pref, min(upper(c.uuid)) AS uuid, count(*)::int AS n
         FROM p JOIN fiscal.cfdis c
           ON c.tenant_id = $1 AND upper(c.uuid) LIKE p.pref || '%'
        GROUP BY p.pref`,
      [TENANT, prefijos],
    );
    const unico = new Map(cand.filter((c) => c.n === 1).map((c) => [c.pref, c.uuid]));
    const varios = new Set(cand.filter((c) => c.n > 1).map((c) => c.pref));
    for (const f of noHallados) {
      const pref = f.cfdi_uuid.slice(0, -1);
      if (unico.has(pref)) {
        f.nota = `UUID corrido en el workbook: "${f.cfdi_uuid}" → ${unico.get(pref)} (prefijo único)`;
        f.cfdi_uuid = unico.get(pref);
        reparadas++;
      } else if (varios.has(pref)) { ambiguas++; } else { irrecuperables++; }
    }
    console.log(`\n  reparación de UUID corridos: ${reparadas} recuperados por prefijo único · ${ambiguas} ambiguos · ${irrecuperables} sin candidato`);
    if (irrecuperables + ambiguas) {
      console.log(`      quedan ${irrecuperables + ambiguas} renglones del libro que NO se pueden casar por UUID.`);
      console.log('      Es un hoyo REAL del anti-duplicado exacto en esos meses; se declara, no se tapa.');
    }
  }

  const aSembrar = aSembrarPreliminar;
  console.log(`\n  → ${aSembrar.length} renglones listos para sembrar como source='${SOURCE}'`);

  if (bloquea) {
    console.error('\n  ⛔ BLOQUEADO por los chequeos de arriba. Míralo antes de sembrar.');
    await pg.end();
    process.exit(1);
  }
  if (!APPLY) {
    console.log('\n  DRY-RUN — corre con --apply para escribir.');
    await pg.end();
    return;
  }

  const COLS = ['tenant_id', 'source', 'source_key', 'cfdi_uuid', 'anio_mes', 'importe', 'emisor_rfc', 'folio', 'nota', 'observado_at'];
  const upd = COLS.filter((c) => !['tenant_id', 'source', 'source_key'].includes(c)).map((c) => `${c}=EXCLUDED.${c}`).join(', ');
  const ahora = new Date();
  let escritas = 0;
  for (let i = 0; i < aSembrar.length; i += 500) {
    const chunk = aSembrar.slice(i, i + 500);
    const ph = chunk.map((_, j) => `(${COLS.map((__, k) => `$${j * COLS.length + k + 1}`).join(',')})`).join(',');
    const vals = chunk.flatMap((f) => [TENANT, SOURCE, f.source_key, f.cfdi_uuid, f.anio_mes, f.importe, f.emisor_rfc, f.folio, f.nota ?? null, ahora]);
    const r = await pg.query(
      `INSERT INTO finance.purchase_book_history (${COLS.join(',')}) VALUES ${ph}
         ON CONFLICT (tenant_id, source, source_key) DO UPDATE SET ${upd}, updated_at=now()`,
      vals,
    );
    escritas += r.rowCount;
  }
  const { rows: fin } = await pg.query(
    `SELECT count(*)::int n, count(DISTINCT cfdi_uuid)::int uuids, min(anio_mes) desde, max(anio_mes) hasta
       FROM finance.purchase_book_history WHERE tenant_id=$1 AND source=$2 AND deleted_at IS NULL`,
    [TENANT, SOURCE],
  );
  console.log(`\n  ✓ ${escritas} filas escritas. En la tabla: ${fin[0].n} renglones · ${fin[0].uuids} UUID · ${fin[0].desde} → ${fin[0].hasta}`);
  await pg.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
