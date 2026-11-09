#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * Fase RH · `[RH.2.5]` — CARGA ÚNICA del reclutamiento de Mega Talento a `talent.*`: vacantes, candidatos, la bitácora de
 * etapas y los eventos. Lo que el tracker tenía como «Falta: la carga única» (`[RH.2.4]`): sin ella, el corte de
 * reclutamiento (`[RH.3.5]`) arranca con las pantallas vacías y los candidatos fuera.
 *
 * No es un importer (CLAUDE.md, regla principal; ADR-084 D4): corre UNA vez, en el corte de reclutamiento. Por omisión es
 * ENSAYO: escribe dentro de una transacción, imprime el cuadre y la deshace.
 *
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-reclutamiento-mega-talento.js            # ensayo
 *   MT_DATABASE_URL=… DATABASE_URL_NEW=… node database/scripts/rh/carga-reclutamiento-mega-talento.js --aplicar  # deja lo cargado
 *   … --destino-prod   # el corte, dentro del pod (CARGA_URL="$DATABASE_URL_NEW"), igual que las otras cargas
 *
 * ── Cómo se mapea (medido en Mega Talento el 2026-11-09, sólo lectura) ──────────────────────────────────────────────
 *  · El MISMO id de candidato y de vacante (`talent.*` se diseñó así): las ligas y la bitácora no se rompen.
 *  · `candidatos.portal_status` es la ETAPA de RH (`stage`: filtro_inicial, entrevista_rh, aptitudes, psicometria,
 *    contratado — el mismo vocabulario de la Suite) y `candidatos.estado` es el punto del bot (`bot_state`).
 *  · Lista negra y spam llegan completos (motivo y fecha: 0 incompletos). La papelera NO trae motivo (37 casos) y la
 *    Suite lo exige: va como `manual`, lo que ya había decidido la migración `20261012172246` para lo de Mega Talento.
 *  · Un renglón que no cumple una regla de la base (una etapa huérfana, p. ej.) queda FUERA y contado: nunca en silencio.
 *
 * ── Lo que NO trae (y se declara en el cuadre) ──────────────────────────────────────────────────────────────────────
 *  · Los mensajes del bot (`mensajes`: 220,897 el 9-nov) y las conversaciones a medias: van con el corte del bot
 *    (`[RH.3.5]`).
 *  · Los ARCHIVOS del expediente (CV, INE…): se cargan las URLs como están; mover los archivos al bucket es aparte.
 *  · Las requisiciones (`requisiciones`): la Suite todavía no tiene dónde (`[RH.11]`).
 *
 * Idempotente: lo que ya está (mismo id) no se toca.
 */
const path = require('path');
const carga = require('./carga-unica-mega-talento');

const { TENANT_MD } = carga;
/** Las migraciones de `talent.*` que esta carga necesita (en prod se aplican antes, una por una). */
const MIGRACIONES_TALENT = [
  '20261012155411_talent_reclutamiento_datos',
  '20261012172246_talent_fusion_y_motivo_papelera',
];
/**
 * `deletion_reason` es un CÓDIGO (`manual` · `cierre_seguimiento` · `fusionado`). Mega Talento no distinguía, y la
 * migración `20261012172246` ya decidió qué es lo de allá: `manual` («es lo que era»). Lo mismo aquí.
 */
const MOTIVO_PAPELERA_MT = 'manual';

const limpio = (v) => String(v ?? '').trim();
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/** Corre `fn` en un savepoint: si falla, lo deshace y devuelve el motivo (el nombre de la regla) en vez de tumbar la carga. */
async function conSavepoint(trx, fn) {
  await trx.raw('SAVEPOINT carga_fila');
  try {
    await fn();
    await trx.raw('RELEASE SAVEPOINT carga_fila');
    return null;
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT carga_fila');
    return e.constraint || e.code || String(e.message || e).slice(0, 80);
  }
}

/**
 * Carga lo de Mega Talento dentro de `trx` (que ya trae `app.tenant_id`). Devuelve el cuadre: por tabla, cuánto había,
 * cuánto entró y lo que no entró con su motivo; más lo que se declara NO cargado.
 */
async function cargarReclutamiento(trx, mt, { tenantId = TENANT_MD, log = null } = {}) {
  if (!RE_UUID.test(tenantId)) throw new Error(`tenant inválido: ${tenantId}`);
  const avisar = typeof log === 'function' ? log : null;
  const q = async (sql) => (await mt.query(sql)).rows;
  const cuadre = {};
  const anotar = (tabla, origen, cargadas, descartes = {}, ya = 0) => {
    cuadre[tabla] = { origen, cargadas, ya_estaban: ya, descartes };
    if (avisar) avisar(`  ${tabla}: ${cargadas} de ${origen}${ya ? ` · ya estaban ${ya}` : ''}${Object.keys(descartes).length ? ` · fuera: ${JSON.stringify(descartes)}` : ''}`);
  };
  /** Inserta una fila; 'nueva' | 'ya' | el motivo por el que no entró. */
  const insertar = async (tabla, fila) => {
    let r = 'ya';
    const malo = await conSavepoint(trx, async () => {
      const filas = await trx(tabla).insert(fila).onConflict('id').ignore().returning('id');
      r = filas.length ? 'nueva' : 'ya';
    });
    return malo || r;
  };
  const contar = async (tabla, filas, aFila) => {
    let n = 0, ya = 0;
    const desc = {};
    for (const f of filas) {
      const r = await insertar(tabla, aFila(f));
      if (r === 'nueva') n++; else if (r === 'ya') ya++; else desc[r] = (desc[r] || 0) + 1;
    }
    return { n, ya, desc };
  };

  // ── Vacantes ───────────────────────────────────────────────────────────────────────────────────────────────────
  const puestos = await q('SELECT * FROM puestos');
  const v = await contar('talent.job_postings', puestos, (p) => ({
    id: p.id, tenant_id: tenantId, name: limpio(p.nombre) || '(sin nombre)', description: p.descripcion, area: p.area,
    branch_codes: (p.sucursal_ids || []).map(limpio).filter(Boolean), branches_text: p.sucursales, salary_text: p.sueldo,
    schedule_text: p.horario, requirements: p.requisitos, image_url: p.imagen_url, competencies_sheet: p.hoja_competencias,
    extra: json(p.extra || {}), is_active: p.activo !== false, sort_order: Number.isInteger(p.orden) ? p.orden : 999,
    created_at: p.creado_en, updated_at: p.creado_en,
  }));
  anotar('job_postings', puestos.length, v.n, v.desc, v.ya);

  // ── Candidatos ─────────────────────────────────────────────────────────────────────────────────────────────────
  const candidatos = await q('SELECT * FROM candidatos');
  const c = await contar('talent.candidates', candidatos, (k) => ({
    id: k.id, tenant_id: tenantId, legacy_portal_id: k.portal_candidate_id, phone: k.telefono, full_name: k.nombre_completo,
    email: k.correo, city_branch: k.ciudad_sucursal, position_interest: k.puesto_interes, source: k.fuente, origin: k.origen,
    stage: k.portal_status, bot_state: k.estado, traffic_light: k.semaforo, commute_time: k.tiempo_traslado,
    availability: k.disponibilidad, previous_employer: k.empresa_anterior, desired_salary: k.salario_deseado, rfc: k.rfc,
    nss: k.nss, relative_in_company: k.familiar_en_empresa, rehire_note: k.reingreso, cv_url: k.cv_url,
    cv_back_url: k.cv_url_reverso, cv_format: k.cv_formato, license_url: k.licencia_url,
    documents: json(k.documentos || []), requested_documents: json(k.documentos_solicitados || []),
    application: json(k.solicitud_electronica), aptitude_rubric: json(k.rubrica_aptitudes), aptitude_eval: json(k.aptitudes_eval),
    portal_data: json(k.portal_data || {}),
    no_rehire: k.no_recontratable === true, no_rehire_reason: k.no_recontratable_motivo, no_rehire_by_name: k.no_recontratable_por,
    no_rehire_at: k.no_recontratable_en,
    is_spam: k.spam === true, spam_reason: k.spam_motivo, spam_by_name: k.spam_por, spam_at: k.spam_en,
    notified_at: k.notificado_en, notified_to: json(k.notificado_a), last_interaction_at: k.ultima_interaccion,
    last_activity_at: k.ultima_actividad, created_at: k.creado_en, updated_at: k.ultima_actividad || k.creado_en,
    deleted_at: k.deleted_at, deletion_reason: k.deleted_at ? MOTIVO_PAPELERA_MT : null,
  }));
  anotar('candidates', candidatos.length, c.n, c.desc, c.ya);
  // Lo que conviene saber al cortar: candidatos que la Suite ya tenía con el mismo teléfono (el bot de la Suite pudo
  // registrarlos). No se fusionan solos: la fusión la decide RH (Revisiones › duplicados).
  const dupl = (await trx.raw(`
    SELECT count(*)::int AS n FROM talent.candidates a
     WHERE a.phone_key IS NOT NULL AND a.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM talent.candidates b WHERE b.phone_key = a.phone_key AND b.id <> a.id AND b.deleted_at IS NULL)`)).rows[0].n;
  cuadre.candidates.mismo_telefono_que_otro = dupl;
  if (avisar) avisar(`  candidates: ${dupl} comparten teléfono con otro (RH los revisa en Revisiones › duplicados; no se fusionan solos)`);

  // ── Bitácora de etapas y eventos ───────────────────────────────────────────────────────────────────────────────
  const trans = await q('SELECT * FROM candidatos_transiciones ORDER BY cambiado_en, id');
  const t = await contar('talent.candidate_stage_transitions', trans, (x) => ({
    id: x.id, tenant_id: tenantId, candidate_id: x.candidato_id, stage_from: x.etapa_origen, stage_to: x.etapa_destino,
    hours_in_from: x.horas_en_origen, changed_by_name: 'Mega Talento', changed_at: x.cambiado_en,
  }));
  anotar('candidate_stage_transitions', trans.length, t.n, t.desc, t.ya);

  const eventos = await q('SELECT * FROM candidatos_eventos ORDER BY ocurrido_en, id');
  const e = await contar('talent.candidate_events', eventos, (x) => ({
    id: x.id, tenant_id: tenantId, candidate_id: x.candidato_id, event_type: x.tipo, channel: x.canal, note: x.nota,
    actor_name: x.por, occurred_at: x.ocurrido_en, created_at: x.creado_en || x.ocurrido_en,
  }));
  anotar('candidate_events', eventos.length, e.n, e.desc, e.ya);

  // ── La última actividad, como la lleva la Suite ────────────────────────────────────────────────────────────────
  // En la Suite, mover de etapa y registrar un evento ACTUALIZAN `last_activity_at` (`talent-etapa.db.ts`, eventos).
  // Mega Talento no: la dejaba vacía en 2,690 de 2,843 (medido el 9-nov), aunque la bitácora tiene 1,784 cambios y 247
  // eventos. Sin esto, la marca de «atrasado» y el Resumen medían desde el ALTA y todo salía atrasado. Se deriva de los
  // hechos que ya se cargaron (el último de: alta, actividad, cambio de etapa, evento); nada se inventa.
  const ids = candidatos.map((k) => k.id);
  const derivada = ids.length ? (await trx.raw(`
    WITH ult AS (
      SELECT c.id, GREATEST(c.created_at, c.last_activity_at,
               (SELECT max(t.changed_at) FROM talent.candidate_stage_transitions t WHERE t.tenant_id = c.tenant_id AND t.candidate_id = c.id),
               (SELECT max(v.occurred_at) FROM talent.candidate_events v WHERE v.tenant_id = c.tenant_id AND v.candidate_id = c.id)) AS ultima
        FROM talent.candidates c WHERE c.id = ANY(?::uuid[]))
    UPDATE talent.candidates c SET last_activity_at = ult.ultima
      FROM ult WHERE c.id = ult.id AND c.last_activity_at IS DISTINCT FROM ult.ultima`, [ids])).rowCount : 0;
  cuadre.candidates.ultima_actividad_derivada = derivada;
  if (avisar) avisar(`  candidates: última actividad tomada de la bitácora en ${derivada} (alta, cambio de etapa o evento)`);

  // ── Lo que NO se carga aquí: se declara con su tamaño, nunca como cero ─────────────────────────────────────────
  const tamano = async (tabla) => { try { return Number((await q(`SELECT count(*) AS n FROM ${tabla}`))[0].n); } catch { return null; } };
  cuadre.no_cargado = {
    mensajes_del_bot: { filas: await tamano('mensajes'), por: 'van con el corte del bot ([RH.3.5])' },
    requisiciones: { filas: await tamano('requisiciones'), por: 'la Suite todavía no tiene dónde ([RH.11])' },
    archivos_del_expediente: { filas: null, por: 'se cargan las URLs; mover los archivos al bucket es aparte' },
  };
  if (avisar) for (const [k, x] of Object.entries(cuadre.no_cargado)) avisar(`  ⚠️ NO cargado: ${k} (${x.filas ?? 'sin medir'}) — ${x.por}`);
  return cuadre;
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const destinoProd = process.argv.includes('--destino-prod');
  try { require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../../.env') }); } catch { /* sin dotenv */ }
  let url;
  if (destinoProd) {
    url = process.env.CARGA_URL;
    if (!url) throw new Error('--destino-prod necesita CARGA_URL (dentro del pod: CARGA_URL="$DATABASE_URL_NEW"). Ver el runbook.');
  } else {
    require('../../tests/_lib/assert-safe-target').assertSafeTarget('carga-reclutamiento-mega-talento');
    url = process.env.DATABASE_URL_NEW;
  }
  const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
  try {
    if (destinoProd) await carga.verificarDestinoProd(knex);
    const aplicadas = new Set((await knex.raw('SELECT name FROM public.knex_migrations')).rows.map((r) => r.name.replace(/\.js$/, '')));
    const faltan = MIGRACIONES_TALENT.filter((m) => !aplicadas.has(m));
    if (faltan.length) throw new Error(`faltan migraciones (se aplican antes, una por una): ${faltan.join(', ')}`);
  } catch (e) { await knex.destroy(); throw e; }
  const mt = await carga.conectarMegaTalento(process.env.MT_DATABASE_URL);
  const t0 = Date.now();
  const DESHACER = new Error('ensayo');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      console.log(`Carga del reclutamiento de Mega Talento → ${destinoProd ? 'PROD · ' : ''}${aplicar ? 'SE APLICA' : 'ENSAYO (se deshace al final)'}`);
      const cuadre = await cargarReclutamiento(trx, mt, { log: console.log });
      const fuera = Object.values(cuadre).reduce((s, x) => s + Object.values(x.descartes || {}).reduce((a, b) => a + b, 0), 0);
      console.log(`\nListo en ${Math.round((Date.now() - t0) / 1000)} s · ${fuera} fila(s) fuera, todas con motivo arriba.`);
      if (!aplicar) throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
    console.log('Ensayo: no quedó nada escrito.');
  } finally {
    await mt.end();
    await knex.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { cargarReclutamiento, MIGRACIONES_TALENT, MOTIVO_PAPELERA_MT };
