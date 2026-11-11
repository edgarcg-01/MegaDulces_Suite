// database/importers/checadores/agente/avisos.js
//
// `[RH.1.3]` LOS AVISOS DE LA SUITE — el lector ya no pregunta cada rato.
//
// Hasta el 2026-11-11 el lector releía el padrón cada 30 min y preguntaba por órdenes cada minuto POR RELOJ. La regla
// del 2026-11-10 (ningún cron: el dato por EVENTO) pide que la Suite avise: el lector deja UNA conexión abierta
// (`GET …/checador/ingesta/eventos`, Server-Sent Events) y la API le manda:
//   · `padron`        — RH dio de alta, editó, pausó o dio de baja un reloj → releer el padrón;
//   · `comando`       — hay una orden para el reloj `serie` → atenderla;
//   · `ponte_al_dia`  — lo primero que llega al conectarse, y cuando el LISTEN de la API se recupera de una caída
//                       (un NOTIFY perdido no se recupera de otra forma) → releer padrón + órdenes de todos.
//
// Si la conexión se cae, se reintenta con espera creciente (1 s → 30 s) y al volver llega `ponte_al_dia`: lo que pasó
// mientras no había conexión no se pierde. Reintentar una conexión caída NO es un reloj que relee datos.
'use strict';

/**
 * Parte el texto de un flujo SSE en eventos completos (`\n\n`). Devuelve los avisos leídos (el JSON de `data:`) y el
 * resto que todavía no termina. Pura: se prueba sin red.
 */
function partirSse(buffer) {
  const avisos = [];
  let resto = buffer.replace(/\r\n/g, '\n');
  let i;
  while ((i = resto.indexOf('\n\n')) >= 0) {
    const bloque = resto.slice(0, i);
    resto = resto.slice(i + 2);
    const data = bloque.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;   // comentario (`:`) o sólo `event:`/`id:`
    try { avisos.push(JSON.parse(data)); } catch { /* un bloque que no es JSON se ignora */ }
  }
  return { avisos, resto };
}

/**
 * Abre la conexión de avisos y la mantiene. `alAviso(aviso)` se llama por cada aviso, en orden. Devuelve `parar()`.
 * `fetchImpl` y `esperar` se inyectan para las pruebas.
 */
function escucharAvisos({ apiUrl, token, log, alAviso, fetchImpl = fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let parar = false;
  let ctrl = null;
  let intentos = 0;

  async function unaConexion() {
    ctrl = new AbortController();
    const res = await fetchImpl(`${apiUrl}/checador/ingesta/eventos`, {
      headers: { 'X-Agente-Token': token, Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`la API contestó ${res.status} a los avisos`);
    intentos = 0;
    log('avisos: conectado a la Suite (padrón y órdenes llegan al momento)');
    const dec = new TextDecoder();
    let buffer = '';
    for await (const trozo of res.body) {
      const { avisos, resto } = partirSse(buffer + dec.decode(trozo, { stream: true }));
      buffer = resto;
      for (const a of avisos) {
        try { await alAviso(a); } catch (e) { log(`avisos: no se pudo atender «${a && a.tipo}»: ${e && e.message}`); }
      }
    }
    throw new Error('la Suite cerró la conexión de avisos');
  }

  (async () => {
    while (!parar) {
      try { await unaConexion(); } catch (e) { if (parar) break; log(`avisos: ${e && e.message}; se reintenta`); }
      if (parar) break;
      await esperar(Math.min(30000, 1000 * 2 ** Math.min(intentos++, 5)));
    }
  })();

  return () => { parar = true; if (ctrl) ctrl.abort(); };
}

module.exports = { partirSse, escucharAvisos };
