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
 * ── `--con-bot` ([RH.3.5], el corte del bot: se corre cuando el número de WhatsApp pasa a la Suite) ─────────────────
 *  · `mensajes` (220,897 el 9-nov) → `whatsapp.messages`, flujo `recruitment`, mismo id, sin hilo (los hilos son de
 *    comercio). Las imágenes y documentos viajan como la URL de Mega Talento en `payload.media_url`.
 *  · Una conversación por teléfono → `talent.bot_conversations`, para que quien quedó a medias SIGA donde se quedó y
 *    no empiece de cero: el estado se traduce al de la Suite (mismo nombre, o el campo traducido en `esperando_<campo>`;
 *    un paso que la Suite no tiene va al siguiente dato que le falte), el registro terminado queda `postulada` con su
 *    candidato, y lo que llegó por la web (`portal`) no tiene conversación. Si la Suite ya le habló a ese teléfono,
 *    manda la de la Suite.
 *  · ⚠️ La solicitud a medias viaja TAL CUAL, con sus respuestas sensibles (salud, embarazo, deudas, familiares…) que
 *    Mega Talento pedía SIN el consentimiento que la Suite exige: decisión de Edgar del 2026-11-09 («traerlas tal cual»).
 *
 * ── Lo que NO trae (y se declara en el cuadre) ──────────────────────────────────────────────────────────────────────
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
/** Las que pide además `--con-bot` (mensajes por flujo y conversaciones con solicitud y documentos). */
const MIGRACIONES_BOT = [
  '20261013144148_whatsapp_flujo_por_numero',
  '20261013150116_talent_bot_conversaciones',
  '20261014083512_talent_bot_solicitud',
  '20261014141356_talent_bot_documentos',
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

// ── [RH.3.5] El bot ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Los pasos del registro del bot de la Suite, EN ORDEN. COPIA de `PASOS` en `libs/hr/.../bot/registro.ts` (este guion
 * corre en el pod sin `libs/`): `carga-reclutamiento.db.spec` exige que coincidan.
 */
const PASOS_BOT = ['position_interest', 'full_name', 'email', 'city_branch', 'commute_time', 'availability',
  'previous_employer', 'desired_salary', 'rfc', 'nss', 'relative_in_company', 'rehire_note'];
/** El campo de Mega Talento (en `esperando_<campo>`) → el de la Suite. */
const CAMPO_MT = {
  puesto_interes: 'position_interest', nombre_completo: 'full_name', correo: 'email', ciudad_sucursal: 'city_branch',
  tiempo_traslado: 'commute_time', disponibilidad: 'availability', empresa_anterior: 'previous_employer',
  salario_deseado: 'desired_salary', rfc: 'rfc', nss: 'nss', familiar_en_empresa: 'relative_in_company', reingreso: 'rehire_note',
};
/** Los estados que se llaman igual en los dos bots. */
const MISMO_ESTADO = new Set(['confirmando', 'orientando_puesto', 'esperando_cv', 'armando_solicitud', 'solicitud_pausada',
  'revisando_cv', 'corrigiendo_solicitud']);
/** Registro terminado en Mega Talento: la conversación queda `postulada` (con su candidato, que ya se cargó). */
const TERMINADO = new Set(['pendiente_aprobacion', 'completado', 'aprobado', 'dictaminando']);

/**
 * El estado de la Suite para un estado de Mega Talento. `como` dice cómo se decidió (para el cuadre). `null` = no hay
 * conversación que cargar (`portal`: llegó por la web).
 */
function estadoBot(estadoMt, datos) {
  const e = limpio(estadoMt);
  if (e === 'portal' || !e) return null;
  if (TERMINADO.has(e)) return { state: 'postulada', como: 'terminado' };
  if (e === 'nuevo') return { state: 'nuevo', como: 'igual' };
  if (e === 'invitado') return { state: 'nuevo', como: 'invitado' };   // RH lo invitó y no ha contestado
  if (MISMO_ESTADO.has(e)) return { state: e, como: 'igual' };
  const m = /^(esperando|editando)_(.+)$/.exec(e);
  const campo = m ? CAMPO_MT[m[2]] : null;
  if (m && campo) return { state: `${m[1]}_${campo}`, como: 'traducido' };
  // Un paso que la Suite no tiene (p. ej. `esperando_midot`): el siguiente dato que le falte, o el resumen.
  const falta = PASOS_BOT.find((p) => !limpio(datos[p]));
  return { state: falta ? `esperando_${falta}` : 'confirmando', como: 'siguiente_faltante' };
}

/** La clave del teléfono: los últimos 10 dígitos (la misma regla que `phone_key` en la base). */
const clave = (t) => String(t || '').replace(/\D/g, '').slice(-10);

/**
 * Los mensajes de Mega Talento → `whatsapp.messages` (flujo reclutamiento, sin hilo de comercio), por páginas. Un renglón
 * que la base no acepta (sin teléfono, dirección desconocida) queda FUERA y contado; no se le inventa nada. Devuelve
 * también el último mensaje ENTRANTE por teléfono: es la ventana de 24 h de WhatsApp de cada conversación.
 */
async function cargarMensajes(trx, mt, tenantId, pagina = 5000) {
  const origen = Number((await mt.query('SELECT count(*) AS n FROM mensajes')).rows[0].n);
  const descartes = {};
  const fuera = (motivo) => { descartes[motivo] = (descartes[motivo] || 0) + 1; };
  const ultimoEntrante = new Map();
  let cargadas = 0, ya = 0, ultimo = null;
  const insertar = (datos) => trx.raw(`
    INSERT INTO whatsapp.messages (id, tenant_id, thread_id, direction, type, body, payload, created_at, flow, phone)
    SELECT x.id, ?::uuid, NULL, x.direction, x.type, x.body, x.payload, x.created_at, 'recruitment', x.phone
      FROM jsonb_to_recordset(?::jsonb) AS x(id uuid, direction text, type text, body text, payload jsonb, created_at timestamptz, phone text)
    ON CONFLICT (id) DO NOTHING`, [tenantId, JSON.stringify(datos)]);
  for (;;) {
    const filas = (await mt.query(
      `SELECT id, telefono, direccion, tipo, texto, media_url, creado_en FROM mensajes
        ${ultimo ? 'WHERE id > $1' : ''} ORDER BY id LIMIT ${Number(pagina)}`, ultimo ? [ultimo] : [])).rows;
    if (!filas.length) break;
    ultimo = filas[filas.length - 1].id;
    const datos = [];
    for (const m of filas) {
      const tel = limpio(m.telefono);
      if (m.direccion !== 'in' && m.direccion !== 'out') { fuera('direccion_desconocida'); continue; }
      if (!tel || tel.length > 20) { fuera('sin_telefono'); continue; }
      if (!m.creado_en) { fuera('sin_fecha'); continue; }
      datos.push({
        id: m.id, direction: m.direccion, type: limpio(m.tipo) || 'text', body: m.texto,
        payload: m.media_url ? { media_url: m.media_url, origen: 'mega_talento' } : null, created_at: m.creado_en, phone: tel,
      });
      if (m.direccion === 'in') {
        const k = clave(tel), f = new Date(m.creado_en);
        if (!ultimoEntrante.has(k) || f > ultimoEntrante.get(k)) ultimoEntrante.set(k, f);
      }
    }
    // La página entra de un golpe; si la base rechaza algo, se repite renglón por renglón para dejar fuera SÓLO ése.
    const malo = datos.length ? await conSavepoint(trx, async () => { const r = await insertar(datos); cargadas += r.rowCount || 0; ya += datos.length - (r.rowCount || 0); }) : null;
    if (malo) {
      for (const d of datos) {
        let n = 0;
        const m = await conSavepoint(trx, async () => { n = (await insertar([d])).rowCount || 0; });
        if (m) fuera(m); else if (n) cargadas++; else ya++;
      }
    }
  }
  return { origen, cargadas, ya_estaban: ya, descartes, ultimo_entrante: ultimoEntrante };
}

/**
 * Una conversación por teléfono (la del candidato MÁS RECIENTE con ese número), para que quien quedó a medias en Mega
 * Talento siga donde se quedó. Spam y papelera no: si vuelven a escribir, empiezan de cero con las reglas de la Suite.
 * La solicitud a medias (`portal_data.solicitud`) viaja como `application`, tal cual (decisión del 9-nov: lo sensible
 * de Mega Talento se trae como está, aunque allá no se pedía el consentimiento que la Suite exige).
 */
async function cargarConversaciones(trx, candidatos, tenantId, ultimoEntrante) {
  const porTelefono = new Map();
  for (const k of candidatos) {
    if (k.deleted_at || k.spam || clave(k.telefono).length !== 10) continue;
    const prev = porTelefono.get(clave(k.telefono));
    if (!prev || new Date(k.creado_en) > new Date(prev.creado_en)) porTelefono.set(clave(k.telefono), k);
  }
  const como = {};
  const descartes = {};
  let cargadas = 0, ya = 0, origen = 0;
  for (const k of porTelefono.values()) {
    const datos = Object.fromEntries(PASOS_BOT.map((p) => [p, null]));
    Object.assign(datos, {
      position_interest: k.puesto_interes, full_name: k.nombre_completo, email: k.correo, city_branch: k.ciudad_sucursal,
      commute_time: k.tiempo_traslado, availability: k.disponibilidad, previous_employer: k.empresa_anterior,
      desired_salary: k.salario_deseado, rfc: k.rfc, nss: k.nss, relative_in_company: k.familiar_en_empresa, rehire_note: k.reingreso,
    });
    const e = estadoBot(k.estado, datos);
    if (!e) continue;
    origen++;
    const data = Object.fromEntries(Object.entries(datos).filter(([, v]) => limpio(v)));
    const sol = k.portal_data && typeof k.portal_data === 'object' ? k.portal_data.solicitud : null;
    const application = sol && typeof sol === 'object'
      ? { respuestas: sol.respuestas && typeof sol.respuestas === 'object' ? sol.respuestas : {}, iniciada_en: sol.iniciadaEn ?? null }
      : null;
    const postulada = e.state === 'postulada';
    let entro = false;
    const malo = await conSavepoint(trx, async () => { entro = (await trx('talent.bot_conversations').insert({
      tenant_id: tenantId, phone: k.telefono, state: e.state, data: JSON.stringify(data),
      application: application ? JSON.stringify(application) : null, candidate_id: k.id,
      outcome: postulada ? 'postulada' : null, created_at: k.creado_en, updated_at: k.ultima_actividad || k.creado_en,
      last_inbound_at: ultimoEntrante?.get(clave(k.telefono)) ?? null,
    }).onConflict(['tenant_id', 'phone_key']).ignore().returning('id')).length > 0; });
    if (malo) { descartes[malo] = (descartes[malo] || 0) + 1; continue; }
    // Ya había conversación con ese teléfono (la Suite ya le habló): manda la de la Suite, que es más nueva.
    if (!entro) { ya++; continue; }
    cargadas++;
    como[e.como] = (como[e.como] || 0) + 1;
  }
  return { origen, cargadas, ya_estaban: ya, como, descartes };
}

/**
 * Carga lo de Mega Talento dentro de `trx` (que ya trae `app.tenant_id`). Devuelve el cuadre: por tabla, cuánto había,
 * cuánto entró y lo que no entró con su motivo; más lo que se declara NO cargado. Con `conBot`, también los mensajes
 * y las conversaciones del bot (`[RH.3.5]`).
 */
async function cargarReclutamiento(trx, mt, { tenantId = TENANT_MD, log = null, conBot = false, paginaMensajes = 5000 } = {}) {
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

  // ── [RH.3.5] Los mensajes del bot → el libro único de WhatsApp ───────────────────────────────────────────────
  if (conBot) {
    cuadre.messages = await cargarMensajes(trx, mt, tenantId, paginaMensajes);
    if (avisar) avisar(`  messages: ${cuadre.messages.cargadas} de ${cuadre.messages.origen}${cuadre.messages.ya_estaban ? ` · ya estaban ${cuadre.messages.ya_estaban}` : ''}`);
    cuadre.bot_conversations = await cargarConversaciones(trx, candidatos, tenantId, cuadre.messages.ultimo_entrante);
    delete cuadre.messages.ultimo_entrante;
    if (avisar) avisar(`  bot_conversations: ${cuadre.bot_conversations.cargadas} de ${cuadre.bot_conversations.origen} · ${JSON.stringify(cuadre.bot_conversations.como)}${Object.keys(cuadre.bot_conversations.descartes).length ? ` · fuera: ${JSON.stringify(cuadre.bot_conversations.descartes)}` : ''}`);
  }

  // ── Lo que NO se carga aquí: se declara con su tamaño, nunca como cero ─────────────────────────────────────────
  const tamano = async (tabla) => { try { return Number((await q(`SELECT count(*) AS n FROM ${tabla}`))[0].n); } catch { return null; } };
  cuadre.no_cargado = {
    ...(conBot ? {} : { mensajes_del_bot: { filas: await tamano('mensajes'), por: 'se cargan con --con-bot (el corte de reclutamiento y bot)' } }),
    requisiciones: { filas: await tamano('requisiciones'), por: 'la Suite todavía no tiene dónde ([RH.11])' },
    archivos_del_expediente: { filas: null, por: 'se cargan las URLs (de CV y de los adjuntos del chat); mover los archivos al bucket es aparte' },
  };
  if (avisar) for (const [k, x] of Object.entries(cuadre.no_cargado)) avisar(`  ⚠️ NO cargado: ${k} (${x.filas ?? 'sin medir'}) — ${x.por}`);
  return cuadre;
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const destinoProd = process.argv.includes('--destino-prod');
  const conBot = process.argv.includes('--con-bot');
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
    const faltan = [...MIGRACIONES_TALENT, ...(conBot ? MIGRACIONES_BOT : [])].filter((m) => !aplicadas.has(m));
    if (faltan.length) throw new Error(`faltan migraciones (se aplican antes, una por una): ${faltan.join(', ')}`);
  } catch (e) { await knex.destroy(); throw e; }
  const mt = await carga.conectarMegaTalento(process.env.MT_DATABASE_URL);
  const t0 = Date.now();
  const DESHACER = new Error('ensayo');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MD]);
      console.log(`Carga del reclutamiento de Mega Talento${conBot ? ' y del bot' : ''} → ${destinoProd ? 'PROD · ' : ''}${aplicar ? 'SE APLICA' : 'ENSAYO (se deshace al final)'}`);
      const cuadre = await cargarReclutamiento(trx, mt, { log: console.log, conBot });
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

module.exports = { cargarReclutamiento, estadoBot, CAMPO_MT, MIGRACIONES_TALENT, MIGRACIONES_BOT, MOTIVO_PAPELERA_MT, PASOS_BOT };
