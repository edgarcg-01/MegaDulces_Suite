// api/agente/descubrir.js
//
// RESUELVE serie ⇄ IP. Esto es lo que arregla el DHCP.
//
// Morelia Madero (192.168.32.215) tiene DHCP ENCENDIDO. Con el importador viejo
// —que identificaba los relojes por IP— bastaba con que el equipo se reiniciara
// para que esa plaza dejara de bajar, sin un solo mensaje de error: simplemente
// dejaban de llegar checadas y la pantalla seguía mostrando lo último que había.
// Peor: si otro equipo tomaba esa dirección, sus marcas entraban bajo la
// sucursal equivocada.
//
// Aquí la identidad es la SERIE. La IP es una pista, y cuando la pista falla se
// barre la /24 buscando al equipo por su nombre real.
//
// ⚠️ Esto NO sustituye el trabajo de campo: hay que ponerle IP fija o
// reservación DHCP a esos relojes. Lo que hace es que mientras tanto no se
// pierda un solo día de asistencia.

const net = require('net');
const { conectar, cerrar, leerSerie, motivo, serieCoincide } = require('./zk/lectura-verificada');

const TIMEOUT_TCP_MS = 800;
const CONCURRENCIA = 32;

/** ¿Hay algo escuchando el 4370 en esta dirección? */
function puertoAbierto(ip, puerto, timeout = TIMEOUT_TCP_MS) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let hecho = false;
    const fin = (ok) => { if (hecho) return; hecho = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(puerto, ip);
  });
}

/** Abre sesión, lee la serie y cierra. Devuelve null si no se pudo. */
async function serieDe(ip, puerto, commKey) {
  let zk = null;
  try {
    zk = await conectar(ip, { puerto, timeoutMs: 8000, commKey });
    return await leerSerie(zk);
  } catch { return null; }
  finally { await cerrar(zk); }
}

/** '192.168.32.215' → las 254 direcciones de su /24. */
function vecindario(ip) {
  const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(String(ip || '').trim());
  if (!m) return [];
  const base = m[1];
  const propia = parseInt(m[2], 10);
  const lista = Array.from({ length: 254 }, (_, i) => i + 1);
  // Se empieza por las direcciones CERCANAS a la última conocida: cuando el
  // DHCP mueve un equipo, casi siempre lo deja a unos pocos números.
  lista.sort((a, b) => Math.abs(a - propia) - Math.abs(b - propia));
  return lista.map((n) => `${base}.${n}`);
}

/**
 * Encuentra el reloj `serie`. Devuelve `{ ip, cambio, motivo }` o lanza.
 *
 * 1. Se prueba la IP guardada.
 * 2. Si contesta y la serie coincide → listo (el caso normal, sin barrido).
 * 3. Si no contesta, o contesta OTRA serie → se barre su /24.
 * 4. Si aparece en otra dirección → se usa y se avisa (la API guarda ip_vista).
 * 5. Si no aparece → se reporta 'mudo' con el motivo exacto, no un "no responde".
 */
async function descubrir(reloj, log = console.log) {
  const puerto = reloj.puerto || 4370;
  const esperada = reloj.serie;

  // Paso 1-2 — la IP guardada.
  if (reloj.ip) {
    const abierto = await puertoAbierto(reloj.ip, puerto);
    if (abierto) {
      const serie = await serieDe(reloj.ip, puerto, reloj.commKey);
      if (serie && serieCoincide(esperada, serie)) return { ip: reloj.ip, cambio: false };
      if (serie && serie !== esperada) {
        log(`  ⚠ ${reloj.ip} contesta pero es la serie ${serie}, no ${esperada}. Buscando…`);
      } else {
        log(`  ⚠ ${reloj.ip} abre el ${puerto} pero no dio serie (¿otra sesión abierta, o comm key?). Buscando…`);
      }
    } else {
      log(`  ⚠ ${reloj.ip} no abre el ${puerto}. Buscando en su red…`);
    }
  }

  // Paso 3 — barrido de la /24.
  const candidatas = vecindario(reloj.ip).filter((x) => x !== reloj.ip);
  if (!candidatas.length) {
    throw new Error(`sin IP de referencia para buscar la serie ${esperada}: pon una en el padrón`);
  }

  const abiertas = [];
  let siguiente = 0;
  await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
    while (siguiente < candidatas.length) {
      const ip = candidatas[siguiente++];
      if (await puertoAbierto(ip, puerto)) abiertas.push(ip);
    }
  }));

  if (!abiertas.length) {
    throw new Error(
      `no hay ningún equipo con el ${puerto} abierto en la red de ${reloj.ip}. ` +
      'El reloj está apagado, desconectado del cable, o en otra subred.');
  }

  // Paso 4 — identificar a los que abrieron.
  for (const ip of abiertas) {
    const serie = await serieDe(ip, puerto, reloj.commKey);
    if (serieCoincide(esperada, serie)) {
      log(`  ✅ ${esperada} reencontrado en ${ip} (antes ${reloj.ip}). Ponle IP fija o reservación DHCP.`);
      return { ip, cambio: true, anterior: reloj.ip };
    }
  }

  // Paso 5 — hay relojes, pero ninguno es este.
  throw new Error(
    `la serie ${esperada} no está en la red de ${reloj.ip}. Sí contestaron ${abiertas.length} ` +
    `equipo(s) (${abiertas.slice(0, 5).join(', ')}${abiertas.length > 5 ? '…' : ''}) pero con otra serie. ` +
    'El reloj está apagado o lo movieron de plaza.');
}

module.exports = { descubrir, puertoAbierto, serieDe, vecindario, motivo };
