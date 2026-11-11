'use strict';
/**
 * `[GX.103]`–`[GX.110]` **Datos de demo para probar en LOCAL** el buscador, la lista desplegable de
 * Aprobación, «Se mandó» en Mis gastos, las fechas de Kepler y a quién le llega cada solicitud. Uno de
 * cada caso, con su control (lo que NO debe aparecer).
 *
 *   node database/scripts/dev-seed-gx107-gastos.js --usuario <username>   crea (o re-crea)
 *   node database/scripts/dev-seed-gx107-gastos.js --limpiar                borra todo lo suyo
 *
 * ⛔ Sólo contra un destino seguro (`assertSafeTarget`): escribe vales Y filas de `kepler_ods.kdm1` (la
 * copia local de Kepler) en un rango de folios propio (`0971xxx`, sucursal 00); si ese rango ya tiene
 * filas que este script no creó, se niega en vez de pisarlas. Idempotente: cada corrida borra lo suyo
 * antes de crear. El nombre de la persona se LEE de la base (el repo es público: no lleva nombres).
 */
require('dotenv').config({ quiet: true });
const { assertSafeTarget } = require('../tests/_lib/assert-safe-target');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const DB_URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
const MARCA = 'gx107';
const SUC = '00';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const USUARIO = arg('--usuario') || process.env.DEV_SEED_USUARIO || '';
const LIMPIAR = process.argv.includes('--limpiar');
if (!USUARIO && !LIMPIAR) {
  console.error('Falta --usuario <tu usuario local> (o DEV_SEED_USUARIO): las solicitudes se le asignan a él.');
  process.exit(1);
}

/** Día de México: `HOY - n`, como expresión SQL. */
const dia = (n) => `((now() AT TIME ZONE 'America/Mexico_City')::date - ${Number(n) | 0})`;
/** La llave de nombre, la MISMA de `libs/finance/.../solicita-por-nombre.ts` (sólo letras, sin acentos). */
const llave = (col) => `btrim(regexp_replace(translate(upper(coalesce(${col}, '')), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'), '[^A-Z]+', ' ', 'g'))`;

/**
 * Las solicitudes de Kepler (XA15). `doc` = fecha del documento (c9), `captura` = cuándo se capturó (c68).
 * `pide`: 'usuario' (tu usuario en «Solicita»), 'nombre' (tu nombre), u otro texto literal.
 */
const SOLICITUDES = [
  { folio: '0971001', doc: "'2026-01-15'::date", captura: dia(0), pide: 'usuario', caso: 'GX.107: póliza vieja capturada HOY',
    espera: 'Mis gastos › Te toca: «Se mandó» HOY, «documento del 15/01/26», sin «hace N días». Capturar gasto y buscador: el folio 971001 la encuentra' },
  { folio: '0971002', doc: "'2025-01-10'::date", captura: "'2025-01-10'::date", pide: 'usuario', caso: 'GX.107 control: de ANTES de la Suite',
    espera: 'NO aparece en Mis gastos; el folio 971002 NO la encuentra (es historia)' },
  { folio: '0971003', doc: dia(2), captura: dia(2), pide: 'nombre', caso: 'GX.108: «Solicita» con tu NOMBRE, no tu usuario',
    espera: 'Mis gastos › Te toca (si tu nombre se puede ligar: ver abajo)' },
  { folio: '0971004', doc: dia(1), captura: dia(1), pide: 'RRHH', caso: 'GX.108 control: un área en «Solicita»',
    espera: 'No le llega a nadie en Mis gastos; quien aprueba la ve en el buscador (sin vale)' },
  { folio: '0971005', doc: "'2026-01-15'::date", captura: dia(40), pide: 'usuario', caso: 'GX.106/107: póliza vieja capturada hace 40 días',
    espera: 'Mis gastos › Te toca: «Se mandó» hace 40 días + «hace 40 días» en ámbar (atorado)' },
];

/** Vales de la Suite. `hace` = días desde que se mandó; `hora` = hora de México (para el día UTC). */
const VALES = [
  { folio: '0971010', status: 'aprobada', hace: 0, levanto: 'demo.capturista', caso: 'GX.109: aprobado HOY',
    espera: 'Aprobación › Atrasados: «hoy» (antes no salía en ninguna pestaña hasta mañana)' },
  { folio: '0971011', status: 'revision', hace: 0, levanto: 'demo.capturista', caso: 'GX.109: por revisar HOY',
    espera: 'Aprobación › Atrasados: «hoy · Falta revisarla · te toca»' },
  { folio: '0971012', status: 'recibida', hace: 35, gastado: 50, levanto: 'yo', caso: 'GX.106: mandado hace 35 días',
    espera: 'Mis gastos › Esperan a Finanzas: «Se mandó» hace 35 días + «hace 35 días» + «gastado el …» (hace 50)' },
  { folio: '0971013', status: 'recibida', hace: 1, hora: '20:30', levanto: 'yo', caso: 'GX.106: mandado AYER a las 20:30',
    espera: 'Mis gastos: «Se mandó» AYER (en UTC ya es hoy: no debe salir con la fecha de hoy)' },
];

const FOLIOS = [...SOLICITUDES, ...VALES].map((x) => x.folio);

(async () => {
  assertSafeTarget('dev-seed-gx107-gastos', { url: DB_URL });
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, false)", [TENANT]);
    await db.query('BEGIN');

    const { rows: ajenas } = await db.query(`
      SELECT btrim(c6) AS folio FROM kepler_ods.kdm1
       WHERE sucursal = $1 AND c2 = 'X' AND c3 = 'A' AND btrim(c6) = ANY($2)
         AND coalesce(c24, '') NOT LIKE '%[demo ' || $3 || ']%'`, [SUC, FOLIOS, MARCA]);
    if (ajenas.length) throw new Error(`el rango de folios demo ya tiene ${ajenas.length} fila(s) de Kepler que no son de este script; no se pisan`);

    const v = await db.query(
      "DELETE FROM finance.expense_proofs WHERE tenant_id = $1 AND (capture_meta->>'demo' = $2 OR (sucursal = $3 AND folio_solicitud = ANY($4)))",
      [TENANT, MARCA, SUC, FOLIOS]);
    const k = await db.query(`DELETE FROM kepler_ods.kdm1 WHERE sucursal = $1 AND c2 = 'X' AND c3 = 'A'
       AND coalesce(c24, '') LIKE '%[demo ' || $2 || ']%'`, [SUC, MARCA]);
    console.log(`borrados de una corrida anterior: ${v.rowCount} vale(s) y ${k.rowCount} fila(s) de Kepler de demo`);
    if (LIMPIAR) { await db.query('COMMIT'); console.log('listo: sólo se limpió lo de demo.'); return; }

    // ¿Tu nombre se puede ligar? La MISMA regla que el servicio (SQL_MI_NOMBRE_LIGABLE + dos palabras).
    const yo = (await db.query(`
      SELECT n.nom, n.crudo FROM (SELECT ${llave('nombre')} AS nom, nombre AS crudo FROM identity.users
                                    WHERE tenant_id = $1 AND username = $2) n
       WHERE n.nom <> '' AND NOT EXISTS (SELECT 1 FROM identity.users u2 WHERE u2.tenant_id = $1 AND u2.username <> $2
                    AND string_to_array(${llave('u2.nombre')}, ' ') @> string_to_array(n.nom, ' '))`, [TENANT, USUARIO])).rows[0];
    const existe = (await db.query('SELECT 1 FROM identity.users WHERE tenant_id = $1 AND username = $2', [TENANT, USUARIO])).rowCount > 0;
    if (!existe) throw new Error(`no existe el usuario «${USUARIO}» en la base local`);
    const nombreLigable = yo && yo.nom.split(' ').filter(Boolean).length >= 2 ? yo.crudo : null;

    for (const [i, s] of SOLICITUDES.entries()) {
      let pide = s.pide === 'usuario' ? USUARIO.toUpperCase() : s.pide;
      if (s.pide === 'nombre') {
        if (!nombreLigable) { console.log(`  ${SUC}-${s.folio}  (se salta: tu usuario no tiene un nombre de 2+ palabras que nadie más tenga)`); continue; }
        pide = nombreLigable;
      }
      await db.query(`
        INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c32, c43, c48, c68, c69)
        VALUES ($1, $1, 'X', 'A', 15, 1, $2, ${s.doc}::timestamp, $3, $4, $5, 'A', $6, ${s.captura}::timestamp, '10:30')`,
        [SUC, s.folio, 700 + i * 111.25, `${s.caso} [demo ${MARCA}]`, `PROVEEDOR DEMO GX107 ${i + 1}`, pide]);
      console.log(`  ${SUC}-${s.folio}  ${s.caso.padEnd(48)} → ${s.espera}`);
    }

    for (const [i, x] of VALES.entries()) {
      const levanto = x.levanto === 'yo' ? USUARIO : x.levanto;
      const creado = x.hora
        ? `((${dia(x.hace)} + time '${x.hora}') AT TIME ZONE 'America/Mexico_City')`
        : `(now() - make_interval(days => ${Number(x.hace) | 0}))`;
      const decidido = x.status !== 'recibida';
      // La solicitud de Kepler del vale (para que la pantalla tenga de dónde leerla).
      await db.query(`
        INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c16, c24, c32, c43, c48, c68, c69)
        VALUES ($1, $1, 'X', 'A', 15, 1, $2, ${dia(x.gastado ?? x.hace)}::timestamp, $3, $4, $5, 'A', $6, ${dia(x.hace)}::timestamp, '09:00')`,
        [SUC, x.folio, 900 + i * 95.5, `${x.caso} [demo ${MARCA}]`, `PROVEEDOR DEMO GX107 V${i + 1}`, levanto.toUpperCase()]);
      await db.query(`
        INSERT INTO finance.expense_proofs
          (tenant_id, solicitante, departamento, sucursal, fecha_gasto, folio_solicitud, proveedor, importe, files,
           comentarios, status, clasificacion, forma_pago, created_by, created_at, updated_at, validated_by, validated_at, capture_meta)
        VALUES ($1, $2, 'DEMO GX.107', $3, ${dia(x.gastado ?? x.hace)}, $4, $5, $6, $7::jsonb,
                $8, $9, 'no_comprobable', 'efectivo', $10, ${creado}, now(),
                $11, CASE WHEN $12::boolean THEN now() END, $13::jsonb)`,
        [TENANT, levanto.toUpperCase(), SUC, x.folio, `PROVEEDOR DEMO GX107 V${i + 1}`, 900 + i * 95.5,
          JSON.stringify([{ role: 'comprobante_1', url: `https://placehold.co/600x800/png?text=Vale+${x.folio}`, kind: 'image', name: `${x.folio}.png` }]),
          `${x.caso} [demo ${MARCA}]`, x.status, levanto, decidido ? 'DEMO APROBADOR' : null, decidido,
          JSON.stringify({ demo: MARCA, caso: x.caso })]);
      console.log(`  ${SUC}-${x.folio}  ${x.caso.padEnd(48)} → ${x.espera}`);
    }

    await db.query('COMMIT');
    console.log(`\nlisto para «${USUARIO}». Tu nombre ${nombreLigable ? 'SÍ se puede ligar (GX.108)' : 'NO se puede ligar: el caso 0971003 se saltó'}.`);
    console.log('Reinicia la API local si estaba vieja. Para quitarlo: --limpiar');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
