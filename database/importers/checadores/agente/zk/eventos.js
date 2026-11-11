// database/importers/checadores/agente/zk/eventos.js
//
// `[RH.1.3]` EL RELOJ AVISA CADA CHECADA — sin preguntarle cada 30 s ni releer su memoria completa.
//
// Medido el 2026-11-11 en prod (prueba de 8 min, `md:~/rh-prueba-eventos-zk-*.txt`): registrados a eventos de checada
// (CMD_REG_EVENT con EF_ATTLOG), 8-Esquinas (CEZU) mandó 15 y Morelia Abastos (3266) 4, cada uno EN EL INSTANTE de
// la checada, en paquetes de 52 bytes que `decodeRecordRealTimeLog52` lee bien. Oficinas (UEED) no mandó ninguno en la
// ventana (sin confirmar si fue porque nadie checó). Antes se creía que el «en vivo» no funcionaba en estos equipos.
//
// ⛔ La trampa: los avisos llegan por la MISMA sesión que las respuestas a los comandos, y `node-zklib` atiende cada
// respuesta con escuchadores que pone y quita del socket. Un aviso que cae mientras espera una respuesta se lo tragaría
// como si fuera la respuesta. Por eso los avisos se apartan ANTES de que los vea la librería: se envuelve
// `socket.emit('data')`, se parte el trozo en paquetes ZK (magia + largo), los de aviso se atienden aquí (con su acuse,
// como pyzk `live_capture`) y lo demás sigue a `node-zklib` intacto.
'use strict';

// Constantes del protocolo ZK (las mismas de `node-zklib/constants`), locales para poder probar esto sin la librería
// (vive sólo en la imagen de ingesta, no en el entorno de pruebas del CI).
const CMD_REG_EVENT = 500;
const CMD_ACK_OK = 2000;
const MAGIA = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const ACUSE_REPLY_ID = 0xfffe;   // el que usa pyzk para el acuse de un aviso

/** Parte un trozo del socket en paquetes ZK (cabecera TCP de 8 bytes: magia + largo). Lo que no cuadra va entero al final. */
function partirPaquetes(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length && buf.subarray(i, i + 4).equals(MAGIA)) {
    const fin = i + 8 + buf.readUInt32LE(i + 4);
    if (fin > buf.length) break;
    out.push(buf.subarray(i, fin));
    i = fin;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return out;
}

/** ¿Es un aviso del reloj? (comando CMD_REG_EVENT en la cabecera ZK, después de los 8 bytes TCP). */
function esAviso(pkt) {
  return pkt.length >= 16 && pkt.subarray(0, 4).equals(MAGIA) && pkt.readUInt16LE(8) === CMD_REG_EVENT;
}

/**
 * Registra la sesión a avisos de checada y los aparta de `node-zklib`. `alChecada({ userId, recordTime })` por cada
 * checada avisada (mismo formato que `normalizarChecadas`). Devuelve `soltar()`, que deja el socket como estaba.
 */
function escucharAvisosDelReloj(zk, { alChecada, log, utils = require('node-zklib/utils') }) {
  const tcp = zk.zklibTcp;
  const socket = tcp.socket;
  const emitOriginal = socket.emit;

  socket.emit = function emitConAvisos(evento, ...args) {
    if (evento !== 'data' || !Buffer.isBuffer(args[0])) return emitOriginal.call(this, evento, ...args);
    const resto = [];
    for (const pkt of partirPaquetes(args[0])) {
      if (!esAviso(pkt)) { resto.push(pkt); continue; }
      try { socket.write(utils.createTCPHeader(CMD_ACK_OK, tcp.sessionId, ACUSE_REPLY_ID, Buffer.alloc(0))); } catch { /* el acuse es de cortesía */ }
      if (pkt.length !== 52) { log(`aviso de ${pkt.length} B (no es el de 52): no se decodifica; el árbitro lo recoge`); continue; }
      try {
        const r = utils.decodeRecordRealTimeLog52(pkt);
        alChecada({ userId: r.userId, recordTime: r.attTime });
      } catch (e) {
        log(`aviso ilegible: ${e && e.message}; el árbitro lo recoge`);
      }
    }
    if (!resto.length) return true;
    return emitOriginal.call(this, evento, resto.length === 1 ? resto[0] : Buffer.concat(resto));
  };

  tcp.replyId++;
  socket.write(utils.createTCPHeader(CMD_REG_EVENT, tcp.sessionId, tcp.replyId, Buffer.from([0x01, 0x00, 0x00, 0x00])));
  return () => { socket.emit = emitOriginal; };
}

module.exports = { escucharAvisosDelReloj, partirPaquetes, esAviso };
