/**
 * `[TOR.0.9]` **El veredicto de un servidor Kepler**, sin dependencias para que su prueba lo
 * ejercite de verdad (mismo criterio que `db-health-recurrencia.ts`).
 *
 * Contesta las tres preguntas de Sistemas (Edgar, 2026-11-04): ¿se cayó el servidor?, ¿qué falló?,
 * ¿lo tengo que atender? Lo usa `live-tickets-poller.js`, que ya se conecta a cada servidor cada
 * ~25 s; esto sólo convierte lo que ve en un latido por servidor (`kepler_server_<código>`).
 *
 * Lo que se mide y por qué:
 *   · **no responde** — el poller no pudo leer. *Inalcanzable* (red o servidor apagado) y *lento*
 *     (timeout: vivo pero saturado, o la red) son fallas distintas y se dicen distinto.
 *   · **slot sin consumidor o perdido** — si `md` deja de leer, el slot retiene WAL en la
 *     sucursal hasta llenar su disco y tirar la caja (RUNBOOK_REPLICACION_LOGICA §0.3). Un slot
 *     inactivo (p. ej. uno viejo de `.249`) retiene para siempre.
 *   · **tablas publicadas que desaparecen** — una actualización de Kepler que recrea una tabla la
 *     saca de la publicación y deja de replicar EN SILENCIO (runbook §0-bis).
 *   · **reinicio** — informativo: explica un hueco, no es una falla.
 */

/** Umbral de WAL retenido que ya es falla aunque el slot esté activo (el consumidor no alcanza). */
const RETENIDO_MAX_BYTES = 5 * 1024 ** 3;
/** Un reinicio más reciente que esto se anota en la nota. */
const REINICIO_RECIENTE_MS = 6 * 3600 * 1000;

/** «inalcanzable» | «lento» | «otro», a partir del mensaje de error de la conexión o la consulta. */
function tipoDeFalla(mensaje) {
  const m = String(mensaje || '');
  if (/EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(m)) return 'inalcanzable';
  if (/timeout|timed out|ETIMEDOUT/i.test(m)) return 'lento';
  return 'otro';
}

const PALABRA = { inalcanzable: 'no responde (red o servidor apagado)', lento: 'responde lento o no termina (saturado o red lenta)', otro: 'falla al leer' };

function mb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '?';
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function horaMx(d) {
  // America/Mexico_City sin horario de verano: UTC-6 fijo, igual que el poller.
  const x = new Date(new Date(d).getTime() - 6 * 3600 * 1000);
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')} ${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * @param {object} p
 * @param {{desde: Date|string, tipo: string, mensaje: string}|null} p.caida   falla vigente (poller)
 * @param {object|null} p.sonda      lo leído del servidor: { arranque, tope, slots:[{slot,activo,wal_status,retenido}], publicadas }
 * @param {string|null} p.errorSonda motivo si la sonda no se pudo leer estando el servidor arriba
 * @param {number|null} p.publicadasAntes  conteo de la revisión anterior (memoria del proceso)
 * @param {Date} [p.ahora]
 * @returns {{status:'ok'|'error', note:string, error:string|null}}
 */
function veredictoServidor({ caida, sonda, errorSonda, publicadasAntes, ahora = new Date() }) {
  if (caida) {
    const min = Math.max(0, Math.round((ahora - new Date(caida.desde)) / 60000));
    return {
      status: 'error',
      note: `desde ${horaMx(caida.desde)} (${min} min)`,
      error: `${PALABRA[caida.tipo] || PALABRA.otro} desde hace ${min} min: ${String(caida.mensaje || '').slice(0, 120)}`,
    };
  }
  if (!sonda) {
    // Responde (el poller leyó), pero su estado no se pudo leer: se DECLARA, no se pinta sano.
    return { status: 'ok', note: `responde · NO MEDIDO: ${String(errorSonda || 'sin sonda').slice(0, 120)}`, error: null };
  }

  const problemas = [];
  const notas = ['responde'];
  const slots = Array.isArray(sonda.slots) ? sonda.slots : [];
  for (const s of slots) {
    if (s.wal_status === 'lost') problemas.push(`slot ${s.slot} PERDIDO: la réplica ya no puede seguir desde ahí`);
    else if (!s.activo) problemas.push(`slot ${s.slot} sin consumidor: retiene ${mb(s.retenido)} de WAL y sigue creciendo`);
    else if (Number(s.retenido) > RETENIDO_MAX_BYTES) problemas.push(`slot ${s.slot} retiene ${mb(s.retenido)}: md no alcanza a consumir`);
  }
  if (slots.length) {
    const max = Math.max(...slots.map((s) => Number(s.retenido) || 0));
    notas.push(`${slots.length} slot(s), retenido máx ${mb(max)}`);
  } else {
    notas.push('sin slot de réplica');
  }
  if (slots.length && (sonda.tope === '-1' || sonda.tope === -1)) notas.push('SIN TOPE de WAL: un consumidor caído puede llenar el disco');
  if (sonda.publicadas != null) {
    notas.push(`${sonda.publicadas} tablas publicadas`);
    if (publicadasAntes != null && Number(sonda.publicadas) < Number(publicadasAntes)) {
      problemas.push(`se dejaron de publicar ${publicadasAntes - sonda.publicadas} tabla(s) (de ${publicadasAntes} a ${sonda.publicadas}): dejan de replicar sin avisar`);
    }
  }
  if (sonda.arranque) {
    const hace = ahora - new Date(sonda.arranque);
    if (hace >= 0 && hace < REINICIO_RECIENTE_MS) notas.push(`se reinició ${horaMx(sonda.arranque)}`);
  }
  return {
    status: problemas.length ? 'error' : 'ok',
    note: notas.join(' · ').slice(0, 500),
    error: problemas.length ? problemas.join(' · ').slice(0, 500) : null,
  };
}

/** La sonda: sólo catálogos, legibles por cualquier rol (no pide permisos de Kepler). */
const SQL_SONDA = `
  SELECT pg_postmaster_start_time() AS arranque,
         current_setting('max_slot_wal_keep_size') AS tope,
         (SELECT count(*)::int FROM pg_publication_tables) AS publicadas,
         (SELECT coalesce(json_agg(json_build_object(
                    'slot', slot_name, 'activo', active, 'wal_status', wal_status,
                    'retenido', pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))), '[]'::json)
            FROM pg_replication_slots WHERE slot_type = 'logical') AS slots`;

module.exports = { tipoDeFalla, veredictoServidor, SQL_SONDA, RETENIDO_MAX_BYTES };
