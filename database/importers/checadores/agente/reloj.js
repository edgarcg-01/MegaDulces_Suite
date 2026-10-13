// api/agente/reloj.js
//
// EL CICLO DE VIDA DE UN RELOJ: descubrir → stream en vivo → backfill.
//
// ══ POR QUÉ HACEN FALTA LOS DOS, STREAM Y BACKFILL ══
//
// El stream (`getRealTimeLogs`) es lo que da el "en vivo": el reloj queda
// registrado para eventos y EMPUJA cada checada en el momento. Pero no es una
// fuente confiable por sí solo — si el agente estuvo caído media hora, esos
// eventos no se guardaron en ningún lado y se perdieron para siempre.
//
// El backfill es la red de seguridad: una lectura VERIFICADA del log completo.
// El protocolo ZK no permite pedir "solo lo nuevo", siempre se baja todo, y en
// 8-Esquinas eso son ~50 mil registros (≈2 MB). Por eso corre cada hora y no
// cada 5 minutos: intentarlo cada 5 min no cierra de forma confiable y lo único
// que se logra es encimar corridas.
//
// ══ UN RELOJ = UNA SESIÓN ══
//
// Los ZKTeco aceptan UNA SOLA sesión TCP en el 4370. El stream ocupa el socket.
// Para el backfill hay que DETENER el stream, hacer la lectura, y volver a
// levantarlo. Nunca los dos a la vez: si se intenta, el reloj deja de contestar
// y se ve exactamente igual que si estuviera apagado.

const { fmt, conectar, cerrar, leerVerificado, normalizarChecadas, normalizarUsuarios, motivo, serieCoincide } =
  require('./zk/lectura-verificada');
const { descubrir } = require('./descubrir');
const { ErrorEnvio } = require('./enviar');
const { ejecutarComando } = require('./escritura');

/**
 * Cada cuánto se preguntan los comandos pendientes (eliminar/renombrar). Un
 * minuto: es una consulta chica a la API y RH ve el resultado casi al momento.
 */
const COMANDOS_MS = 60 * 1000;

/** Tope para UN comando completo: leer padrón + escribir + releer. */
const LIMITE_ESCRITURA_MS = 3 * 60 * 1000;

const TAM_LOTE = 500;

/**
 * Al reenviar en un backfill, se retrocede un poco antes de la marca de agua.
 * Dos razones concretas: los relojes se corren de hora (se han visto minutos de
 * diferencia contra el servidor) y un evento del stream pudo llegar con la hora
 * del reloj ya movida. Reenviar de más es gratis —la API deduplica— y reenviar
 * de menos es un hueco que nadie va a notar.
 */
const MARGEN_MS = 36 * 60 * 60 * 1000;   // 36 h

/**
 * Tope para UN comando del reloj. Menos que `pollSeg` (30 s) a propósito: si el
 * vigía pudiera tardar más que su propio intervalo, las vueltas se encimarían.
 */
const LIMITE_COMANDO_MS = 15000;

/** Tope para el adiós cortés. Ver `soltarSocket`. */
const LIMITE_CIERRE_MS = 5000;

/**
 * Tope para abrir sesión. Más holgado que un comando suelto: `conectar` incluye
 * el TCP connect (que puede tardar lo suyo hasta un equipo apagado), el saludo y,
 * si el reloj lo pide, la autenticación.
 */
const LIMITE_CONEXION_MS = 45000;

/**
 * Tope para una lectura verificada completa. Muy holgado porque `leerVerificado`
 * reintenta por dentro y baja el log entero; lo que se corta con esto no es una
 * lectura lenta, es una colgada. Sigue muy por debajo de `backfillMin` (60 min),
 * así que nunca se encima con la siguiente vuelta.
 */
const LIMITE_BACKFILL_MS = 10 * 60 * 1000;

/**
 * Cada cuánto se le recuerda a la nube que este reloj sigue vivo. Por debajo de
 * los 10 min con los que el semáforo pone amarillo, para que un reloj sano se
 * vea verde de forma sostenida y el amarillo vuelva a ser una señal.
 */
const LATIDO_MS = 5 * 60 * 1000;

/**
 * ══ POR QUÉ TODO COMANDO AL RELOJ LLEVA TOPE DE TIEMPO ══
 *
 * node-zklib promete un timeout y NO lo cumple. `zklibtcp.writeMessage` arma su
 * temporizador DENTRO del callback de `socket.write` (zklibtcp.js:96):
 *
 *     this.socket.write(msg, null, async (err) => {
 *       if (err) { reject(err) }
 *       else if (this.timeout) { timer = await setTimeout(...) }
 *     });
 *
 * Cuando el socket queda medio abierto —el otro extremo dejó de contestar pero
 * nunca mandó FIN ni RST, que es lo que pasa al caerse el enlace de una plaza—
 * ese callback no corre nunca: el temporizador no se arma y la promesa NUNCA se
 * resuelve. Y `createSocket` llama a `socket.setTimeout()` sin poner escucha del
 * evento 'timeout' (zklibtcp.js:44), así que Node tampoco destruye el socket.
 *
 * Eso costó cuatro relojes mudos el 24/08/2026 (CEDIS, 192.168.0.196 y
 * Oficinas·comida a las 19:12; 8-Esquinas a las 20:03). El vigía se quedó en el
 * `await`, `fallosKeepalive` no subió, no hubo reconexión y no salió latido. El
 * proceso seguía vivo y los otros seis relojes trabajando, así que ni el
 * servicio ni el log delataban nada: el portal simplemente los dio por mudos 18
 * horas después.
 *
 * `Promise.race` NO cancela a la perdedora: el `await` original sigue colgado y
 * el socket sigue inservible. Por eso quien atrapa el vencimiento tiene que
 * destruir el socket (`destruirSocket`), o el siguiente comando se cuelga igual.
 */
function conLimite(promesa, ms, queEs) {
  // La promesa colgada rechaza tarde —al destruirse el socket— y para entonces
  // ya nadie la escucha. Sin este catch, cada vencimiento dejaría una
  // `unhandledRejection` en el log.
  promesa.catch(() => undefined);
  let t;
  return Promise.race([
    promesa,
    new Promise((_, rechaza) => {
      t = setTimeout(() => rechaza(new Error(`${queEs} no contestó en ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Cierre a la mala. `cerrar()` es cortés: le manda CMD_EXIT al reloj, y ese
 * comando viaja por el MISMO socket que puede estar colgado. Cuando el socket ya
 * no contesta, lo único que sirve es tirarlo.
 */
function destruirSocket(zk) {
  try { if (zk && zk.zklibTcp && zk.zklibTcp.socket) zk.zklibTcp.socket.destroy(); }
  catch { /* ya no estaba */ }
}

class RelojJob {
  constructor(reloj, deps) {
    this.reloj = { ...reloj };            // { serie, ip, puerto, commKey, sucursalId, alias }
    this.cola = deps.cola;
    this.enviador = deps.enviador;
    this.intervalos = deps.intervalos;
    this.log = (m) => deps.log(`[${this.etiqueta}] ${m}`);

    this.zk = null;
    this.corriendo = false;
    this.ocupado = false;                 // mutex: stream y backfill no conviven
    this.vigilando = false;               // una vuelta del vigía a la vez
    this.fallosKeepalive = 0;
    this.timers = {};
    this.ultimoError = null;
    this.infoReloj = null;
  }

  get etiqueta() { return this.reloj.alias || this.reloj.sucursalId || this.reloj.serie; }

  // ── Arranque / paro ──────────────────────────────────────────────
  async arrancar(retrasoBackfillMs = 0) {
    this.corriendo = true;
    await this.reconectar('arranque');
    // Los backfills se escalonan: si los 8 relojes bajan su log completo al
    // mismo tiempo, se saturan la red de la plaza y el enlace de salida.
    this.timers.comandos = setInterval(
      () => this.atenderComandos().catch((e) => this.log(`comandos: ${motivo(e)}`)), COMANDOS_MS);
    this.timers.backfill = setTimeout(() => {
      this.backfill().catch((e) => this.log(`backfill: ${motivo(e)}`));
      this.timers.backfillRepe = setInterval(
        () => this.backfill().catch((e) => this.log(`backfill: ${motivo(e)}`)),
        this.intervalos.backfillMin * 60000
      );
    }, retrasoBackfillMs);
  }

  // ── Comandos hacia el reloj (eliminar / renombrar usuarios) ─────────
  //
  // Van por la MISMA sesión del vigía y con el MISMO candado (`ocupado`): un ZK
  // acepta una sola sesión, y un comando encimado con una lectura es lo que lo
  // deja mudo. Si el candado está tomado (backfill en curso) se espera a la
  // siguiente vuelta; el comando no se pierde, sigue pendiente en la API.
  async atenderComandos() {
    if (!this.corriendo || !this.zk || this.ocupado) return;
    const pendientes = await this.enviador.comandosPendientes(this.reloj.serie);
    if (!pendientes.length || !this.zk || this.ocupado) return;

    this.ocupado = true;
    let sesionRota = false;
    try {
      for (const cmd of pendientes) {
        let resultado;
        try {
          resultado = await conLimite(
            ejecutarComando(this.zk, cmd, (m) => this.log(m)), LIMITE_ESCRITURA_MS, `el comando ${cmd.tipo}`);
        } catch (e) {
          // Error de sesión (timeout, socket caído): se reporta, se tira la
          // sesión y se reconecta. El comando vuelve a pendiente en la API.
          resultado = { estado: 'error', detalle: `sesión con el reloj: ${motivo(e)}` };
          sesionRota = true;
        }
        this.log(`${resultado.estado === 'hecho' ? '✏️' : '⚠'} ${cmd.tipo} #${cmd.empleadoCodigo}: ${resultado.detalle}`);
        try { await this.enviador.reportarComando(cmd.id, resultado); }
        catch (e) { this.log(`no se pudo reportar el comando ${cmd.id}: ${motivo(e)}`); }
        if (sesionRota) break;
      }
    } finally {
      if (sesionRota) destruirSocket(this.zk);
      this.ocupado = false;
    }
    if (sesionRota && this.corriendo) await this.reconectar('después de un comando');
  }

  async detener() {
    this.corriendo = false;
    for (const t of Object.values(this.timers)) { clearTimeout(t); clearInterval(t); }
    this.timers = {};
    await this.soltarSocket();
  }

  async soltarSocket() {
    const zk = this.zk;
    this.zk = null;
    if (!zk) return;
    // El adiós va por el socket que quizá esté colgado. Sin tope, SOLTAR el
    // socket colgaba a `reconectar()` con el mutex `ocupado` tomado — y el reloj
    // quedaba mudo exactamente por la razón que se estaba tratando de arreglar.
    try {
      await conLimite(cerrar(zk), LIMITE_CIERRE_MS, 'el cierre de sesión');
    } catch (e) {
      this.log(`cierre forzado: ${motivo(e)}`);
    } finally {
      destruirSocket(zk);
    }
  }

  // ── Conexión + stream en vivo ────────────────────────────────────
  async reconectar(porque) {
    if (!this.corriendo) return;
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      await this.soltarSocket();
      clearInterval(this.timers.keepalive);

      // Descubrimiento por serie: si la IP cambió, aquí se reencuentra.
      let ubicacion;
      try {
        ubicacion = await descubrir(this.reloj, (m) => this.log(m.trim()));
      } catch (e) {
        this.ultimoError = motivo(e);
        this.log(`❌ ${this.ultimoError}`);
        await this.enviador.latido(this.reloj.serie, { ip: this.reloj.ip, error: this.ultimoError });
        this.programarReintento();
        return;
      }
      if (ubicacion.cambio) this.reloj.ip = ubicacion.ip;

      // El tope va por fuera igual que en el vigía: el saludo también viaja por
      // `writeMessage`, y `timeoutMs` es la promesa incumplida de node-zklib.
      // Un `conectar` colgado aquí deja tomado el mutex `ocupado` para siempre,
      // que es peor que un vigía colgado: ya ni el reintento vuelve a entrar.
      const conexion = conectar(this.reloj.ip, {
        puerto: this.reloj.puerto, commKey: this.reloj.commKey, timeoutMs: 20000,
      });
      try {
        this.zk = await conLimite(conexion, LIMITE_CONEXION_MS, 'el saludo al reloj');
      } catch (e) {
        // ══ EL DESTRUCTOR VA SOLO EN EL CAMINO DE FALLO ══════════════
        //
        // Si el saludo vence, la conexión todavía puede completarse DESPUÉS y
        // dejar una sesión abierta contra el equipo. Un ZK acepta UNA sola, así
        // que ese socket huérfano nos cerraría la puerta a nosotros mismos.
        //
        // La versión anterior enganchaba aquí un `.then` que comparaba
        // `this.zk !== zk` para decidir si tirarlo, y estaba MAL: ese handler se
        // encola antes que la reanudación del `await`, así que corría cuando
        // `this.zk` todavía era null y daba "no es la mía" SIEMPRE. Resultado:
        // destruía la sesión que se acababa de abrir bien. El 27/08/2026 eso
        // tenía a los doce relojes reconectando ~1,000 veces al día y el camino
        // en vivo MUERTO —cero detecciones del vigía en toda la jornada—; la
        // asistencia solo entraba por el backfill horario y la pantalla iba
        // hasta una hora atrás. Verde en el semáforo, y atrasada.
        //
        // Colgarlo del `catch` quita el problema de raíz: aquí solo se llega
        // cuando de verdad no nos quedamos con la sesión.
        conexion.then((tardio) => destruirSocket(tardio), () => undefined);
        throw e;
      }

      try {
        this.infoReloj = await conLimite(this.zk.getInfo(), LIMITE_COMANDO_MS, 'getInfo de arranque');
        // Punto de partida del detector: lo que el reloj tiene AHORA se da por
        // "visto". A partir de aquí, cada checada nueva hace crecer este número
        // y eso es lo que dispara la lectura. Lo que haya cambiado mientras el
        // agente estuvo caído lo recupera el backfill inicial.
        if (this.infoReloj && Number.isFinite(this.infoReloj.logCounts)) {
          this.conteoVisto = this.infoReloj.logCounts;
        }
      } catch { this.infoReloj = null; }

      this.fallosKeepalive = 0;
      this.ultimoError = null;
      this.log(`🟢 vigilando ${this.reloj.ip} (${porque})`);
      await this.enviador.latido(this.reloj.serie, {
        ip: this.reloj.ip,
        infoReloj: this.infoReloj ? { logCounts: this.infoReloj.logCounts, userCounts: this.infoReloj.userCounts } : undefined,
      });

      // EL VIGÍA: consulta el conteo del reloj cada pollSeg. Barato (getInfo es
      // un comando chico). Cuando el número sube, alguien marcó → se baja el log
      // y se empuja lo nuevo. Reemplaza al stream (getRealTimeLogs), que no se
      // pudo comprobar en estos equipos; getInfo sí es de fiar.
      this.timers.keepalive = setInterval(
        () => this.vigilar(), (this.intervalos.pollSeg || 30) * 1000
      );
    } catch (e) {
      this.ultimoError = motivo(e);
      this.log(`❌ no se pudo abrir la sesión: ${this.ultimoError}`);
      await this.enviador.latido(this.reloj.serie, { ip: this.reloj.ip, error: this.ultimoError });
      this.programarReintento();
    } finally {
      this.ocupado = false;
    }
  }

  programarReintento() {
    clearTimeout(this.timers.reintento);
    const ms = this.enviador.siguienteEspera();
    this.timers.reintento = setTimeout(() => this.reconectar('reintento'), ms);
  }

  /**
   * EL VIGÍA — detecta el movimiento nuevo y de paso mantiene viva la sesión.
   *
   * Cada pollSeg consulta `getInfo()`. Hace dos cosas con una sola llamada:
   *   1. Keepalive: los ZK cierran la sesión inactiva sin avisar; este comando
   *      la mantiene. Dos fallos seguidos y se reconecta desde cero.
   *   2. Detección: si el reloj declara MÁS checadas que la última vez, alguien
   *      marcó → se baja el log y se empuja lo nuevo. Si el número no cambió, no
   *      se lee nada: el reloj no se toca de más y la red de la plaza queda
   *      libre. Ésta es la parte que hace que la asistencia entre sola.
   *
   * El resultado de getInfo se VALIDA antes de creerle: un logCounts absurdo se
   * trata como fallo de sesión, no como dato, para no disparar una lectura ni
   * publicar "el reloj tiene 3 mil millones de checadas" en el semáforo.
   */
  async vigilar() {
    if (!this.zk || this.ocupado) return;
    // Reentrada: con el tope de 15 s una vuelta no debería alcanzar a la
    // siguiente, pero el `await` de abajo puede irse a un backfill largo y el
    // intervalo sigue disparando. Dos vigías encimados sobre el mismo socket es
    // justo lo que un ZK no tolera.
    if (this.vigilando) return;
    this.vigilando = true;
    let info;
    try {
      info = await conLimite(this.zk.getInfo(), LIMITE_COMANDO_MS, 'el vigía');
      const sano = info && Number.isFinite(info.logCounts) &&
                   info.logCounts >= 0 && info.logCounts < 10_000_000 &&
                   Number.isFinite(info.userCounts) && info.userCounts < 100_000;
      if (!sano) throw new Error('getInfo devolvió números incoherentes');
      this.infoReloj = info;
      this.fallosKeepalive = 0;
    } catch (e) {
      this.fallosKeepalive++;
      this.log(`vigía ${this.fallosKeepalive}/2: ${motivo(e)}`);
      // Un vencimiento deja el socket inservible: la promesa de node-zklib sigue
      // colgada y cualquier comando que se mande después se cuelga igual. Se
      // reconecta de inmediato, sin esperar al segundo fallo.
      if (this.fallosKeepalive >= 2 || /no contestó en/.test(motivo(e))) {
        // `reconectar` toma el mutex `ocupado` de forma síncrona, así que no
        // hace falta soltar `vigilando` antes: ninguna vuelta se cuela.
        await this.reconectar('sesión perdida');
      }
      return;
    } finally {
      this.vigilando = false;
    }

    if (this.conteoVisto != null && info.logCounts > this.conteoVisto) {
      this.log(`+${info.logCounts - this.conteoVisto} checada(s) nueva(s) — bajando…`);
      await this.backfill('movimiento nuevo');
      return;
    }

    // ══ LATIDO PERIÓDICO ════════════════════════════════════════════
    //
    // Antes el latido solo salía al reconectar o al hacer backfill, y el
    // backfill es CADA HORA. Un reloj sano donde nadie checa —media mañana en
    // una plaza chica— pasaba cincuenta minutos de cada sesenta marcado como
    // "con retraso" en el portal, porque el semáforo pone amarillo a los 10 min
    // sin señal. Con la franja en amarillo casi siempre, el amarillo dejó de
    // querer decir algo y nadie volvió a mirarla.
    //
    // Ahora que el vigía ya está aquí cada 30 s preguntándole al reloj, mandar
    // el latido cuesta una petición chica cada 5 min. Sirve para tres cosas: el
    // verde vuelve a significar verde, un reloj trabado se ve en 10 min en vez
    // de en 2 h, y el vigilante global de index.js tiene señal fresca con la
    // cual medir.
    if (this.enviador.callado(this.reloj.serie) >= LATIDO_MS) {
      await this.enviador.latido(this.reloj.serie, {
        ip: this.reloj.ip,
        infoReloj: { logCounts: info.logCounts, userCounts: info.userCounts },
      });
    }
  }

  /**
   * Se agrupa unos segundos antes de mandar. En el cambio de turno entran 40
   * checadas en dos minutos; mandarlas una por una son 40 peticiones HTTPS
   * desde el enlace de una plaza. Con 5 s de espera siguen llegando muy por
   * debajo de los 90 s que se prometieron, y salen en uno o dos envíos.
   */
  programarEnvio() {
    if (this.timers.envio) return;
    this.timers.envio = setTimeout(() => {
      this.timers.envio = null;
      this.vaciarCola().catch((e) => this.log(`envío: ${motivo(e)}`));
    }, (this.intervalos.agrupaSeg || 5) * 1000);
  }

  // ── Envío ────────────────────────────────────────────────────────
  /**
   * Manda lo que haya pendiente de este reloj. Solo se marca como enviado lo
   * que la API confirmó: si el envío falla a medias, esas filas siguen en la
   * cola y salen en el siguiente intento.
   */
  async vaciarCola(extra = {}) {
    // Un solo vaciado a la vez por reloj. Sin esto, el temporizador del stream
    // y el vaciado del backfill pueden leer LAS MISMAS filas de la cola y
    // mandarlas dos veces: la API las deduplica, pero el conteo de "aceptadas"
    // que se reporta dejaría de significar algo.
    if (this.enviando) { this.reenviarAlTerminar = true; return 0; }
    this.enviando = true;
    let total = 0;
    try {
      total = await this.vaciarColaInterno(extra);
    } finally {
      this.enviando = false;
      if (this.reenviarAlTerminar) {
        this.reenviarAlTerminar = false;
        this.programarEnvio();
      }
    }
    return total;
  }

  async vaciarColaInterno(extra = {}) {
    let total = 0;
    // ══ LA LISTA DE USUARIOS VIAJA AUNQUE NO HAYA CHECADAS (29/09/2026) ══
    // Antes solo iba pegada al primer lote con checadas: si el respaldo no
    // traía checadas nuevas, la lista no se mandaba, y quien se acababa de
    // registrar en el reloj no aparecía en el sistema hasta que coincidiera un
    // respaldo con marcas nuevas (Ale #100 tardó casi tres meses). Ahora, sin
    // checadas pendientes, sale un lote vacío que solo trae el padrón.
    if (extra.usuarios && extra.usuarios.length && !this.cola.pendientes(this.reloj.serie, 1).length) {
      await this.enviador.enviarLote({
        serie: this.reloj.serie,
        ip: this.reloj.ip,
        origen: 'agente',
        infoReloj: this.infoReloj ? {
          logCounts: this.infoReloj.logCounts,
          userCounts: this.infoReloj.userCounts,
          horaReloj: this.horaReloj ? this.horaReloj.toISOString() : undefined,
        } : undefined,
        usuarios: extra.usuarios,
        checadas: [],
        completa: !!extra.completa,
      });
      return 0;
    }
    for (;;) {
      const filas = this.cola.pendientes(this.reloj.serie, TAM_LOTE);
      if (!filas.length) break;
      const ultima = filas[filas.length - 1];
      const esUltimo = filas.length < TAM_LOTE;
      try {
        const r = await this.enviador.enviarLote({
          serie: this.reloj.serie,
          ip: this.reloj.ip,
          origen: 'agente',
          infoReloj: this.infoReloj ? {
            logCounts: this.infoReloj.logCounts,
            userCounts: this.infoReloj.userCounts,
            horaReloj: this.horaReloj ? this.horaReloj.toISOString() : undefined,
          } : undefined,
          usuarios: extra.usuarios && total === 0 ? extra.usuarios : undefined,
          checadas: filas.map((f) => ({ codigo: f.codigo, fechaHora: f.fechaHora, tipo: f.tipo })),
          completa: !!extra.completa && esUltimo,
        });
        this.cola.confirmar(filas.map((f) => f.id));
        this.cola.subirMarca(this.reloj.serie, ultima.fechaHora, !!extra.completa);
        total += filas.length;
        this.enviador.reiniciarEspera();
        if (r.pausado) {
          this.log(`⏸ el padrón tiene este reloj EN PAUSA: la API guardó el lote pero no lo aplicó.`);
          break;
        }
      } catch (e) {
        if (e instanceof ErrorEnvio && !e.reintentable) {
          // La API ya archivó el lote crudo; reintentar solo llenaría
          // `ingesta_lotes` de copias. Se confirma para que la cola avance y se
          // deja el aviso, que es lo que hay que resolver a mano.
          this.cola.confirmar(filas.map((f) => f.id));
          this.log(`⚠ ${e.message}`);
          this.log('  El dato NO se perdió: quedó guardado en la API sin aplicar. ' +
                   'Se aplica solo cuando el reloj esté dado de alta (reprocesar lotes).');
          continue;
        }
        // Reintentable: se deja en la cola y se vuelve más tarde. Esto es lo
        // que hace que un corte de internet de una hora no cueste checadas.
        const ms = this.enviador.siguienteEspera();
        this.log(`⚠ ${motivo(e)} — quedan ${filas.length}+ en la cola, reintento en ${Math.round(ms / 1000)}s`);
        clearTimeout(this.timers.envio);
        this.timers.envio = setTimeout(() => {
          this.timers.envio = null;
          this.vaciarCola().catch(() => undefined);
        }, ms);
        return total;
      }
    }
    return total;
  }

  // ── Backfill ─────────────────────────────────────────────────────
  /**
   * Lectura VERIFICADA del log completo. Si no se puede verificar contra
   * `info.logCounts`, `leerVerificado` lanza y no se encola nada: nunca se
   * carga una lectura parcial.
   */
  async backfill(porque = 'programado') {
    if (!this.corriendo || this.ocupado) return;
    this.ocupado = true;
    const t0 = Date.now();
    try {
      // La sesión del vigía ocupa el socket. Se suelta ANTES de leer: los ZK
      // aceptan UNA sola sesión a la vez.
      clearInterval(this.timers.keepalive);
      await this.soltarSocket();

      this.log(`backfill (${porque}): leyendo el log completo…`);
      // También lleva tope, y por lo mismo: `leerVerificado` abre su propio
      // socket y pasa por el mismo `writeMessage` que puede no resolver nunca.
      // Colgarse AQUÍ es lo más caro de todo — se queda con el mutex `ocupado`,
      // así que el vigía deja de mirar el reloj y el reintento no vuelve a
      // entrar. El tope es holgado a propósito: el backfill de 8-Esquinas son
      // ~50 mil registros y se ha visto tardar más de un minuto.
      const lectura = await conLimite(
        leerVerificado(this.reloj.ip, {
          puerto: this.reloj.puerto, commKey: this.reloj.commKey,
          log: (m) => this.log(m.trim()),
        }),
        LIMITE_BACKFILL_MS, 'la lectura verificada'
      );

      if (lectura.serie && !serieCoincide(this.reloj.serie, lectura.serie)) {
        throw new Error(`ESTA IP YA NO ES ESTE RELOJ: esperaba ${this.reloj.serie} y contesta ` +
          `${lectura.serie}. No se encola nada para no atribuir las marcas a otra plaza.`);
      }
      this.infoReloj = lectura.info;
      this.horaReloj = lectura.horaReloj;
      // Ya está subido lo que el reloj tiene hasta este conteo: el vigía no debe
      // volver a dispararse hasta que el número CREZCA otra vez.
      if (Number.isFinite(lectura.info?.logCounts)) this.conteoVisto = lectura.info.logCounts;

      const todas = normalizarChecadas(lectura.logs);
      // Filtrado incremental: sin esto se reenviarían las ~50 mil checadas del
      // reloj cada hora. La API las descartaría igual, pero serían 2 MB de
      // subida por reloj por hora desde el enlace de la plaza.
      const marca = this.cola.marca(this.reloj.serie);
      let nuevas = todas;
      if (marca?.ultima_fecha_hora) {
        const corte = new Date(new Date(marca.ultima_fecha_hora).getTime() - MARGEN_MS);
        const corteTxt = fmt(corte).fechaHora;
        nuevas = todas.filter((c) => c.fechaHora >= corteTxt);
      }

      const encoladas = this.cola.encolar(this.reloj.serie, nuevas, 'backfill');
      this.log(`backfill: ${todas.length} en el reloj · ${nuevas.length} desde la marca · ` +
               `${encoladas} nuevas a la cola (${Math.round((Date.now() - t0) / 1000)}s)`);

      const usuarios = normalizarUsuarios(lectura.users);
      await this.vaciarCola({ completa: true, usuarios });

      if (lectura.horaReloj) {
        const desfase = Math.round((lectura.horaReloj.getTime() - Date.now()) / 1000);
        if (Math.abs(desfase) > 120) {
          this.log(`⚠ el reloj va ${desfase > 0 ? 'adelantado' : 'atrasado'} ${Math.abs(desfase)}s. ` +
            'La tolerancia se está aplicando sobre una hora falsa: se corrige en el equipo.');
        }
      }
    } catch (e) {
      this.ultimoError = motivo(e);
      this.log(`❌ backfill: ${this.ultimoError}`);
      await this.enviador.latido(this.reloj.serie, { ip: this.reloj.ip, error: this.ultimoError });
    } finally {
      this.ocupado = false;
      // Vuelve el stream. Si esto falla, `reconectar` deja programado su propio
      // reintento — el reloj no se queda sin nadie que lo vigile.
      if (this.corriendo) await this.reconectar('después del backfill');
    }
  }
}

module.exports = { RelojJob, TAM_LOTE, MARGEN_MS };
