// api/tools/lectura-verificada.js
//
// LO MÁS VALIOSO DE ESTE MÓDULO: la garantía de que una lectura del reloj está
// COMPLETA o no se usa. Vivía dentro de `jalar-todo-zk.js` y por eso el agente
// nuevo (api/agente/) no podía reusarla sin copiarla — y una regla copiada es
// una regla que se va a divergir. Aquí queda una sola vez y la importan los dos:
//
//   · tools/jalar-todo-zk.js   (backfill manual / --directo)
//   · tools/diagnostico-red.js (paso 4: qué declara el reloj)
//   · agente/reloj.js          (backfill horario del servicio en la LAN)
//
// La corrección del truncamiento de `node-zklib` NO está aquí: está en
// tools/lector-zk.js, que es quien baja los bytes. Aquí está la VERIFICACIÓN.
//
// ⚠️ Regla de oro del proyecto: nunca cargar lecturas parciales. Si la lectura
// no se puede verificar contra `info.logCounts`, se LANZA y no se escribe nada.

const ZKLib = require('node-zklib');
const { COMMANDS } = require('node-zklib/constants');
const { leerChecadas, leerUsuarios } = require('./lector-zk');

const PUERTO_DEFAULT = parseInt(process.env.ZK_PORT || '4370', 10) || 4370;
// Reintentos cuando la lectura no cuadra con lo que el reloj declara.
// Calibrados contra los equipos reales: con pausa de 2.5 s un reloj falló 5 de
// 5 intentos; con 4 s pasó en el segundo.
const INTENTOS_DEFAULT = parseInt(process.env.ZK_INTENTOS || '8', 10) || 8;
const PAUSA_MS_DEFAULT = parseInt(process.env.ZK_PAUSA_MS || '4000', 10) || 4000;

// ──────────────────────────────────────────────────────────────────
// motivo(e) — node-zklib lanza OBJETOS, no Error: sin esto los fallos salen
// como "[object Object]" y no se distingue un reloj apagado de un bug propio.
// ──────────────────────────────────────────────────────────────────
function motivo(e) {
  if (!e) return 'error desconocido';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.err && e.err.message) return e.err.message;
  if (e.code) return `${e.code}${e.address ? ' ' + e.address : ''}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** ¿El error dice que no hay ruta hasta el equipo? Entonces no hay qué reintentar. */
function esInalcanzable(m) {
  return /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|TCP CONNECT/i.test(String(m));
}

// ──────────────────────────────────────────────────────────────────
// serieCoincide(esperada, leida) — ¿son el mismo reloj?
//
// La serie se lee con un solo comando chico y sin verificación de contenido, y
// de vez en cuando llega con UN byte cambiado (se vio "U=ED255000166" en vez de
// "UEED255000166": 0x45 'E' → 0x3D '='). El guardián que evita atribuir marcas a
// otra plaza tomaba esa corrupción por "cambió el reloj" y BLOQUEABA la lectura,
// tirando el dato de un equipo sano.
//
// Un cambio real de reloj (DHCP le dio la IP a otro equipo) produce una serie
// COMPLETAMENTE distinta, no una a un carácter de distancia. Así que se tolera
// una diferencia de un byte en cadenas del mismo largo —eso es ruido de
// lectura— y se bloquea solo cuando la serie es de verdad otra.
// ──────────────────────────────────────────────────────────────────
function serieCoincide(esperada, leida) {
  if (!esperada || !leida) return false;
  if (esperada === leida) return true;
  if (esperada.length !== leida.length) return false;
  let dif = 0;
  for (let i = 0; i < esperada.length; i++) if (esperada[i] !== leida[i]) dif++;
  return dif <= 1;
}

const pad = (n) => String(n).padStart(2, '0');
/** Date → las tres formas en que la base guarda una checada (hora LOCAL del reloj). */
function fmt(d) {
  const y = d.getFullYear(), mo = pad(d.getMonth() + 1), da = pad(d.getDate());
  const h = pad(d.getHours()), mi = pad(d.getMinutes()), s = pad(d.getSeconds());
  return { fecha: `${y}-${mo}-${da}`, hora: `${h}:${mi}:${s}`, fechaHora: `${y}-${mo}-${da}T${h}:${mi}:${s}` };
}

// ──────────────────────────────────────────────────────────────────
// LA IDENTIDAD DEL RELOJ ES SU NÚMERO DE SERIE, NO SU IP.
//
// Media plaza corre con DHCP encendido (Morelia Madero, 192.168.32.215, es el
// caso documentado). Identificar por IP significa que en cuanto el equipo se
// reinicia la plaza deja de bajar y NADIE se entera: no hay error, simplemente
// dejan de llegar checadas. Con la serie, el agente lo reencuentra solo.
//
// Se lee con CMD_OPTIONS_RRQ '~SerialNumber'. Se saca por expresión regular del
// buffer completo y no por offset fijo, porque el offset cambia entre firmwares
// y un offset equivocado devuelve basura que PARECE una serie.
//
// EL TERMINADOR NO SIEMPRE ES EL MISMO, Y ESO ROMPE LA IDENTIDAD.
//
// Medido el 20/08/2026 contra 192.168.30.253 (Morelia Abastos), tres lecturas
// seguidas en la MISMA sesion devolvieron el mismo numero con DOS cierres
// distintos: dos veces terminado en NUL y una vez terminado en '='. La clase
// del parseo se traga ese '=' y la serie sale de 14 caracteres una vez de cada
// tres.
//
// No es cosmetico: serieCoincide() exige MISMA LONGITUD, asi que la lectura
// sucia no empata con la del padron y el equipo pasa por "esta IP ya no es ese
// reloj" —justo la alarma que existe para que las marcas de una plaza no entren
// bajo otra—. Y si la sucia es la que queda GUARDADA en `relojes`, falla al
// reves: el agente reporta la limpia y la ingesta la rechaza por serie
// desconocida. Paso el 20/08/2026 al registrar este reloj.
//
// Las series son alfanumericas (CEZU201060011, 3266161700253), asi que se
// recorta lo que no sea letra o digito en los extremos.
// ──────────────────────────────────────────────────────────────────
async function leerSerie(zk) {
  const buf = await zk.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, '~SerialNumber');
  const txt = Buffer.isBuffer(buf) ? buf.toString('ascii') : String(buf || '');
  const m = /~SerialNumber\s*=\s*([^\0\r\n]*)/i.exec(txt);
  const serie = limpiarSerie(m ? m[1] : '');
  if (!serie) throw new Error('el reloj no devolvió número de serie');
  return serie;
}

/** Quita terminadores y espacios de los extremos de una serie leida del equipo. */
function limpiarSerie(s) {
  const t = String(s || '').trim();
  let i = 0, j = t.length;
  const alnum = (c) => /[A-Za-z0-9]/.test(c);
  while (i < j && !alnum(t[i])) i++;
  while (j > i && !alnum(t[j - 1])) j--;
  return t.slice(i, j);
}

/**
 * Hora del RELOJ (no la del servidor). CMD_GET_TIME devuelve 4 bytes con la
 * fecha codificada; los primeros 8 bytes de la respuesta son la cabecera de
 * comando (la librería ya quitó los 16 de TCP).
 *
 * Esto es el paso que nadie revisa y el que más daño hace: si el reloj está 6
 * minutos adelantado, la tolerancia de `horarios_sucursal.tolerancia_min` se
 * aplica sobre una hora falsa y RH ve retardos que no existen.
 */
async function leerHoraReloj(zk) {
  const buf = await zk.executeCmd(COMMANDS.CMD_GET_TIME, '');
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('respuesta de hora inesperada');
  let t = buf.readUInt32LE(8);
  const seg = t % 60; t = (t - seg) / 60;
  const min = t % 60; t = (t - min) / 60;
  const hor = t % 24; t = (t - hor) / 24;
  const dia = (t % 31) + 1; t = (t - (dia - 1)) / 31;
  const mes = t % 12; t = (t - mes) / 12;
  return new Date(t + 2000, mes, dia, hor, min, seg);
}

// ══════════════════════════════════════════════════════════════════
// EL SALUDO CON AUTENTICACIÓN — lo único que a node-zklib le faltaba
//
// Estos relojes (firmware ZMM220) contestan CMD_ACK_UNAUTH (2005) al saludo y
// EXIGEN un CMD_AUTH después, AUNQUE la clave sea 0. node-zklib nunca manda ese
// CMD_AUTH: su connect() manda CMD_CONNECT y da por buena cualquier respuesta
// (zklibtcp.js:57), así que cree que conectó y todo lo de después falla. Se veía
// como "pide contraseña" o "no responde", y no era ni una cosa ni la otra.
//
// pyzk (la librería de Python) SÍ hace el CMD_AUTH, y por eso el script de
// prueba leyó los 10 relojes con password=0 desde esta misma máquina. O sea que
// la clave real ES 0 — dato comprobado, no adivinado— y lo que había que
// arreglar era el protocolo, no encontrar una contraseña.
//
// claveComunicacion() es el make_commkey del firmware, portado byte por byte de
// pyzk: la clave se mezcla con el sessionId, se enmascara con "ZKSO", se
// intercambian los dos u16 y se aplica el tic. El último byte es el tic CRUDO,
// no XOR — ese era el bug de la versión anterior.
// ══════════════════════════════════════════════════════════════════
function claveComunicacion(clave, sessionId, ticks = 50) {
  let k = 0;
  const key = Number(clave) | 0;
  for (let i = 0; i < 32; i++) k = (key & (1 << i)) ? ((k << 1) | 1) : (k << 1);
  k = (k + Number(sessionId)) >>> 0;

  const b = Buffer.alloc(4);
  b.writeUInt32LE(k, 0);
  const x = Buffer.from([
    b[0] ^ 'Z'.charCodeAt(0), b[1] ^ 'K'.charCodeAt(0),
    b[2] ^ 'S'.charCodeAt(0), b[3] ^ 'O'.charCodeAt(0),
  ]);
  // Se intercambian los dos u16, como hace el firmware.
  const s = Buffer.alloc(4);
  s.writeUInt16LE(x.readUInt16LE(2), 0);
  s.writeUInt16LE(x.readUInt16LE(0), 2);

  // pyzk (base.py make_commkey): pack(BBBB, k0^B, k1^B, B, k3^B). El tic CRUDO
  // va en la posición 2, y la 3 es k3^B. Éste era el byte que estaba fuera de
  // lugar y hacía que hasta la clave correcta (0) se rechazara.
  const t = ticks & 0xff;
  return Buffer.from([s[0] ^ t, s[1] ^ t, t, s[3] ^ t]);
}

/** Manda CMD_AUTH sobre la sesión abierta. Lanza si el reloj no lo acepta. */
async function autenticar(tcp, commKey) {
  const paquete = claveComunicacion(commKey, tcp.sessionId);
  const rReply = await tcp.executeCmd(COMMANDS.CMD_AUTH, paquete);
  const cmd = rReply && rReply.length >= 2 ? rReply.readUInt16LE(0) : 0;
  if (cmd !== COMMANDS.CMD_ACK_OK) {
    throw new Error(
      `el reloj rechazó la autenticación (respondió ${cmd}); la comm_key ${commKey} no es la correcta`);
  }
  return true;
}

/**
 * Abre una sesión con el reloj, autenticando cuando hace falta.
 *
 * NO se usa el connect() de node-zklib: ese manda CMD_CONNECT y resuelve con
 * cualquier respuesta, sin mirar si fue UNAUTH y sin mandar CMD_AUTH. Aquí se
 * abre el socket, se hace el saludo a mano para poder LEER el commandId, y si el
 * reloj pide autenticación se le manda CMD_AUTH con la clave (0 por defecto,
 * que es la comprobada).
 *
 * ⚠️ Los ZKTeco aceptan UNA SOLA sesión TCP en el 4370. Por eso cada uso va con
 * su `cerrar()` en un finally, siempre.
 */
async function conectar(ip, opciones = {}) {
  const puerto = opciones.puerto || PUERTO_DEFAULT;
  const zk = new ZKLib(ip, puerto, opciones.timeoutMs || 20000, opciones.inportMs || 5000);

  // Solo abrimos el socket TCP; el saludo lo hacemos nosotros.
  await zk.zklibTcp.createSocket(opciones.onError, opciones.onClose);
  zk.connectionType = 'tcp';
  const tcp = zk.zklibTcp;

  try {
    // executeCmd(CMD_CONNECT) además fija tcp.sessionId, que CMD_AUTH necesita.
    const rReply = await tcp.executeCmd(COMMANDS.CMD_CONNECT, '');
    const cmd = rReply && rReply.length >= 2 ? rReply.readUInt16LE(0) : 0;

    if (cmd === COMMANDS.CMD_ACK_UNAUTH) {
      // La clave 0 está comprobada (pyzk lee con password=0). Si el padrón trae
      // otra en relojes.comm_key, se respeta.
      await autenticar(tcp, opciones.commKey != null && opciones.commKey !== '' ? opciones.commKey : 0);
    } else if (cmd !== COMMANDS.CMD_ACK_OK) {
      throw new Error(`el reloj respondió un comando inesperado al saludo (${cmd})`);
    }
    return zk;
  } catch (e) {
    await cerrar(zk);
    throw e;
  }
}

/** Cierre defensivo: nunca lanza, porque siempre se llama desde un finally. */
async function cerrar(zk) {
  if (!zk) return;
  try { await zk.disconnect(); } catch { /* el socket ya se había ido */ }
}

// ──────────────────────────────────────────────────────────────────
// leerVerificado(ip) — lee el reloj y GARANTIZA que la lectura esté completa,
// o lanza. Nunca devuelve datos parciales.
//
// Cómo se verifica: `info.logCounts` sí reporta el total correcto. Se lee ANTES
// y DESPUÉS de bajar las checadas, porque si alguien checa en medio el total
// sube — una lectura válida debe caer entre esos dos valores. Comparar contra un
// solo número daría falsos negativos justo en las horas de entrada y salida.
//
// Y se valida el CONTENIDO, no solo la cantidad: un desalineamiento de bytes
// produce el número correcto de registros con código vacío y fecha 2000-01-01.
// La cantidad cuadra y el dato no sirve.
// ──────────────────────────────────────────────────────────────────
async function leerVerificado(ip, opciones = {}) {
  const intentos = opciones.intentos || INTENTOS_DEFAULT;
  const pausaMs = opciones.pausaMs != null ? opciones.pausaMs : PAUSA_MS_DEFAULT;
  const log = opciones.log || (() => undefined);
  const historial = [];

  for (let intento = 1; intento <= intentos; intento++) {
    // Socket NUEVO en cada intento: reutilizarlo arrastra el buffer a medias.
    let zk = null;
    try {
      zk = await conectar(ip, opciones);
      const antes = await zk.getInfo();

      // La serie y la hora se leen en la MISMA sesión que las checadas: así el
      // lote que se manda no puede atribuirse a un equipo distinto del que se
      // acaba de leer (que es justo lo que pasa cuando la IP cambió de dueño).
      let serie = null;
      try { serie = await leerSerie(zk); } catch { /* firmware viejo: se sigue sin serie */ }
      let horaReloj = null;
      try { horaReloj = await leerHoraReloj(zk); } catch { /* idem */ }

      const users = await leerUsuarios(zk);
      const logs = await leerChecadas(zk);

      let despues = antes.logCounts;
      try { despues = (await zk.getInfo()).logCounts; } catch { /* se queda el de antes */ }

      const min = Math.min(antes.logCounts, despues);
      const max = Math.max(antes.logCounts, despues);
      const cantidadOk = logs.length >= min && logs.length <= max;
      const usuariosOk = antes.userCounts === undefined || users.length >= antes.userCounts;

      // Contenido creíble: con código y fecha posterior a 2001 (los relojes sin
      // hora configurada graban 2000-01-01).
      const sanos = logs.filter((x) => {
        const cod = String(x.deviceUserId ?? '').trim();
        const t = new Date(x.recordTime).getTime();
        return cod !== '' && Number.isFinite(t) && t > Date.UTC(2001, 0, 1);
      }).length;
      const contenidoOk = logs.length === 0 || sanos / logs.length >= 0.9;

      historial.push({ intento, dice: antes.logCounts, leidas: logs.length, sanos });

      if (cantidadOk && usuariosOk && contenidoOk) {
        return {
          users, logs, esperadas: min, intentos: intento,
          serie, horaReloj, ip,
          info: { logCounts: antes.logCounts, userCounts: antes.userCounts },
        };
      }
      const falla = !contenidoOk
        ? `contenido inválido (${sanos}/${logs.length} registros creíbles)`
        : !usuariosOk ? `usuarios incompletos (${users.length} de ${antes.userCounts})`
        : `checadas incompletas (${logs.length} de ${antes.logCounts})`;
      log(`    intento ${intento}/${intentos}: ${falla}`);
    } catch (e) {
      const m = motivo(e);
      log(`    intento ${intento}/${intentos}: ${m}`);
      // Sin conexión no hay nada que reintentar.
      if (esInalcanzable(m)) {
        throw new Error(`no se pudo conectar a ${ip}:${opciones.puerto || PUERTO_DEFAULT} — ${m}`);
      }
    } finally {
      // Siempre cerrar: estos equipos aceptan UNA sesión a la vez y dejarla
      // abierta los vuelve inaccesibles para el siguiente intento.
      await cerrar(zk);
    }
    if (intento < intentos) await new Promise((r) => setTimeout(r, pausaMs));
  }

  const mejor = Math.max(0, ...historial.map((h) => h.leidas || 0));
  const dice = historial.length ? historial[historial.length - 1].dice : '?';
  throw new Error(
    `lectura INCOMPLETA tras ${intentos} intentos: el reloj reporta ${dice} checadas y ` +
    `la mejor lectura fue ${mejor}. NO se carga nada.`);
}

/**
 * Convierte el log crudo del reloj al formato que espera la API
 * (`{ codigo, fechaHora, fecha, hora, tipo }`), dedup dentro del propio lote.
 * No decide sucursal ni traduce códigos: eso es del servidor, que es el único
 * que conoce `relojes` y `reloj_codigo_map`.
 */
function normalizarChecadas(logs) {
  const vistos = new Set();
  const filas = [];
  for (const l of logs || []) {
    const codigo = String(l.deviceUserId ?? l.userId ?? l.uid ?? '').trim();
    const t = l.recordTime instanceof Date ? l.recordTime : new Date(l.recordTime);
    if (!codigo || isNaN(t.getTime())) continue;
    const f = fmt(t);
    const clave = `${codigo}__${f.fechaHora}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    filas.push({ codigo, ...f, tipo: typeof l.tipo === 'number' ? l.tipo : null });
  }
  return filas;
}

/** Padrón del reloj → `[{ codigo, nombre }]`, sin códigos vacíos. */
function normalizarUsuarios(users) {
  const out = [];
  for (const u of users || []) {
    const codigo = String(u.userId ?? u.uid ?? '').trim();
    if (!codigo) continue;
    out.push({ codigo, nombre: (u.name || '').trim() || `Empleado ${codigo}` });
  }
  return out;
}

module.exports = {
  motivo, esInalcanzable, fmt, pad, serieCoincide,
  conectar, cerrar, leerSerie, limpiarSerie, leerHoraReloj, autenticar, claveComunicacion,
  leerVerificado, normalizarChecadas, normalizarUsuarios,
  PUERTO_DEFAULT, INTENTOS_DEFAULT, PAUSA_MS_DEFAULT,
};
