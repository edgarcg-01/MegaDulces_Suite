import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { KNEX_NEW_DB, latirCron, PgListenService, TenantContextService } from '@megadulces/platform-core';
import { CANAL_CAJA } from './caja-realtime.service';
import { FINANCE_NOTIFIER_PORT, type FinanceNotifierPort } from '@megadulces/contracts';
import type { Knex } from 'knex';
import { CashLedgerService } from './cash-ledger.service';
import type { FilaLote, ResumenLote } from './caja-lote.engine';
import {
  MAX_VUELTAS, PISO_ALCANCE_DEFAULT, TAMANO_PAGINA,
  acumular, motivoCeroOk, notaDeCorrida, planearVuelta, resumenVacio,
  type PendienteResuelto, type ResumenCorrida,
} from './caja-autollenado.engine';

/**
 * Lo que este motor CONSUME de `movimientosPendientes()` — no su contrato entero.
 *
 * ⭐ Se declara en vez de tipar el borde con `any` (ADR-052): así, el día que la bandeja cambie de
 * forma, el compilador señala **acá** en vez de dejar que `rows` llegue vacío en silencio, que es
 * como un autollenado sano empieza a reportar cero sin que nada avise.
 */
interface BandejaPendientes {
  rows?: Array<PendienteResuelto & { monto?: number | string | null }>;
}

/** El resumen de una corrida, con la bandera que dice si de verdad escribió. */
export type CorridaAutollenado = ResumenCorrida & {
  corrida_en: string;
  piso: string;
  /** `false` = simulación: las cifras son lo que HARÍA, no lo que hizo. */
  aplicado: boolean;
};

export interface EstadoAutollenado {
  piso: string;
  habilitado: boolean;
  corriendo: boolean;
  ultima: CorridaAutollenado | null;
}

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/** La cuenta de servicio de la migración `20261016105305`. Firma lo que el motor registra. */
export const SVC_AUTOLLENADO = {
  id: '00000000-0000-0000-0000-0000000ca11e',
  username: 'svc_caja_autollenado',
} as const;

/**
 * `[CG.190]` — **El libro se llena solo desde los documentos que Kepler ya registró.**
 *
 * Pedido de Edgar (2026-10-16): *«nada de registrar movimientos a mano… automatiza el 100 % del
 * llenado de los movimientos pasados, actuales y futuros»*. El razonamiento, las cifras medidas y
 * las dos hipótesis descartadas están en [`caja-autollenado.engine.ts`](./caja-autollenado.engine.ts);
 * acá sólo vive la E/S.
 *
 * ── ⛔⛔ ARRANCA APAGADO, Y SE PRENDE A MANO ─────────────────────────────────────────────────
 * `ENABLE_CAJA_AUTOLLENADO` **tiene que valer `'true'`** para que el cron escriba. Sin esa
 * variable esto no hace nada, a propósito, y no es timidez:
 *
 *  · es un proceso que **escribe dinero en producción sin que nadie mire**, y la regla de la casa
 *    es que *un endpoint que escribe no está probado hasta que una prueba lo ejerció contra una
 *    base real con el payload de la pantalla* — eso todavía no pasó para este camino;
 *  · la migración `20261016105305` (la cuenta de servicio) **tiene que estar aplicada antes**, o
 *    cada movimiento quedaría firmado por un UUID que la pantalla no resuelve a un nombre;
 *  · prenderlo es una decisión de Edgar, no un efecto colateral de desplegar.
 *
 * ⭐ Mientras está apagado el módulo **sigue sirviendo**: `correr()` se puede disparar a mano por
 * `POST /finance/cash-ledger/autollenado/correr` (permiso `FINANCE_CAJA_GESTIONAR`), que es cómo
 * se va a ejercer la primera vez, mirando el resultado.
 *
 * ── ⭐⭐ La decisión de diseño que más importa: NO HAY MOTOR NUEVO ───────────────────────────
 * Este servicio **no sabe** a qué cuenta va un peso. Llama a `movimientosPendientes()` —que ya
 * corre `resolverCuentas()`— y confirma con `crearLote()`, **el mismo método que usa el botón de
 * la pantalla**. Lo único que agrega es *quién aprieta el botón y cuándo*.
 *
 * Eso es a propósito y es la parte más valiosa:
 *  · lo que la persona ve como propuesta y lo que el cron escribe **no pueden divergir**: son la
 *    misma línea de código;
 *  · la idempotencia ya está (`ux_cash_ledger_origen_vivo` sobre `origen_ref`): si una persona y
 *    el cron confirman el mismo documento, el segundo recibe `23505` y se reporta `duplicado` —
 *    el dinero no entra dos veces;
 *  · los frenos ya están y siguen valiendo — `[CG.24]` fecha futura, `[CG.124]` ningún movimiento
 *    sin vincular, `[CG.48]` el lote espeja al ERP y no acepta montos contados;
 *  · el día que alguien mejore el resolvedor, el autollenado mejora solo.
 *
 * El repo ya pagó lo contrario: `[CG.27-B.0]` encontró la bandeja y el autofill clasificando
 * distinto el mismo movimiento porque cada uno tenía su copia del matcher.
 *
 * ── ⛔ Lo que NO automatiza, y por qué no es una limitación ──────────────────────────────────
 *  1. **Los documentos mal fechados por Kepler.** Entrarían al libro en un mes que no llegó y
 *     moverían los totales del mes en curso. Se cuentan, se avisan y se corrigen **en Kepler**
 *     (ADR-040: el ERP es el dueño del documento). Medido hoy: 7 movimientos / $50,796.40.
 *  2. **Lo anterior al piso de alcance.** Ya está conciliado en el Access; escribirlo sería
 *     contar $162 M dos veces.
 *  3. **El arqueo y el corte.** Contar efectivo es un acto humano con doble llave. Este motor
 *     llena el LIBRO; quién contó cuánto sigue siendo de la cajera y su supervisor.
 *
 * ⚠️ **Y lo que un cron no arregla:** si Kepler deja de registrar el ingreso —como pasó el
 * 12-oct, de ~90-115 depósitos `U-A-5` por semana a **3**— este motor va a reportar cero con toda
 * razón, y la cola vacía se va a leer como *«ya no hay trabajo»*. Por eso el latido distingue
 * «no había nada» de «no pude con nada» (`motivoCeroOk`), y por eso el aviso de abajo existe.
 */
@Injectable()
export class CajaAutollenadoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CajaAutollenadoService.name);
  private running = false;
  /** La firma del último aviso procesado. Vacía = todavía no llegó ninguno. */
  private ultimaFirma = '';
  private dejarDeEscuchar: (() => void) | null = null;
  /** `aplicado: false` = fue una simulación; sus cifras son lo que HARÍA, no lo que hizo. */
  private ultima: CorridaAutollenado | null = null;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly ledger: CashLedgerService,
    private readonly tenantCtx: TenantContextService,
    private readonly listen: PgListenService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /**
   * ⛔ Opt-in explícito: **apagado salvo que valga exactamente `'true'`**. Al revés que sus
   * hermanos (`ENABLE_CAJA_FECHA_SCAN`, que apaga con `'false'`) y a propósito: aquéllos sólo
   * LEEN y avisan; éste ESCRIBE al libro. Un default encendido haría que desplegar fuera,
   * por sí solo, empezar a registrar dinero.
   */
  private get habilitado(): boolean {
    return String(process.env.ENABLE_CAJA_AUTOLLENADO ?? '').trim() === 'true';
  }

  /**
   * `[CG.197]` Se engancha al aviso del carril. **Siempre se escucha, aun apagado**: así el log
   * puede decir «llegó un aviso y no corrí porque estoy apagado», que es justo la distinción que
   * `[CG.195]` vino a arreglar. Decidir si se llena es de `porAviso()`, no de acá.
   */
  onModuleInit(): void {
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_CAJA, (p) => { void this.porAviso(p); });
      this.logger.log(
        `escuchando ${CANAL_CAJA} (sin reloj) · ${this.habilitado ? `ACTIVO, piso ${this.piso}` : 'APAGADO: no va a llenar'}`,
      );
    } catch (e: unknown) {
      // ⛔ No tumba el arranque del worker: 50 crons más dependen de este proceso. Se DICE, y el
      // latido se queda viejo, que es como db-health se entera.
      this.logger.error(
        `no se pudo escuchar ${CANAL_CAJA}: ${(e as Error)?.message} — el libro NO se va a llenar solo`,
      );
    }
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
  }

  /** El piso de alcance vigente. Se puede mover sin redeploy; moverlo atrás es decisión contable. */
  get piso(): string {
    const v = String(process.env.CAJA_AUTOLLENADO_PISO ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : PISO_ALCANCE_DEFAULT;
  }

  /**
   * ⭐⭐ `[CG.197]` **SE LLENA CUANDO LLEGA EL DINERO, NO CUANDO SUENA UN RELOJ.**
   *
   * Pedido de Edgar, 2026-10-19: *«nada de crons»*, y después *«analizá cuál es la mejor opción
   * para mantener la información fresca y al momento»*.
   *
   * ── Lo que reemplaza, y por qué el reloj perdía ──────────────────────────────────────────
   * Había un `@Cron` cada 15 min. Medido contra el carril real:
   *
   *     retraso del libro        reloj: hasta 15 min   ·  evento: segundos tras el refresh
   *     cuándo trabaja           reloj: 96 veces/día   ·  evento: sólo si la fuente cambió
   *     costo por corrida        8.0 s, haya o no      ·  8.0 s por cambio real
   *
   * ⭐ **El mecanismo ya existía y el repo ya lo había elegido para ESTE mismo dato.** El carril
   * `caja-mv-push` no es un reloj: corre `refresh-caja-matview.js --escuchar=caja_fuente`, un
   * oyente que refresca cuando `feeds-ingest` avisa que su UPSERT —sin churn— cambió algo. Su
   * propio archivo lo dice: *«reemplaza —no acompaña— a la idea de "cada 30 min sondeá el
   * universo completo"»*. Esto sólo se sube a esa ola.
   *
   * ── ⛔ Se escucha `caja_movimientos`, NO `caja_fuente`, y la diferencia es todo ───────────
   * `caja_fuente` avisa que la FUENTE cambió — se emite **antes** del refresh. Este motor lee
   * `analytics.mv_caja_movimientos`, que es una MATVISTA: escuchar ahí lo haría correr contra la
   * foto vieja y no encontrar lo que vino a buscar. `caja_movimientos` lo emite el carril
   * **después de un refresh exitoso**, que es cuando el dato existe de verdad.
   *
   * ⭐ Y el payload trae la **firma** (`filas`, `max_folio`, `suma`), no los movimientos — así que
   * el debounce sale gratis: si la firma no cambió respecto de la última que procesé, no hay
   * nada nuevo y no se corre. Un lote de ingesta que emite varios avisos seguidos produce **una**
   * corrida, no cinco.
   *
   * ── ⚠️ El hueco, declarado (no lo descubras de nuevo) ────────────────────────────────────
   * `caja_fuente` —y por lo tanto el refresh, y por lo tanto este aviso— se dispara sólo por
   * `kepler_ods.kdm1` y `kdb1`: los DOCUMENTOS. **La póliza no lo dispara**: las `kdc2*` entran
   * por el carril hash, que no avisa. Y la póliza es la que resuelve la cuenta, y tarda días
   * (cobertura medida: 90.5 % a 0-2 días → 100 % a 8-30).
   *
   * ⇒ Un documento que hoy no resuelve se re-evalúa **cuando llega otro documento cualquiera**,
   * porque cada corrida recorre la cola entera, no sólo lo nuevo. Medido, eso pasa todos los
   * días. Pero **no está garantizado por construcción**, y ésa es la deuda `[CG.198]`: emitir el
   * mismo aviso desde el carril que escribe `kdc2*`.
   */
  async porAviso(payload: string): Promise<void> {
    /**
     * ⛔ `[CG.195]` **UN CRON APAGADO QUE NO DEJA RASTRO ES INDISTINGUIBLE DE UNO ROTO.**
     *
     * Acá había un `return` mudo. Medido el 2026-10-19, en vivo: después de prender
     * `ENABLE_CAJA_AUTOLLENADO` el motor no escribió nada, y **el log del worker no tenía una
     * sola línea de este servicio** — ni «corrí», ni «me salté». Con los otros 50 crons latiendo
     * alrededor, no se podía decir si la variable no había llegado, si el `@Cron` no estaba
     * registrado o si simplemente todavía no tocaba tick. Diagnosticarlo costó una ventana de
     * 15 minutos que no hacía falta gastar.
     *
     * Es exactamente la trampa que [`main.ts`](../../../../apps/api/src/main.ts) ya tenía
     * escrita para `DISABLE_CRONS` —*«un interruptor que apaga 51 cron y no deja rastro en el
     * log es una trampa en las dos direcciones»*— y la repetí en el cron de al lado.
     *
     * ⚠️ `debug` y no `log`: esto llega con cada aviso del carril y en un worker apagado
     * llenaría el log de ruido. Lo que importa es que **exista** cuando alguien va a buscarlo.
     */
    if (!this.habilitado) {
      this.logger.debug(
        'apagado: ENABLE_CAJA_AUTOLLENADO no vale "true" en este proceso — el libro NO se está llenando solo',
      );
      return;
    }

    /**
     * El aviso viene de FUERA del API (lo escribe el carril), así que es entrada no confiable:
     * si no parsea, se descarta con aviso. Mismo criterio que `caja-realtime.service.ts`.
     */
    let firma: string;
    try {
      const d = JSON.parse(payload || '{}') as Record<string, unknown>;
      firma = `${d.filas ?? '?'}|${d.max_folio ?? '?'}|${d.max_captura ?? '?'}|${d.suma ?? '?'}`;
    } catch {
      this.logger.warn('payload de caja_movimientos no es JSON; descartado');
      return;
    }

    /**
     * ⭐ El debounce, y es lo que vuelve barato al evento: el carril avisa tras CADA refresh
     * exitoso —avisa de más a propósito, para no avisar de menos— pero la firma sólo cambia
     * cuando el corte cambió de verdad. Sin esto, un refresh que no movió nada dispararía los
     * 8 s de una corrida completa cada minuto.
     *
     * ⚠️ La firma incluye la SUMA, no sólo el conteo: un movimiento corregido (mismo folio, otro
     * monto) no mueve `filas` y se perdería. Esa decisión ya está tomada y medida del lado del
     * emisor; acá sólo se respeta.
     */
    if (firma === this.ultimaFirma) {
      this.logger.debug(`aviso sin cambios (${firma}); no corro`);
      return;
    }
    this.ultimaFirma = firma;

    if (this.running) {
      // ⛔ No se pierde: al terminar la corrida en curso se vuelve a mirar, porque la firma ya
      // quedó guardada como pendiente de procesar.
      this.logger.warn('Skip: corrida en curso — el próximo aviso la retoma');
      return;
    }
    // `[CG.195]` El arranque también se dice: con esta línea, la ausencia de latido se puede
    // atribuir —al proceso que no corrió, o a la corrida que falló— en vez de adivinarse.
    this.logger.log(`aviso del carril (${firma}) → corriendo, piso ${this.piso}…`);
    await this.correr({ aplicar: true })
      .catch((e: unknown) => this.logger.error(`autollenado: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Lo que dejó la última corrida de este proceso. `null` = todavía no corrió acá. */
  estado(): EstadoAutollenado {
    return {
      piso: this.piso,
      habilitado: this.habilitado,
      corriendo: this.running,
      // ⛔ `null` y no un resumen en cero: «todavía no corrió» y «corrió y no hizo nada» son
      // cosas distintas, y un cero las haría indistinguibles (ADR-056).
      ultima: this.ultima,
    };
  }

  /**
   * Una corrida completa: vuelve a pedir la cola hasta que no quede nada que aplicar.
   *
   * ⚠️ **No hay paginación por `offset` y no hace falta.** Cada confirmación saca la fila de
   * `finance.v_caja_movimientos_pendientes` (la vista excluye lo ya capturado por `origen_ref`),
   * así que la vuelta siguiente trae lo que quedó. Si una vuelta no guarda nada, se corta: volver
   * a pedir una página idéntica sería un bucle.
   */
  async correr(opts?: { aplicar?: boolean }): Promise<CorridaAutollenado> {
    /**
     * ⛔⛔ **SIMULA SALVO QUE SE PIDA APLICAR, y el default es deliberado.**
     *
     * Esto escribe dinero en el libro de producción. Una llamada a secas CONTESTA QUÉ HARÍA —
     * cuántos movimientos, por cuánto, y qué dejaría fuera con su motivo— **sin escribir una sola
     * fila**. Para que escriba hay que decirlo: `correr({ aplicar: true })`.
     *
     * Por qué así y no al revés: la regla de la casa es que *un endpoint que escribe no está
     * probado hasta que una prueba lo ejerció contra base real con el payload de la pantalla*, y
     * el camino caro de equivocarse acá no es un 500 — es dinero registrado que después hay que
     * cancelar movimiento por movimiento. La simulación deja mirar el plan antes de autorizarlo,
     * que es exactamente lo que faltó cuando `[CG.24]` metió un gasto de enero al libro como
     * diciembre.
     *
     * ⚠️ La simulación **no es gratis ni es una estimación**: corre el resolvedor REAL sobre la
     * cola REAL. Lo único que no hace es el `INSERT`. Así que si dice «registraría 117», ésos son
     * los 117 — no una proyección.
     */
    const aplicar = opts?.aplicar === true;
    this.running = true;
    const t0 = Date.now();
    const piso = this.piso;
    let r = resumenVacio();

    try {
      /**
       * ⛔ **SIN ESTE SCOPE NO HAY TENANT Y NADA FUNCIONA.** Esto corre por un aviso de Postgres (y
       * por el endpoint manual), nunca dentro de un request,
       * así que no hay `TenantContextInterceptor` que haya fijado el contexto. `CashLedgerService`
       * pide `requireTenantId()` y `TenantKnexService` inyecta `app.tenant_id` leyéndolo de acá —
       * y `finance.cash_ledger` tiene RLS **forzado**: sin el scope la lectura devuelve 0 filas
       * (que se lee como «no hay pendientes») y la escritura ni siquiera llega. Es la misma
       * trampa que le costó a `cobranza_gap` reportar 0 abonos todos los días.
       *
       * ⭐ El `userId`/`username` NO son decorativos: son con lo que `create()` firma el
       * movimiento, y lo que permite preguntarle al libro **qué registró la máquina y qué
       * registró una persona**. Mezclarlo con una cuenta humana borraría esa pregunta, que es la
       * que vuelve auditable al autollenado.
       */
      r = await this.tenantCtx.run(
        { tenantId: MEGA, userId: SVC_AUTOLLENADO.id, username: SVC_AUTOLLENADO.username },
        async () => {
          const hoy = await this.hoyMx();
          let acc = resumenVacio();

          for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
            const bandeja = await this.ledger.movimientosPendientes({
              from: piso, limit: TAMANO_PAGINA,
            });
            const plan = planearVuelta(bandeja?.rows ?? [], { piso, hoy });

            if (!plan.aplicar.length) {
              // Nada más que aplicar: se acumula la foto de lo que quedó y se corta.
              return acumular(acc, plan, [], new Map());
            }

            // ── SIMULACIÓN: se reporta el plan tal cual y no se escribe nada ──────────────
            // Se corta en la primera vuelta a propósito: sin escribir, la cola no cambia y la
            // vuelta siguiente traería exactamente lo mismo.
            if (!aplicar) {
              const montos = new Map(plan.aplicar.map((ref) => [ref, this.montoDe(bandeja, ref)]));
              return acumular(
                acc, plan,
                plan.aplicar.map((origen_ref) => ({ origen_ref, estado: 'guardado' as const })),
                montos,
              );
            }

            const resumen: ResumenLote = await this.ledger.crearLote(
              { items: plan.aplicar.map((origen_ref) => ({ origen_ref })) },
              { id: SVC_AUTOLLENADO.id, username: SVC_AUTOLLENADO.username },
            );

            const filas: FilaLote[] = resumen?.filas ?? [];
            const montos = new Map<string, number>();
            for (const f of filas) {
              if (f?.estado === 'guardado') montos.set(f.origen_ref, this.montoDe(bandeja, f.origen_ref));
            }
            acc = acumular(acc, plan, filas, montos);

            // Si una vuelta no guardó nada nuevo, la siguiente traería lo mismo. Se corta.
            if (!filas.some((f) => f?.estado === 'guardado')) return acc;
          }
          return { ...acc, tope_alcanzado: true };
        },
      );
    } catch (e: unknown) {
      // ⛔ Una corrida que revienta NO puede quedar como «cero entregado»: con la cola vacía eso
      // se pintaría verde. Se registra como falla explícita.
      /**
       * ⛔⛔ `[CG.199]` **CORTAR EL MENSAJE POR EL PRINCIPIO TIRA JUSTO LA CAUSA.**
       *
       * Acá decía `msg.slice(0, 300)`. Medido en vivo el 2026-10-19: el latido quedó con
       * *«corrida: select count(*) as "n", sum("monto") from "finance"."v_caja_movimientos_
       * pendientes" where "tenant_id" = $1 and not exists (select 1 from…»* y **nada más** —
       * 300 caracteres de SQL y cero información sobre qué falló.
       *
       * ⭐ La razón es la forma del error de knex: **arma el `message` con el SQL ADELANTE y el
       * error de Postgres ATRÁS**. Recortar por el principio conserva lo que ya sabíamos (la
       * consulta, que está en el código) y descarta lo único que no sabíamos (el motivo).
       *
       * Se guarda la COLA, no la cabeza, y además el `code` de Postgres —que es lo que dice la
       * clase de falla en cinco caracteres— por delante, donde no lo pueda cortar nadie.
       *
       * ⚠️ `latirCron` vuelve a recortar a 500 al juntar las fallas. Por eso el `code` va primero:
       * si algún día alguien suma otra falla al arreglo, lo que sobreviva seguirá siendo útil.
       */
      const err = e as { message?: unknown; code?: unknown; detail?: unknown };
      const msg = e instanceof Error ? e.message : String(e);
      const code = err?.code ? `[${String(err.code)}] ` : '';
      const detalle = err?.detail ? ` · ${String(err.detail)}` : '';
      const cola = msg.length > 240 ? `…${msg.slice(-240)}` : msg;
      r = { ...r, fallas: [...r.fallas, `corrida: ${code}${cola}${detalle}`.slice(0, 300)] };
      // En el log va ENTERO: el log no tiene límite de 500 y es donde se diagnostica.
      this.logger.error(`autollenado: ${code}${msg}${detalle}`);
    } finally {
      this.running = false;
    }

    /**
     * ⛔ **Una simulación NO late.** `rowsAffected` es lo que se ESCRIBIÓ (ADR-053): latir con los
     * 117 que *habría* registrado pondría el tablero de salud en verde sin que el libro tenga una
     * sola fila nueva — un cron muerto disfrazado de sano, que es justo lo que el latido existe
     * para detectar. Tampoco avisa: no hay nada nuevo que nadie tenga que ir a hacer.
     */
    if (aplicar) {
      const ceroEsOk = motivoCeroOk(r);
      await latirCron(this.knex, {
        jobKey: 'caja_autollenado',
        label: 'Caja General: el libro se llena solo desde los documentos de Kepler',
        tenantId: MEGA,
        rowsAffected: r.registrados,
        durationMs: Date.now() - t0,
        fallas: r.fallas,
        note: notaDeCorrida(r),
        ...(ceroEsOk ? { ceroEsOk } : {}),
      });
    }

    this.ultima = { ...r, corrida_en: new Date().toISOString(), piso, aplicado: aplicar };
    if (aplicar && !r.fallas.length) await this.avisar(r);
    return this.ultima;
  }

  /** El monto del documento, tomado de la bandeja que ya lo trajo (no se vuelve a consultar). */
  private montoDe(bandeja: BandejaPendientes, origenRef: string): number {
    const row = (bandeja?.rows ?? []).find((x) => x?.origen_ref === origenRef);
    return Number(row?.monto ?? 0);
  }

  /**
   * Hoy, en día de México, preguntado a Postgres y no al proceso: el contenedor puede correr en
   * UTC y el corte de día se movería seis horas. Mismo criterio que el resto de `libs/finance`.
   */
  private async hoyMx(): Promise<string> {
    const r = await this.knex.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS d`);
    return String(r.rows[0].d);
  }

  /**
   * El aviso. **Sólo avisa de lo que una persona tiene que ir a hacer a otro lado** — no de lo que
   * el motor hizo bien, que es la mayoría y sería ruido diario.
   *
   * ⚠️ Best-effort por el puerto: si la campana no está montada, la corrida igual escribió y latió.
   */
  private async avisar(r: ResumenCorrida): Promise<void> {
    const notify = this.notifier?.notify?.bind(this.notifier);
    if (!notify) return;

    const mal = r.excluidos.fecha_futura;
    if (mal.movimientos > 0) {
      await notify(MEGA, {
        key: 'caja_autollenado_mal_fechados',
        severity: 'warn',
        title: 'Documentos que el autollenado no puede registrar',
        message: `${mal.movimientos} documento${mal.movimientos === 1 ? '' : 's'} por `
          + `$${mal.monto.toLocaleString('es-MX')} viene${mal.movimientos === 1 ? '' : 'n'} fechado${mal.movimientos === 1 ? '' : 's'} `
          + 'después de hoy. El libro se llena solo con todo lo demás; estos se corrigen en Kepler '
          + 'y entran en la siguiente corrida.',
        route: '/finanzas/caja-general',
        data: { movimientos: mal.movimientos, monto: mal.monto },
      }).catch((e: unknown) => this.logger.warn(`aviso mal fechados: ${e instanceof Error ? e.message : e}`));
    }

    /**
     * ⭐ El aviso que de verdad importa: documentos que llevan días sin que su póliza aparezca.
     * Medido, la póliza llega al 100 % entre los 8 y los 30 días, así que un `sin_resolver` que
     * persiste **no es rezago normal**: o la póliza no se va a postear, o falta declarar una
     * regla. Se avisa con el detalle para que se sepa cuál de las dos.
     */
    const sin = r.excluidos.sin_resolver;
    if (sin.movimientos > 0) {
      const detalle = Object.entries(r.sin_resolver_detalle)
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ');
      await notify(MEGA, {
        key: 'caja_autollenado_sin_resolver',
        severity: sin.monto >= 50000 ? 'warn' : 'info',
        title: 'Movimientos de caja que el autollenado no pudo resolver',
        message: `${sin.movimientos} movimiento${sin.movimientos === 1 ? '' : 's'} por `
          + `$${sin.monto.toLocaleString('es-MX')} sigue${sin.movimientos === 1 ? '' : 'n'} sin cuenta contable. `
          + (detalle ? `Motivos: ${detalle}. ` : '')
          + 'Los que esperan su póliza de Kepler se resuelven solos en unos días; los demás necesitan '
          + 'que alguien declare la cuenta.',
        route: '/finanzas/caja-general',
        data: { movimientos: sin.movimientos, monto: sin.monto, detalle: r.sin_resolver_detalle },
      }).catch((e: unknown) => this.logger.warn(`aviso sin resolver: ${e instanceof Error ? e.message : e}`));
    }
  }
}
