#!/usr/bin/env node
/**
 * `[GX.59]` — **Datos de prueba para el Expediente.**
 *
 * La pantalla agrupa por persona y marca qué le falta a cada vale. Para poder MIRARLA hace
 * falta que existan las tres situaciones, y en la base local sólo existe una:
 *
 *   · **completo** — firmado + comprobación de Kepler. ⛔ Hoy local tiene **0 comprobaciones**:
 *     el módulo GX.8 nunca se usó, así que sin este seed TODO sale incompleto y la pantalla
 *     no se puede evaluar (un tablero todo rojo se ve igual si la regla está mal).
 *   · **incompleto por Kepler** — firmado, sin comprobación. Es el caso real mayoritario.
 *   · **incompleto por la factura** — aprobado con cotización, debiendo el comprobante.
 *
 * ⛔ **Sólo local.** Se niega a correr si la URL no apunta a `127.0.0.1`/`localhost`.
 * ⚠️ **No inventa gasto**: no crea expedientes nuevos ni toca importes. Trabaja sobre los que
 * ya están, les agrega la comprobación que les falta o los marca como provisionales. El dinero
 * de la pantalla sigue siendo el que había.
 *
 * Uso:
 *   node database/scripts/dev-seed-expediente.js            (siembra)
 *   node database/scripts/dev-seed-expediente.js --limpiar  (borra SÓLO lo que sembró)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const LIMPIAR = process.argv.includes('--limpiar');
/** Marca propia: todo lo que este script cree la lleva, para poder retirarlo sin tocar lo demás. */
const MARCA = 'SEED-GX59';

(async () => {
  const url = String(process.env.DATABASE_URL_NEW || '');
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    console.error('\n⛔ Este seed es SÓLO local y DATABASE_URL_NEW no apunta a localhost.');
    console.error('   Sembrar comprobaciones falsas en otra base metería un hecho inventado');
    console.error('   en el trámite de gasto de gente real.\n');
    await knex.destroy();
    process.exit(1);
  }

  const hayTabla = (await knex.raw(
    `select (to_regclass('finance.expense_comprobaciones') is not null) as existe`)).rows[0].existe;
  if (!hayTabla) {
    console.error('\n⛔ `finance.expense_comprobaciones` no existe en esta base: no hay dónde sembrar.');
    console.error('   La pantalla va a mostrar «sin medir», que es el comportamiento correcto.\n');
    await knex.destroy();
    process.exit(1);
  }

  if (LIMPIAR) {
    const n = await knex('finance.expense_comprobaciones').where('departamento', MARCA).del();
    const m = await knex('finance.expense_proofs')
      .where({ tenant_id: T }).whereRaw(`comentarios like ?`, [`%${MARCA}%`])
      .update({ provisional: false, comentarios: knex.raw(`replace(comentarios, ' ${MARCA}', '')`) });
    console.log(`\n🧹 ${n} comprobación(es) borradas · ${m} vale(s) devueltos a no-provisional\n`);
    await knex.destroy();
    return;
  }

  console.log('\n[GX.59] Sembrando el Expediente (sólo local)\n');

  // ── El retrato de ANTES: sin esto no se puede decir que el seed cambió algo ──────────
  const antes = (await knex.raw(`
    select count(*)::int vales,
           count(distinct solicitante)::int personas,
           (select count(*)::int from finance.expense_comprobaciones) comprobaciones
      from finance.expense_proofs where tenant_id = ?`, [T])).rows[0];
  console.log(`   antes: ${antes.vales} vales · ${antes.personas} personas · ${antes.comprobaciones} comprobaciones`);

  // ── 1) Comprobación de Kepler para ~40% de los vales ya firmados ────────────────────
  // Se eligen los FIRMADOS: comprobar un vale que nadie aprobó sería un trámite imposible,
  // y la pantalla mostraría un «completo» que en la vida real no puede existir.
  const firmados = await knex('finance.expense_proofs')
    .where({ tenant_id: T })
    .whereIn('status', ['aprobada', 'revision', 'validada'])
    .whereNotNull('folio_solicitud')
    .select('id', 'solicitante', 'sucursal', 'folio_solicitud', 'proveedor', 'importe', 'departamento')
    .orderBy('created_at', 'desc');

  // Uno de cada dos y medio: queda un reparto visible de completos contra incompletos.
  const aComprobar = firmados.filter((_, i) => i % 5 < 2);
  const yaTienen = new Set((await knex('finance.expense_comprobaciones')
    .where({ tenant_id: T }).select('folio_solicitud')).map((r) => r.folio_solicitud));

  const nuevas = aComprobar
    .filter((p) => !yaTienen.has(p.folio_solicitud))
    .map((p, i) => ({
      tenant_id: T,
      solicitante: p.solicitante,
      departamento: MARCA,
      sucursal: p.sucursal,
      folio_gasto: `XA1001-${String(90000 + i).padStart(7, '0')}`,
      folio_solicitud: p.folio_solicitud,
      fecha_comprobacion: knex.fn.now(),
      folio_comprobacion: `XA1001-${String(90000 + i).padStart(7, '0')}`,
      proveedor: p.proveedor,
      importe: p.importe,
      files: JSON.stringify([{ role: 'comprobacion', url: 'https://ejemplo.local/comprobacion.pdf', name: 'comprobacion.pdf' }]),
      comentarios: `Comprobación de prueba ${MARCA}`,
      status: 'validada',
      created_by: MARCA,
    }));

  if (nuevas.length) {
    for (let i = 0; i < nuevas.length; i += 100) {
      await knex('finance.expense_comprobaciones').insert(nuevas.slice(i, i + 100));
    }
  }
  console.log(`   1) ${nuevas.length} comprobación(es) de Kepler sembradas sobre vales YA firmados`);

  // ── 2) Unos cuantos vales que quedaron DEBIENDO la factura ──────────────────────────
  // Provisional = se aprobó con una cotización. Se eligen los que NO tienen `comprobante_*`,
  // porque marcar uno que ya la subió crearía una deuda que no existe.
  const candidatos = firmados.filter((p) => !aComprobar.includes(p)).slice(0, 6);
  let marcados = 0;
  for (const p of candidatos) {
    const row = await knex('finance.expense_proofs').where({ id: p.id }).first('files', 'comentarios');
    const files = typeof row.files === 'string' ? JSON.parse(row.files || '[]') : (row.files || []);
    const tieneComprobante = files.some((f) => String(f?.role || '').startsWith('comprobante'));
    if (tieneComprobante) {
      // Se le quita el comprobante y se le deja una cotización: así el vale DEBE de verdad,
      // en vez de decir que debe mientras el papel está adentro.
      const sinComprobante = files.filter((f) => !String(f?.role || '').startsWith('comprobante'));
      sinComprobante.push({ role: 'cotizacion', url: 'https://ejemplo.local/cotizacion.pdf', name: 'cotizacion.pdf' });
      await knex('finance.expense_proofs').where({ id: p.id }).update({
        files: JSON.stringify(sinComprobante),
        provisional: true,
        comentarios: `${(row.comentarios || '').trim()} ${MARCA}`.trim(),
      });
      marcados++;
    }
  }
  console.log(`   2) ${marcados} vale(s) marcados como aprobados con cotización (deben la factura)`);

  // ── 3) El retrato de DESPUÉS, por etapa ─────────────────────────────────────────────
  const filas = await knex('finance.expense_proofs as p')
    .where('p.tenant_id', T)
    .select('p.status', 'p.provisional', 'p.files', 'p.solicitante',
      knex.raw(`(select count(*) from finance.expense_comprobaciones c
                  where c.tenant_id = p.tenant_id and c.folio_solicitud = p.folio_solicitud
                    and coalesce(c.status,'') <> 'rechazada')::int as comps`));

  const conteo = { completo: 0, incompleto: 0, en_captura: 0, rechazado: 0 };
  for (const f of filas) {
    if (f.status === 'rechazada') { conteo.rechazado++; continue; }
    const files = typeof f.files === 'string' ? JSON.parse(f.files || '[]') : (f.files || []);
    const faltan = [];
    if (!['aprobada', 'revision', 'validada'].includes(f.status)) faltan.push('firma');
    if (Number(f.comps || 0) === 0) faltan.push('comprobacion_kepler');
    if (f.provisional === true && !files.some((x) => String(x?.role || '').startsWith('comprobante'))) {
      faltan.push('factura');
    }
    // [GX.59] Misma precedencia que el contrato: sin firma la etapa es «en captura» aunque
    // falten las otras dos. Este conteo fue el que destapo el bug — decia 1 en captura de 78.
    if (!faltan.length) conteo.completo++;
    else if (faltan.includes('firma')) conteo.en_captura++;
    else conteo.incompleto++;
  }

  const personas = new Set(filas.map((f) => String(f.solicitante || '').toUpperCase())).size;
  console.log('\n   después, por etapa del protocolo:');
  console.log(`     protocolo completo ....... ${conteo.completo}`);
  console.log(`     incompleto ............... ${conteo.incompleto}`);
  console.log(`     en captura (sin firma) ... ${conteo.en_captura}`);
  console.log(`     rechazado ................ ${conteo.rechazado}`);
  console.log(`     en ${personas} personas\n`);

  if (conteo.completo === 0) {
    console.log('   ⚠️ Ningún vale quedó completo: la pantalla se va a ver toda roja y no se');
    console.log('      puede distinguir un tablero correcto de uno roto.\n');
  }
  console.log('   Para retirarlo:  node database/scripts/dev-seed-expediente.js --limpiar\n');

  await knex.destroy();
})().catch(async (e) => { console.error('ERR', e.message); await knex.destroy(); process.exit(1); });
