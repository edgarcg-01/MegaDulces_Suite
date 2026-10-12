// database/importers/checadores/agente/config.js
//
// Fase RH · [RH.1.3] — la configuración del lector de relojes, desde el ENTORNO (secreto de k8s,
// como los demás carriles de `ingesta`). Aparte de `index.js` para poder probarla sin cargar el
// protocolo de los relojes ni la cola SQLite.
//
//   HR_AGENT_API_URL       la entrada compatible de la Suite, p. ej.
//                          http://api:10000/api/hr/attendance/ingest/mt   (dentro del clúster)
//   HR_INGEST_KEY          la misma llave que la API (`HR_INGEST_KEY`): viaja en X-Agente-Token
//   HR_AGENT_DATA_DIR      volumen persistente: cola.db + padron.json
//   HR_AGENT_SITE          opcional: acota el padrón a un sitio de checado
//   HR_AGENT_SERIES        opcional: series separadas por coma (qué relojes le tocan a ESTA copia)
//   HR_AGENT_BACKFILL_MIN · HR_AGENT_PADRON_MIN · HR_AGENT_VIGILANCIA_MIN   (opcionales)

const path = require('path');

/** Lee y valida la configuración. Lanza con el nombre de lo que falta: nunca arranca a medias. */
function configDelEntorno(env = process.env, base = __dirname) {
  const apiUrl = String(env.HR_AGENT_API_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.HR_INGEST_KEY || '').trim();
  const faltan = [!apiUrl && 'HR_AGENT_API_URL', !token && 'HR_INGEST_KEY'].filter(Boolean);
  if (faltan.length) throw new Error(`Faltan ${faltan.join(' y ')} en el entorno.`);
  if (!/^https?:\/\//.test(apiUrl)) throw new Error(`HR_AGENT_API_URL debe empezar con http:// o https:// (llegó «${apiUrl}»).`);
  const dir = String(env.HR_AGENT_DATA_DIR || path.join(base, '.datos')).trim();
  const series = String(env.HR_AGENT_SERIES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const num = (k, def) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    apiUrl, token, dir,
    colaDb: path.join(dir, 'cola.db'),
    padronJson: path.join(dir, 'padron.json'),
    sucursalId: String(env.HR_AGENT_SITE || '').trim(),
    relojes: series,
    intervalos: {
      backfillMin: num('HR_AGENT_BACKFILL_MIN', 60),     // NO 5: bajar el log completo de 12 relojes no cierra en 5 min
      keepaliveSeg: 45,                                  // los ZK cierran la sesión inactiva
      agrupaSeg: 5,                                      // espera antes de mandar, para agrupar el cambio de turno
      padronMin: num('HR_AGENT_PADRON_MIN', 30),         // cada cuánto se relee el padrón de la API
      vigilanciaMin: num('HR_AGENT_VIGILANCIA_MIN', 30), // sin que la API acepte NADA en este rato, se sale (k8s lo levanta)
    },
  };
}

module.exports = { configDelEntorno };
