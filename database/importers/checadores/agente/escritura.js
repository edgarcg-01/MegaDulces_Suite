// api/agente/escritura.js
//
// ESCRIBIR EN EL RELOJ: borrar o renombrar a UN usuario (27/09/2026).
//
// Hasta hoy el agente solo leía. RH pidió eliminar personas "del sistema y de
// los checadores" y cambiarles el nombre desde el portal. El portal deja un
// comando en `reloj_comandos`; este módulo lo ejecuta DENTRO de la sesión que
// el RelojJob ya tiene abierta (un ZK acepta una sola) y con su candado tomado.
//
// node-zklib no trae setUser ni deleteUser: se mandan los comandos del
// protocolo a mano con `executeCmd`, igual que hace pyzk:
//   · borrar:    CMD_DELETE_USER con el uid INTERNO del equipo (2 bytes LE).
//   · renombrar: CMD_USER_WRQ con el registro de 72 bytes. Se COPIA el que el
//                reloj tiene y solo se sobrescriben los 24 bytes del nombre
//                (offset 11): contraseña, tarjeta, privilegio y grupo quedan
//                exactamente como estaban.
//   · después:   CMD_REFRESHDATA, para que el equipo recargue su padrón.
//
// Tres reglas que no se negocian:
//   1. El uid se saca de una lectura FRESCA en esta misma sesión, nunca de un
//      dato guardado: el uid interno cambia si alguien reenrola en el equipo, y
//      borrar el uid equivocado es borrarle la huella a otra persona.
//   2. Antes de tocar nada se guarda el respaldo (el registro crudo).
//   3. "Hecho" quiere decir VERIFICADO: se vuelve a leer el padrón del reloj y
//      se comprueba que el cambio quedó. Un ACK del equipo no basta.

const { COMMANDS } = require('node-zklib/constants');
const { leerUsuariosCrudos } = require('./zk/lector-zk');

const OFFSET_NOMBRE = 11;
const LARGO_NOMBRE = 24;

function aceptado(respuesta) {
  return !!respuesta && respuesta.length >= 2 && respuesta.readUInt16LE(0) === COMMANDS.CMD_ACK_OK;
}

function codigoRespuesta(respuesta) {
  return respuesta && respuesta.length >= 2 ? respuesta.readUInt16LE(0) : 'sin respuesta';
}

/** Lo mismo que hace la API (reloj-comandos.ts::nombreParaReloj): ASCII, 23 máx. */
function nombreParaReloj(t) {
  return String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .-]/g, '')
    .replace(/\s+/g, ' ').trim()
    .slice(0, LARGO_NOMBRE - 1).trim();
}

function respaldoDe(u) {
  return {
    uid: u.uid, userId: u.userId, nombre: u.name, privilegio: u.role, tarjeta: u.cardno,
    crudo: u.crudo.toString('base64'), leidoEn: new Date().toISOString(),
  };
}

/**
 * Ejecuta UN comando contra el reloj de la sesión `zk`.
 * Devuelve { estado: 'hecho'|'error', detalle, respaldo? }. No lanza por un
 * rechazo del equipo; SÍ deja escapar los errores de socket (timeout, sesión
 * caída), para que quien llama tire la sesión y reconecte.
 */
async function ejecutarComando(zk, cmd, log = () => undefined) {
  const codigo = String(cmd.empleadoCodigo || '').trim();
  if (!codigo) return { estado: 'error', detalle: 'el comando no trae código de empleado' };
  if (!['borrar_usuario', 'renombrar_usuario', 'restaurar_usuario'].includes(cmd.tipo)) {
    return { estado: 'error', detalle: `tipo de comando desconocido: ${cmd.tipo}` };
  }
  const tcp = zk.zklibTcp;
  if (cmd.tipo === 'restaurar_usuario') return restaurar(zk, tcp, cmd, codigo, log);

  // 1) Lectura fresca: ¿está, y con qué uid?
  const antes = await leerUsuariosCrudos(zk);
  const coinciden = antes.filter((u) => String(u.userId).trim() === codigo);
  if (coinciden.length > 1) {
    // Dos registros con el mismo código es un padrón roto; no se adivina cuál.
    return { estado: 'error', detalle: `el reloj tiene ${coinciden.length} usuarios con el código ${codigo}; revisar a mano` };
  }
  const u = coinciden[0];
  if (!u) {
    return cmd.tipo === 'borrar_usuario'
      ? { estado: 'hecho', detalle: 'no estaba enrolado en este reloj (nada que borrar)' }
      : { estado: 'hecho', detalle: 'no está enrolado en este reloj (nada que renombrar)' };
  }
  const respaldo = respaldoDe(u);

  let nombreNuevo = null;
  let registro = null;
  if (cmd.tipo === 'renombrar_usuario') {
    nombreNuevo = nombreParaReloj(cmd.payload && cmd.payload.nombre);
    if (!nombreNuevo) return { estado: 'error', detalle: 'el nombre nuevo quedó vacío', respaldo };
    if ((u.name || '').trim() === nombreNuevo) {
      return { estado: 'hecho', detalle: `ya se llamaba "${nombreNuevo}"`, respaldo };
    }
    registro = Buffer.from(u.crudo);
    registro.fill(0, OFFSET_NOMBRE, OFFSET_NOMBRE + LARGO_NOMBRE);
    Buffer.from(nombreNuevo, 'ascii').copy(registro, OFFSET_NOMBRE);
  }

  // 2) Escribir con el equipo en pausa (no acepta checadas mientras tanto: son
  //    segundos) y SIEMPRE devolverlo a la normalidad, pase lo que pase.
  await tcp.disableDevice();
  let respuesta;
  try {
    respuesta = cmd.tipo === 'borrar_usuario'
      ? await tcp.executeCmd(COMMANDS.CMD_DELETE_USER, (() => { const b = Buffer.alloc(2); b.writeUInt16LE(u.uid, 0); return b; })())
      : await tcp.executeCmd(COMMANDS.CMD_USER_WRQ, registro);
    if (aceptado(respuesta)) await tcp.executeCmd(COMMANDS.CMD_REFRESHDATA, '');
  } finally {
    // Traslado textual de Mega Talento: si el equipo no se reactiva tras escribir, el error DEBE subir
    // aunque haya otro en curso (un reloj deshabilitado no checa).
    // eslint-disable-next-line no-unsafe-finally
    try { await tcp.enableDevice(); } catch (e) { log(`⚠ no se pudo reactivar el equipo tras escribir: ${e.message}`); throw e; }
  }
  if (!aceptado(respuesta)) {
    return { estado: 'error', detalle: `el reloj rechazó el comando (respuesta ${codigoRespuesta(respuesta)})`, respaldo };
  }

  // 3) Verificar leyendo otra vez.
  const despues = await leerUsuariosCrudos(zk);
  const ahora = despues.find((x) => String(x.userId).trim() === codigo);
  if (cmd.tipo === 'borrar_usuario') {
    return ahora
      ? { estado: 'error', detalle: 'el reloj aceptó el borrado pero el usuario sigue ahí', respaldo }
      : { estado: 'hecho', detalle: `borrado y verificado (uid ${u.uid}, era "${u.name}")`, respaldo };
  }
  if (!ahora) return { estado: 'error', detalle: 'tras renombrar, el usuario ya no aparece en el reloj', respaldo };
  const quedo = (ahora.name || '').trim();
  return quedo === nombreNuevo
    ? { estado: 'hecho', detalle: `renombrado y verificado: "${u.name}" → "${quedo}"`, respaldo }
    : { estado: 'error', detalle: `el reloj aceptó pero quedó "${quedo}" en vez de "${nombreNuevo}"`, respaldo };
}

/**
 * REGRESAR DE LA PAPELERA: vuelve a dar de alta en el reloj a alguien que se
 * borró antes, con el registro de 72 bytes que se respaldó al borrarlo.
 *
 * Tres cuidados:
 *   · Si ya está en el reloj (alguien lo volvió a enrolar a mano), no se toca.
 *   · Si su lugar interno (uid) lo ocupa OTRA persona, no se escribe: pisarlo
 *     sería borrarle el registro a esa otra persona. Se reporta para verlo a mano.
 *   · La huella y el rostro NO vienen en el respaldo: la persona queda dada de
 *     alta con su número, nombre, tarjeta y contraseña, y hay que registrarle la
 *     huella otra vez en el equipo.
 */
async function restaurar(zk, tcp, cmd, codigo, log) {
  const r = cmd.payload && cmd.payload.respaldo;
  if (!r || !r.crudo) return { estado: 'error', detalle: 'el comando no trae el respaldo del usuario' };
  const registro = Buffer.from(r.crudo, 'base64');
  if (registro.length !== 72) return { estado: 'error', detalle: `el respaldo mide ${registro.length} bytes, se esperaban 72` };

  const antes = await leerUsuariosCrudos(zk);
  if (antes.some((u) => String(u.userId).trim() === codigo)) {
    return { estado: 'hecho', detalle: 'ya estaba dado de alta en este reloj (nada que restaurar)' };
  }
  const ocupa = antes.find((u) => u.uid === r.uid);
  if (ocupa) {
    return { estado: 'error', detalle: `su lugar en el reloj (uid ${r.uid}) ya lo ocupa #${ocupa.userId} "${ocupa.name}"; darlo de alta a mano` };
  }

  await tcp.disableDevice();
  let respuesta;
  try {
    respuesta = await tcp.executeCmd(COMMANDS.CMD_USER_WRQ, registro);
    if (aceptado(respuesta)) await tcp.executeCmd(COMMANDS.CMD_REFRESHDATA, '');
  } finally {
    // Traslado textual de Mega Talento: si el equipo no se reactiva tras escribir, el error DEBE subir
    // aunque haya otro en curso (un reloj deshabilitado no checa).
    // eslint-disable-next-line no-unsafe-finally
    try { await tcp.enableDevice(); } catch (e) { log(`⚠ no se pudo reactivar el equipo tras escribir: ${e.message}`); throw e; }
  }
  if (!aceptado(respuesta)) {
    return { estado: 'error', detalle: `el reloj rechazó el alta (respuesta ${codigoRespuesta(respuesta)})` };
  }
  const despues = await leerUsuariosCrudos(zk);
  const ahora = despues.find((u) => String(u.userId).trim() === codigo);
  return ahora
    ? { estado: 'hecho', detalle: `dado de alta otra vez como "${ahora.name}" (uid ${ahora.uid}); falta registrar su huella en el equipo` }
    : { estado: 'error', detalle: 'el reloj aceptó el alta pero la persona no aparece al volver a leer' };
}

module.exports = { ejecutarComando, nombreParaReloj };
