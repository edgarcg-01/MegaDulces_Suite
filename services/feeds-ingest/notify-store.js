'use strict';
/**
 * `[TDA.1]` — Le avisa al API que un precio de etiqueta cambió, para que la pantalla se entere.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────
 * La cadena Kepler → base funciona y es rápida: replicación lógica al replica local, carril hash
 * @15 s al ODS, y el hop-2 recomputa `commercial.product_label_prices` **sincrónico** dentro del
 * mismo POST. O sea: el precio nuevo está en la base en segundos.
 *
 * Lo que faltaba era el último tramo. El sistema es 100 % pull —no hay un solo `pg_notify` en el
 * repo ni un trigger sobre `kepler_ods.*`— y la etiquetera consulta el precio SÓLO cuando el
 * operador escanea. La frescura además viaja congelada pegada al ítem. Resultado: si se corrige un
 * precio mientras alguien tiene etiquetas en cola, esas filas conservan el precio viejo **y se
 * imprimen así**. Es el incidente del SKU 88222 (2026-09-02) visto desde la pantalla: se corrigió
 * en Kepler un precio 54 % bajo costo y el cambio no aparecía.
 *
 * ── Por qué un POST y no algo más listo ─────────────────────────────────────
 * Éste es el patrón que ya existe y está probado: el poller de tickets on-prem hace
 * `POST /store/live/ingest` con `x-store-ingest-key` y el `StoreGateway` emite. Se reusa tal cual —
 * mismo guard, mismo gateway, mismo secreto. Las alternativas eran peores: `LISTEN/NOTIFY` obliga a
 * una conexión dedicada en el API y sería el primer uso en todo el repo (un mecanismo nuevo para
 * mantener), y un trigger sobre el ODS ya se descartó una vez por el impuesto de escritura.
 *
 * Como este servicio y el API viven los dos en Railway, la llamada sale por la red interna: egress
 * gratis, que es la razón de ser de este servicio.
 *
 * ── Fail-OPEN, y es deliberado ──────────────────────────────────────────────
 * Esto es un AVISO, no el dato. Si el POST falla, el precio ya quedó bien guardado y la pantalla lo
 * verá en el próximo escaneo — exactamente como se comportaba antes de este archivo. Que un aviso
 * caído tumbe la ingesta sería cambiar un problema chico por uno grande. Por eso: timeout corto,
 * nunca `throw`, y jamás dentro de la transacción del hop-2.
 *
 * Lo que NO hace: no reintenta. Un aviso perdido se degrada al comportamiento viejo (pull), así que
 * la cola de reintentos no compra nada y sí agrega estado.
 */

const URL_BASE = process.env.STORE_NOTIFY_URL || process.env.STORE_API_URL || null;
const KEY = process.env.STORE_INGEST_KEY || null;
const TIMEOUT_MS = Number(process.env.STORE_NOTIFY_TIMEOUT_MS || 3000);
/** Tope de ids por aviso. Un cambio masivo de catálogo no tiene por qué mandar un body enorme:
 *  pasado el tope se avisa `truncated` y la pantalla refresca todo lo que tenga en cola. */
const MAX_IDS = Number(process.env.STORE_NOTIFY_MAX_IDS || 500);

let avisado = false;
/** Se declara UNA vez, no en cada tick: sin esto un carril @15 s llena el log con lo mismo. */
function declararNoConfigurado(logger) {
  if (avisado) return;
  avisado = true;
  logger(
    '[notify-store] STORE_NOTIFY_URL o STORE_INGEST_KEY sin configurar: los cambios de precio NO se ' +
    'empujan a las pantallas. El dato queda bien guardado; la etiquetera lo verá al siguiente escaneo.',
  );
}

/**
 * Avisa que estos productos cambiaron de precio de etiqueta.
 *
 * @param {string} tenantId
 * @param {string[]} productIds los `product_id` que REALMENTE cambiaron (el UPSERT es churn-free)
 * @param {(m: string) => void} [logger]
 * @returns {Promise<boolean>} `true` si el aviso salió. Nunca lanza.
 */
async function notifyLabelPricesChanged(tenantId, productIds, logger = console.warn) {
  const ids = Array.from(new Set((Array.isArray(productIds) ? productIds : []).filter(Boolean)));
  if (!ids.length) return false;
  if (!URL_BASE || !KEY) { declararNoConfigurado(logger); return false; }

  const truncated = ids.length > MAX_IDS;
  const body = JSON.stringify({
    tenant_id: tenantId,
    product_ids: truncated ? ids.slice(0, MAX_IDS) : ids,
    total: ids.length,
    truncated,
    at: new Date().toISOString(),
  });

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE.replace(/\/+$/, '')}/store/live/label-prices-changed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-ingest-key': KEY },
      body,
      signal: ac.signal,
    });
    if (!res.ok) { logger(`[notify-store] el API contestó ${res.status} al avisar ${ids.length} precio(s)`); return false; }
    return true;
  } catch (e) {
    // Incluye el abort por timeout. No se propaga: ver "Fail-OPEN" arriba.
    logger(`[notify-store] no se pudo avisar ${ids.length} precio(s): ${e && e.message}`);
    return false;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { notifyLabelPricesChanged };
