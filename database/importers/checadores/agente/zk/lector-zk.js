// api/tools/lector-zk.js
//
// LECTOR CORREGIDO DEL LOG DE LOS RELOJES ZKTECO.
//
// Reemplaza a `getAttendances()` y `getUsers()` de node-zklib, que TRUNCAN de
// forma no determinista y **no avisan**. Esto no es teórico: se midió contra
// los relojes de Mega Dulces y el de 8-Esquinas devolvía 3,273 / 32,735 /
// 49,103 / 49,936 registros en corridas distintas, al azar.
//
// ══ EL BUG, LEÍDO EN node_modules/node-zklib/zklibtcp.js ══
//
// `readWithBuffer()` hace tres cosas mal:
//
//   1. LÍNEA 313 — pide TODOS los trozos de golpe:
//        for (let i = 0; i <= numberChunks; i++) this.sendChunkRequest(...)
//      Sin await, sin control de flujo. Para 49,936 registros de 40 bytes son
//      ~2 MB, unas 31 peticiones simultáneas cuyas respuestas se entremezclan
//      en el flujo TCP.
//
//   2. LÍNEA 290 — da por recibido un trozo solo si el acumulado mide EXACTO
//      `MAX_CHUNK + 8`. TCP es un flujo continuo, no paquetes discretos: con
//      las respuestas entremezcladas esa igualdad se salta y el contador de
//      trozos nunca llega a cero.
//
//   3. LÍNEAS 261-271 — al vencer un temporizador de inactividad de 10 s llama
//      a `internalCallback(replyData, err)`, que hace **resolve**, no reject.
//      Un timeout devuelve una promesa EXITOSA con datos parciales.
//      Y `getAttendances` (línea 429) los propaga como `{ data, err }`.
//
// El importador hacía `((await zk.getAttendances()) || {}).data || []`:
// **ignoraba `err`**. Por eso ha estado cargando fracciones y reportando éxito.
//
// ══ LA CORRECCIÓN ══
//   · Se pide UN TROZO A LA VEZ, esperando a que llegue completo.
//   · Se desempaqueta por marco (longitud declarada en la cabecera) en vez de
//     exigir longitudes exactas.
//   · La autoridad es `size`, el total que declara el propio reloj.
//   · Si algo se atora, se LANZA. Nunca se devuelven datos parciales.
//
// Medido: 7 de 7 relojes con lectura completa, tres corridas seguidas, y
// validado registro por registro contra la librería (1,158 idénticos, 0 diffs).
//
// (Se probó también `disableDevice()` durante la lectura —práctica habitual con
// equipos ZK— y NO ayuda: el truncamiento no viene de que el reloj esté
// ocupado, sino de la contabilidad de paquetes.)

const { COMMANDS, REQUEST_DATA, MAX_CHUNK } = require('node-zklib/constants');
const {
  createTCPHeader, decodeTCPHeader, checkNotEventTCP,
  decodeRecordData40, decodeUserData72,
} = require('node-zklib/utils');

const TIMEOUT_TROZO_MS = parseInt(process.env.ZK_TIMEOUT_TROZO_MS || '25000', 10) || 25000;

// ──────────────────────────────────────────────────────────────────
// leerBloqueCompleto(tcp, reqData) — pide los datos por trozos secuenciales.
// Devuelve el buffer COMPLETO o lanza.
// ──────────────────────────────────────────────────────────────────
function leerBloqueCompleto(tcp, reqData) {
  // Traslado textual de Mega Talento (lector verificado en producción contra los 12 relojes); reescribirlo sin el
  // ejecutor async es otro commit, con su prueba contra un reloj.
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    tcp.replyId++;
    const cabecera = createTCPHeader(COMMANDS.CMD_DATA_WRRQ, tcp.sessionId, tcp.replyId, reqData);

    let respuesta;
    try { respuesta = await tcp.requestData(cabecera); }
    catch (e) { return reject(e); }

    const h = decodeTCPHeader(respuesta.subarray(0, 16));

    // Log chico: el reloj lo manda de una, sin trocear.
    if (h.commandId === COMMANDS.CMD_DATA) return resolve(respuesta.subarray(16));

    if (h.commandId !== COMMANDS.CMD_ACK_OK && h.commandId !== COMMANDS.CMD_PREPARE_DATA) {
      return reject(new Error(`el reloj respondió un comando inesperado (${h.commandId})`));
    }

    // El reloj declara cuántos bytes va a mandar. Esa es la autoridad.
    const total = respuesta.subarray(16).readUIntLE(1, 4);
    let datos = Buffer.alloc(0);       // payload final, ya limpio
    let pendiente = Buffer.alloc(0);   // bytes TCP sin desempaquetar
    let trozoActual = Buffer.alloc(0); // payload del trozo en curso

    // DOS niveles de encabezado, y hay que quitar los DOS. Omitir el segundo
    // hace que se decodifique basura CON EL CONTEO CORRECTO: registros con
    // código vacío y fecha 2000-01-01. La cantidad cuadra y el contenido no
    // sirve — es el error más peligroso de todo este archivo.
    //   · por MARCO TCP -> 16 bytes (como la librería en su línea 287)
    //   · por TROZO     ->  8 bytes (la librería lo hace aparte, línea 293)
    const alRecibir = (segmento) => {
      if (checkNotEventTCP(segmento)) return;
      pendiente = Buffer.concat([pendiente, segmento]);
      while (pendiente.length >= 8) {
        const largo = pendiente.readUIntLE(4, 2);
        if (pendiente.length < 8 + largo) break; // falta cola del marco
        trozoActual = Buffer.concat([trozoActual, pendiente.subarray(16, 8 + largo)]);
        pendiente = pendiente.subarray(8 + largo);
      }
    };
    tcp.socket.on('data', alRecibir);

    const alCerrarse = () => reject(new Error('el reloj cerró la conexión a media lectura'));
    tcp.socket.once('close', alCerrarse);

    try {
      for (let offset = 0; offset < total; offset += MAX_CHUNK) {
        const pedir = Math.min(MAX_CHUNK, total - offset);
        trozoActual = Buffer.alloc(0);
        tcp.sendChunkRequest(offset, pedir);

        // Se ESPERA este trozo completo antes de pedir el siguiente: eso
        // elimina la carrera que rompe a la librería.
        const esperado = pedir + 8;
        const t0 = Date.now();
        while (trozoActual.length < esperado) {
          if (Date.now() - t0 > TIMEOUT_TROZO_MS) {
            throw new Error(
              `se atoró el trozo en el byte ${offset}: llegaron ${trozoActual.length} de ${esperado} ` +
              `(total ${datos.length} de ${total})`);
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        datos = Buffer.concat([datos, trozoActual.subarray(8, esperado)]);
      }

      if (datos.length !== total) {
        throw new Error(`el reloj declaró ${total} bytes y se armaron ${datos.length}`);
      }
      resolve(datos);
    } catch (e) {
      reject(e);
    } finally {
      tcp.socket.removeListener('data', alRecibir);
      tcp.socket.removeListener('close', alCerrarse);
    }
  });
}

// ── Checadas ────────────────────────────────────────────────────────
// `z` es una instancia de ZKLib ya conectada. Devuelve el arreglo COMPLETO
// o lanza. Nunca devuelve datos a medias.
async function leerChecadas(z) {
  const tcp = z.zklibTcp;
  if (!tcp || !tcp.socket) throw new Error('no hay socket TCP abierto con el reloj');

  // freeData antes y después, igual que la librería: le dice al reloj que
  // suelte el buffer que preparó; sin eso la siguiente lectura sale corrupta.
  await tcp.freeData();
  const bruto = await leerBloqueCompleto(tcp, REQUEST_DATA.GET_ATTENDANCE_LOGS);
  await tcp.freeData();

  // 4 bytes de tamaño, luego registros de 40 bytes.
  let resto = bruto.subarray(4);
  const checadas = [];
  while (resto.length >= 40) {
    checadas.push({ ...decodeRecordData40(resto.subarray(0, 40)), ip: tcp.ip });
    resto = resto.subarray(40);
  }
  return checadas;
}

// ── Empleados ───────────────────────────────────────────────────────
// `getUsers()` de la librería usa el MISMO readWithBuffer, así que también
// puede truncar. Un padrón a medias es peor que ninguno: los empleados que no
// llegaron quedan como "códigos huérfanos" que checan sin existir.
async function leerUsuarios(z) {
  const tcp = z.zklibTcp;
  if (!tcp || !tcp.socket) throw new Error('no hay socket TCP abierto con el reloj');

  await tcp.freeData();
  const bruto = await leerBloqueCompleto(tcp, REQUEST_DATA.GET_USERS);
  await tcp.freeData();

  let resto = bruto.subarray(4);
  const usuarios = [];
  while (resto.length >= 72) {
    usuarios.push(decodeUserData72(resto.subarray(0, 72)));
    resto = resto.subarray(72);
  }
  return usuarios;
}

/**
 * Igual que `leerUsuarios`, pero cada usuario trae también su registro CRUDO
 * de 72 bytes (`crudo`). Lo usa la escritura (api/agente/escritura.js): para
 * renombrar se copia el registro tal cual y solo se cambian los bytes del
 * nombre, así no se tocan contraseña, tarjeta, privilegio ni grupo —campos que
 * `decodeUserData72` ni siquiera lee y que un re-armado en limpio pondría en
 * cero—. Y el crudo es el respaldo de lo que había antes de cualquier cambio.
 */
async function leerUsuariosCrudos(z) {
  const tcp = z.zklibTcp;
  if (!tcp || !tcp.socket) throw new Error('no hay socket TCP abierto con el reloj');

  await tcp.freeData();
  const bruto = await leerBloqueCompleto(tcp, REQUEST_DATA.GET_USERS);
  await tcp.freeData();

  let resto = bruto.subarray(4);
  const usuarios = [];
  while (resto.length >= 72) {
    const crudo = Buffer.from(resto.subarray(0, 72));
    usuarios.push({ ...decodeUserData72(crudo), crudo });
    resto = resto.subarray(72);
  }
  return usuarios;
}

module.exports = { leerChecadas, leerUsuarios, leerUsuariosCrudos, leerBloqueCompleto };
