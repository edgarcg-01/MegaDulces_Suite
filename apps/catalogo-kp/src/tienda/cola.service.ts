import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';

/**
 * Trabajador de la cola (Fase 2, entregable 7).
 *
 * PARA QUE EXISTE
 * El criterio de terminado de la Fase 2 dice: "ningun pedido se pierde si la
 * API se reinicia a medio proceso". Eso es esto. Un aviso de pago de Mercado
 * Pago no se puede perder porque la API se estaba reiniciando, y el 27/08/2026
 * quedo demostrado que se reinicia — 45 veces en una manana.
 *
 * POR QUE UNA TABLA Y NO REDIS
 * Decision ya tomada y documentada en PLAN_POR_FASES.md: 600 pedidos al mes no
 * justifican otro servicio que instalar, vigilar y respaldar con dos personas.
 * La cola es `tienda.trabajos`, creada por la migracion 002.
 *
 * QUE HACE Y QUE NO HACE
 * Esto es el MOTOR: toma trabajos, los reintenta con espera creciente, los da
 * por fallidos al agotar intentos y no pierde nada si el proceso muere. NO
 * trae manejadores de negocio: cobrar con Mercado Pago (entregable 5), mandar
 * la referencia de OXXO (6), avisar al cliente (10) y liberar autorizaciones
 * por vencer (11) son entregables aparte, y cada uno registra su manejador
 * aqui con `registrar()`.
 *
 * Mientras no haya manejadores registrados, la cola gira en vacio a proposito.
 * Encolar trabajos que nadie puede procesar solo acumularia filas fallidas.
 *
 * PORTADO A CATALOGO-KP (CV.5): el original abría su propia conexión Postgres
 * dedicada (`max:4`). Aquí usa la conexión Knex compartida de todo el app
 * (`KNEX_KP_CONCENTRADA`, `max:10`) — mismo criterio que el resto de los
 * servicios desde CV.0. Por eso `onModuleDestroy` YA NO cierra el pool: no es
 * dueño de esa conexión, la comparten los demás módulos.
 */

/** Un manejador recibe la carga del trabajo. Si lanza, el trabajo se reintenta. */
export type Manejador = (carga: any, trabajo: TrabajoTomado) => Promise<void>;

export interface TrabajoTomado {
  id: number;
  tipo: string;
  carga: any;
  intentos: number;
  max_intentos: number;
}

/** Cada cuanto se mira la cola. */
const CADA_MS = 5000;

/** Cuantos trabajos se procesan como maximo en una pasada. */
const POR_PASADA = 10;

/** Cada cuantas pasadas se barren los huerfanos. 6 x 5 s = 30 s. */
const PASADAS_POR_BARRIDA = 6;

/**
 * Cuanto puede tardar un manejador antes de darlo por colgado.
 *
 * Tiene que ser MUY menor que RECLAMAR_MIN: si un manejador legitimo tardara
 * mas que la reclamacion de huerfanos, el mismo trabajo se ejecutaria dos
 * veces a la vez. 60 s contra 15 min deja margen de sobra.
 */
const LIMITE_MANEJADOR_MS = 60000;

/**
 * A los cuantos minutos se reclama un trabajo que quedo en PROCESANDO.
 *
 * Si la API muere con un trabajo tomado, la fila se queda en PROCESANDO para
 * siempre y nadie la vuelve a mirar: es justo el tipo de falla silenciosa que
 * este proyecto ya pago caro dos veces. Al reiniciar se recuperan.
 */
const RECLAMAR_MIN = 15;

/**
 * Gracia al arrancar antes de reclamar un PROCESANDO ajeno.
 *
 * NO puede ser 0, y la razon es grave. El caso que hay que recuperar rapido es
 * la muerte sucia: el vigilante hace `Stop-Process -Force`, asi que el apagado
 * ordenado no corre y los trabajos se quedan tomados. Con 0 se recuperarian al
 * instante... pero si por lo que sea hubiera DOS instancias vivas a la vez, la
 * que arranca le arrebataria a la otra un trabajo que esta ejecutando en ese
 * momento, y el mismo trabajo correria dos veces en paralelo.
 *
 * Para un aviso al cliente eso es un correo repetido. Para una captura de pago
 * es COBRAR DOS VECES. Entre esperar dos minutos y arriesgar un cargo doble no
 * hay discusion.
 *
 * En el reinicio normal esto ni se nota: el apagado ordenado ya devolvio todo
 * a PENDIENTE (ver devolverEnVuelo).
 */
const GRACIA_ARRANQUE_MIN = 2;

/**
 * Espera antes del siguiente intento, en segundos.
 *
 * Creciente y con tope de una hora. Se exporta pura para poder probarla sin
 * base de datos ni API.
 *
 *   intento 1 falla -> 1 min      intento 4 falla -> 8 min
 *   intento 2 falla -> 2 min      intento 5 falla -> 16 min
 *   intento 3 falla -> 4 min      (con max_intentos 5 nunca se llega aqui)
 */
export function esperaSegundos(intentos: number): number {
  const n = Math.max(1, Math.floor(intentos));
  const seg = 60 * Math.pow(2, n - 1);
  return Math.min(seg, 3600);
}

@Injectable()
export class ColaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ColaService.name);
  private listo = false;

  private manejadores = new Map<string, Manejador>();
  private reloj?: NodeJS.Timeout;

  /** Evita que dos pasadas se solapen si una tarda mas que el intervalo. */
  private enPasada = false;
  private apagando = false;
  private pasadas = 0;

  /**
   * Trabajos tomados y todavia sin resolver en ESTE proceso. Al apagar se
   * devuelven a PENDIENTE, que es lo que evita perderlos en un reinicio.
   */
  private enVuelo = new Set<number>();

  private cuenta = { hechos: 0, fallidos: 0, reintentos: 0, reclamados: 0 };
  private ultimaPasada: Date | null = null;

  constructor(@Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex) {}

  onModuleInit() {
    void this.arrancar();
  }

  async onModuleDestroy() {
    this.apagando = true;
    if (this.reloj) { clearInterval(this.reloj); this.reloj = undefined; }
    // El reintento de arranque tambien: si la base nunca volvio, este
    // temporizador sigue vivo y no debe sobrevivir al apagado.
    if (this.relojArranque) { clearInterval(this.relojArranque); this.relojArranque = null; }

    // Se espera a que la pasada en curso termine, con tope: colgar el apagado
    // de la API es peor que dejar un trabajo a medias, que de todos modos se
    // reclama a los 15 minutos.
    //
    // MATIZ, medido el 27/08/2026: si un manejador esta a mitad de camino, esta
    // espera se agota (10 s) y el trabajo se devuelve a PENDIENTE mientras el
    // manejador SIGUE corriendo. Es lo correcto —mejor devolverlo que perderlo—
    // pero significa que en teoria podria completarse despues de haber sido
    // devuelto. En la practica no importa: el proceso termina justo despues, y
    // este despliegue es de una sola instancia. Si algun dia se corren dos, hay
    // que revisarlo.
    const hasta = Date.now() + 10000;
    while (this.enPasada && Date.now() < hasta) {
      await new Promise(r => setTimeout(r, 100));
    }

    await this.devolverEnVuelo();
    // No se cierra this.db: es la conexión compartida de todo el app
    // (KpConcentradaModule), no la posee este servicio.
  }

  // ── Registro de manejadores ────────────────────────────────────────────────

  /**
   * Registra quien atiende un tipo de trabajo. Lo llama cada entregable desde
   * su propio servicio (onModuleInit), no este archivo: asi el motor no
   * depende de Mercado Pago ni del correo.
   */
  registrar(tipo: string, fn: Manejador) {
    if (this.manejadores.has(tipo)) {
      // Registrar dos veces el mismo tipo casi siempre es un copy-paste, y el
      // segundo gana en silencio. Mejor que se vea.
      this.logger.warn(`El tipo de trabajo '${tipo}' ya tenia manejador; se reemplaza.`);
    }
    this.manejadores.set(tipo, fn);
    this.logger.log(`Manejador registrado para '${tipo}'.`);
  }

  // ── Encolar ────────────────────────────────────────────────────────────────

  /**
   * Mete un trabajo en la cola.
   *
   * IDEMPOTENCIA: si `carga.idempotencia` viene, la migracion 002 tiene un
   * indice unico que impide meter dos veces el mismo. Es lo que evita procesar
   * dos veces un aviso que Mercado Pago reenvia, cosa que hace de rutina.
   *
   * Devuelve el id, o null si ya estaba encolado. Un null NO es un error: es
   * la idempotencia haciendo su trabajo.
   *
   * Se puede pasar la transacción Knex en curso (`trx`) para que el trabajo se
   * encole SOLO si esa transacción se confirma. Importa: encolar "avisar al
   * cliente" fuera de la transacción del pedido puede avisar de un pedido que
   * al final no se guardó. Equivalente al `cli: PoolClient` del original.
   */
  async encolar(tipo: string, carga: any,
                opciones?: { correrEn?: Date; maxIntentos?: number; cli?: Knex }):
                Promise<number | null> {
    if (!this.listo) {
      throw new Error('La cola no esta disponible: falta la migracion 002_tienda_pedidos.sql');
    }
    const ejecutor = opciones?.cli ?? this.db;

    // ON CONFLICT DO NOTHING, y NO capturar el error 23505.
    //
    // La diferencia importa justo en el caso de `cli`: si el INSERT choca con
    // el indice de idempotencia dentro de una transaccion, esa transaccion
    // queda ABORTADA, y todo lo que venga despues falla con "current
    // transaction is aborted". Atrapar el error y seguir como si nada
    // convertiria un duplicado inofensivo en la perdida del pedido entero.
    // Con ON CONFLICT no se levanta ningun error: simplemente no devuelve fila.
    //
    // Los casts son explicitos porque con parametros nulos Postgres no tiene de
    // donde inferir el tipo.
    const sql =
      `INSERT INTO tienda.trabajos (tipo, carga, correr_en, max_intentos)
       VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()), COALESCE($4::int, 5))
       ON CONFLICT DO NOTHING
       RETURNING id`;

    const r = await ejecutor.raw(sql,
      [tipo, JSON.stringify(carga ?? {}), opciones?.correrEn ?? null,
       opciones?.maxIntentos ?? null]);

    if (!r.rows.length) {
      this.logger.debug(`Trabajo '${tipo}' ya estaba encolado (idempotencia).`);
      return null;
    }
    return Number(r.rows[0].id);
  }

  // ── Arranque ───────────────────────────────────────────────────────────────

  /**
   * Vuelve a intentar el arranque hasta que la base responda.
   *
   * POR QUE: la comprobacion se hacia una sola vez, y el 31/08/2026 la API
   * arranco un segundo antes de que volviera la base. La cola quedo apagada
   * con su tabla creada desde el primer dia, y ahi se quedo hasta que alguien
   * reinicio a mano. No es un caso raro: el vigilante relanza la API durante
   * una caida, asi que arrancar ANTES de que la base este lista es lo normal.
   *
   * El temporizador se limpia solo en cuanto logra arrancar, y respeta el
   * apagado ordenado.
   */
  private relojArranque: NodeJS.Timeout | null = null;

  private reintentarArranque() {
    if (this.relojArranque || this.apagando) return;
    this.relojArranque = setInterval(() => {
      if (this.apagando || this.listo) {
        if (this.relojArranque) { clearInterval(this.relojArranque); this.relojArranque = null; }
        return;
      }
      void this.arrancar();
    }, 60_000);
    // Que un reintento pendiente no impida que el proceso termine.
    this.relojArranque.unref?.();
  }

  private async arrancar() {
    this.listo = await this.hayTabla();
    if (!this.listo) {
      this.logger.warn(
        'Cola DESACTIVADA: falta la migracion 002_tienda_pedidos.sql, ' +
        'o la base no estaba disponible al arrancar. Se reintenta cada minuto.');
      this.reintentarArranque();
      return;
    }

    if (String(process.env.COLA_ACTIVA || '').trim() === '0') {
      this.logger.warn('Cola DESACTIVADA por COLA_ACTIVA=0 en el .env.');
      return;
    }

    this.registrar('prueba', (carga, trabajo) => this.manejarPrueba(carga, trabajo));

    // Lo primero al arrancar es recoger lo que quedo tirado del proceso
    // anterior. Si la API murio a media faena, esos trabajos estan en
    // PROCESANDO y nadie los va a volver a mirar.
    await this.reclamarHuerfanos(GRACIA_ARRANQUE_MIN);

    this.reloj = setInterval(() => { void this.pasada(); }, CADA_MS);
    // Que el reloj no impida al proceso terminar.
    this.reloj.unref?.();
    this.logger.log(`Trabajador de la cola activo: revisa cada ${CADA_MS / 1000} s.`);
  }

  private async hayTabla(): Promise<boolean> {
    try {
      const r = await this.db.raw(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema='tienda' AND table_name='trabajos'`);
      return r.rows.length > 0;
    } catch { return false; }
  }

  // ── El ciclo ───────────────────────────────────────────────────────────────

  private async pasada() {
    if (this.enPasada || this.apagando || !this.listo) return;
    this.enPasada = true;
    try {
      // La barrida de huerfanos no va en cada pasada: el indice parcial de la
      // migracion 002 cubre PENDIENTE, no PROCESANDO, asi que ese barrido no
      // esta indexado. Cada PASADAS_POR_BARRIDA (30 s) es de sobra para algo
      // que solo pasa cuando la API muere.
      if (this.pasadas % PASADAS_POR_BARRIDA === 0) {
        await this.reclamarHuerfanos(RECLAMAR_MIN);
      }
      this.pasadas++;

      for (let i = 0; i < POR_PASADA; i++) {
        if (this.apagando) break;
        const t = await this.tomar();
        if (!t) break;                 // no hay nada listo: se corta la pasada
        await this.atender(t);
      }
      this.ultimaPasada = new Date();
    } catch (e: any) {
      // Que falle una pasada no debe matar el reloj: si la base esta caida, se
      // vuelve a intentar en la siguiente.
      this.logger.error(`Fallo la pasada de la cola: ${e.message}`);
    } finally {
      this.enPasada = false;
    }
  }

  /**
   * Toma un trabajo, en una sola sentencia.
   *
   * FOR UPDATE SKIP LOCKED es lo que permite que dos procesos tomen de la
   * misma cola sin pisarse: el segundo salta la fila bloqueada en vez de
   * esperarla.
   *
   * Los intentos se suman AL TOMAR, no al fallar. Es deliberado: si el proceso
   * muere dentro del manejador, el intento ya quedo contado, asi que un
   * trabajo venenoso —uno que tumba la API— no puede reiniciarla en bucle para
   * siempre. Acaba en FALLIDO como cualquier otro.
   *
   * OJO con `correr_en`: mientras el trabajo esta en PROCESANDO se usa como
   * "cuando se tomo", que es lo que permite reclamar huerfanos sin agregar una
   * columna y otra migracion (la 004 ya esta pendiente). Para PENDIENTE
   * significa lo de siempre: "no correr antes de".
   */
  private async tomar(): Promise<TrabajoTomado | null> {
    const r = await this.db.raw(
      `UPDATE tienda.trabajos t
          SET estado    = 'PROCESANDO',
              intentos  = t.intentos + 1,
              correr_en = NOW()
        WHERE t.id = (
                SELECT id FROM tienda.trabajos
                 WHERE estado = 'PENDIENTE'
                   AND correr_en <= NOW()
                   AND intentos < max_intentos
                 ORDER BY correr_en
                   FOR UPDATE SKIP LOCKED
                 LIMIT 1)
      RETURNING id, tipo, carga, intentos, max_intentos`);

    if (!r.rows.length) return null;
    const f = r.rows[0];
    const t: TrabajoTomado = {
      id: Number(f.id), tipo: String(f.tipo), carga: f.carga,
      intentos: Number(f.intentos), max_intentos: Number(f.max_intentos),
    };
    this.enVuelo.add(t.id);
    return t;
  }

  private async atender(t: TrabajoTomado) {
    const fn = this.manejadores.get(t.tipo);
    if (!fn) {
      // Se reintenta en vez de fallar de golpe: al arrancar, el manejador
      // puede registrarse unos milisegundos despues que la cola. Si el tipo
      // sigue sin manejador, acabara en FALLIDO al agotar intentos, que es la
      // verdad del caso.
      await this.falla(t, `No hay manejador registrado para el tipo '${t.tipo}'`);
      return;
    }

    try {
      await this.conLimite(fn(t.carga, t), LIMITE_MANEJADOR_MS);
      await this.hecho(t);
    } catch (e: any) {
      await this.falla(t, String(e?.message || e).slice(0, 2000));
    }
  }

  /** Corta un manejador colgado. Sin esto, uno solo detiene la cola entera. */
  private conLimite<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((res, rej) => {
      const alarma = setTimeout(
        () => rej(new Error(`El manejador excedio ${ms / 1000} s`)), ms);
      p.then(v => { clearTimeout(alarma); res(v); },
             e => { clearTimeout(alarma); rej(e); });
    });
  }

  private async hecho(t: TrabajoTomado) {
    await this.db.raw(
      `UPDATE tienda.trabajos
          SET estado='HECHO', terminado_en=NOW(), ultimo_error=NULL
        WHERE id=$1`, [t.id]);
    this.enVuelo.delete(t.id);
    this.cuenta.hechos++;
  }

  private async falla(t: TrabajoTomado, error: string) {
    const agotado = t.intentos >= t.max_intentos;

    if (agotado) {
      await this.db.raw(
        `UPDATE tienda.trabajos
            SET estado='FALLIDO', terminado_en=NOW(), ultimo_error=$2
          WHERE id=$1`, [t.id, error]);
      this.cuenta.fallidos++;
      // Un FALLIDO no se reintenta nunca mas: si nadie lo mira, se queda ahi
      // callado. Va a WARN para que al menos quede en api3000.log.
      this.logger.warn(
        `Trabajo ${t.id} (${t.tipo}) FALLIDO tras ${t.intentos} intentos: ${error}`);
    } else {
      const espera = esperaSegundos(t.intentos);
      // make_interval en vez de concatenar texto: no depende de como el driver
      // infiera el tipo del parametro.
      await this.db.raw(
        `UPDATE tienda.trabajos
            SET estado='PENDIENTE',
                correr_en = NOW() + make_interval(secs => $2::int),
                ultimo_error=$3
          WHERE id=$1`, [t.id, espera, error]);
      this.cuenta.reintentos++;
      this.logger.debug(
        `Trabajo ${t.id} (${t.tipo}) intento ${t.intentos}/${t.max_intentos} fallo; ` +
        `se reintenta en ${espera} s: ${error}`);
    }
    this.enVuelo.delete(t.id);
  }

  /**
   * Devuelve a PENDIENTE los trabajos que quedaron en PROCESANDO.
   *
   * El umbral en minutos es la unica proteccion contra arrebatarle un trabajo
   * a un proceso que lo esta ejecutando de verdad: al arrancar se usa la gracia
   * corta (GRACIA_ARRANQUE_MIN) y en marcha la larga (RECLAMAR_MIN), que tiene
   * que ser mayor que LIMITE_MANEJADOR_MS. Ver la nota de GRACIA_ARRANQUE_MIN
   * para el porque no puede ser 0.
   *
   * No se les suma intento: ya se les conto al tomarlos.
   */
  private async reclamarHuerfanos(minutos: number) {
    try {
      const r = await this.db.raw(
        `UPDATE tienda.trabajos
            SET estado='PENDIENTE',
                correr_en=NOW(),
                ultimo_error=$2
          WHERE estado='PROCESANDO'
            AND correr_en < NOW() - make_interval(mins => $1::int)
            AND intentos < max_intentos
        RETURNING id, tipo`,
        [minutos,
         'Reclamado: la API se reinicio o el trabajo quedo colgado mientras se procesaba']);

      if (r.rows.length) {
        this.cuenta.reclamados += r.rows.length;
        this.logger.warn(
          `Se reclamaron ${r.rows.length} trabajo(s) que quedaron en PROCESANDO: ` +
          r.rows.map((x: any) => `${x.id}/${x.tipo}`).join(', '));
      }

      // Los que ya agotaron intentos no se pueden reclamar (volverian a
      // quedarse en PROCESANDO para siempre), asi que se cierran como FALLIDO.
      const c = await this.db.raw(
        `UPDATE tienda.trabajos
            SET estado='FALLIDO', terminado_en=NOW(),
                ultimo_error=COALESCE(ultimo_error,'') ||
                             ' | Cerrado: quedo en PROCESANDO sin intentos restantes'
          WHERE estado='PROCESANDO'
            AND correr_en < NOW() - make_interval(mins => $1::int)
            AND intentos >= max_intentos
        RETURNING id`, [minutos]);
      if (c.rows.length) {
        this.cuenta.fallidos += c.rows.length;
        this.logger.warn(
          `${c.rows.length} trabajo(s) quedaron FALLIDOS: estaban en PROCESANDO sin intentos restantes.`);
      }
    } catch (e: any) {
      this.logger.error(`No se pudieron reclamar huerfanos: ${e.message}`);
    }
  }

  /**
   * Al apagar, devuelve a PENDIENTE lo que este proceso tenia tomado.
   *
   * Esto es literalmente el criterio de terminado de la Fase 2: "ningun pedido
   * se pierde si la API se reinicia a medio proceso". Sin esto habria que
   * esperar los 15 minutos de la reclamacion en cada reinicio, y la API se
   * reinicia sola cada vez que el vigilante la levanta.
   */
  private async devolverEnVuelo() {
    if (!this.enVuelo.size) return;
    const ids = [...this.enVuelo];
    try {
      await this.db.raw(
        `UPDATE tienda.trabajos
            SET estado='PENDIENTE', correr_en=NOW(),
                ultimo_error='Devuelto a la cola: la API se estaba apagando'
          WHERE id = ANY($1::bigint[]) AND estado='PROCESANDO'`, [ids]);
      this.logger.log(`Se devolvieron ${ids.length} trabajo(s) a la cola al apagar.`);
    } catch (e: any) {
      // Si no se logra, la reclamacion de huerfanos los recoge al volver.
      this.logger.error(`No se pudieron devolver los trabajos en vuelo: ${e.message}`);
    }
    this.enVuelo.clear();
  }

  // ── Manejador de autocomprobacion ──────────────────────────────────────────

  /**
   * Tipo 'prueba': el canario de la cola. No toca datos de nadie.
   *
   * Sirve para dos cosas distintas:
   *
   *   1. El banco de pruebas (herramientas\probar_cola.js) lo usa para ejercer
   *      el motor completo: exito, reintento con espera creciente, agotamiento
   *      de intentos y corte por manejador colgado.
   *   2. En produccion permite comprobar que el trabajador esta vivo sin
   *      mover un peso, encolando uno desde el tablero. Hace falta: una cola
   *      detenida no da ningun error a la vista, y este proyecto ya sabe como
   *      acaban las fallas que no se ven.
   *
   * Carga que entiende (todo opcional):
   *   { fallar_siempre: true }  lanza siempre
   *   { fallar_hasta: N }       lanza mientras el intento sea <= N
   *   { tardar_ms: N }          se duerme N ms, para probar el corte
   */
  private async manejarPrueba(carga: any, trabajo: TrabajoTomado): Promise<void> {
    const c = carga || {};

    if (Number(c.tardar_ms) > 0) {
      await new Promise(r => setTimeout(r, Number(c.tardar_ms)));
    }
    if (c.fallar_siempre) {
      throw new Error('Trabajo de prueba: fallo pedido por la carga (fallar_siempre)');
    }
    // `trabajo.intentos` ya viene incrementado por tomar(), asi que en el
    // primer intento vale 1. Con fallar_hasta:1 falla una vez y a la segunda
    // pasa, que es como se prueba el reintento.
    const hasta = Number(c.fallar_hasta);
    if (Number.isFinite(hasta) && hasta > 0 && trabajo.intentos <= hasta) {
      throw new Error(
        `Trabajo de prueba: fallo pedido hasta el intento ${hasta} (va en el ${trabajo.intentos})`);
    }
  }

  // ── Estado, para vigilancia ────────────────────────────────────────────────

  /**
   * Como va la cola.
   *
   * PENDIENTE: engancharlo al vigilante horario. Una cola con trabajos
   * FALLIDOS o con un pendiente muy viejo no da ningun error a la vista —es el
   * mismo modo de falla silenciosa que ya costo caro con los precios viejos y
   * con la caida del 27/08— y hoy solo se ve llamando a esto.
   */
  async estado() {
    const base = {
      activa: this.listo && !!this.reloj,
      tipos_registrados: [...this.manejadores.keys()],
      ultima_pasada: this.ultimaPasada,
      en_vuelo: this.enVuelo.size,
      cuenta: { ...this.cuenta },
    };
    if (!this.listo) return { ...base, error: 'Falta la migracion 002_tienda_pedidos.sql' };

    try {
      const r = await this.db.raw(
        `SELECT estado, COUNT(*)::int AS n,
                MIN(creado_en) AS mas_viejo
           FROM tienda.trabajos
          GROUP BY estado`);
      const por: Record<string, any> = {};
      for (const f of r.rows) por[f.estado] = { n: f.n, mas_viejo: f.mas_viejo };
      return { ...base, por_estado: por };
    } catch (e: any) {
      return { ...base, error: e.message };
    }
  }
}
