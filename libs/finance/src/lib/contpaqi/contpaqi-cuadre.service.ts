import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import {
  cuadrar, resumirCuadre, PLAZO_DIAS,
  type CandidatoContpaqi, type ExportPendiente, type ResultadoCuadre,
} from './cuadre.engine';
import { PREFIJO } from './token';

/**
 * Fase CP `[CP.8.10]` — **El servicio del cuadre: la I/O alrededor del motor.**
 *
 * Toda la REGLA vive en `cuadre.engine.ts`, que es puro y tiene su propio candado (35 ✓). Acá
 * sólo hay tres cosas: leer lo que está esperando confirmación, buscar sus candidatos en lo que
 * el carril de vuelta ya trajo, y escribir el veredicto. ⭐ El motor no se reimplementa ni se
 * "ayuda" con atajos: si hiciera falta una excepción, va en el motor y con su prueba.
 *
 * ── Por qué esto cierra el puente ───────────────────────────────────────────────────────────
 * Un sink entrega; nadie puede afirmar desde ahí que ContPAQi tenga el asiento. Esto sí: busca
 * el token en `analytics.gl_polizas`, que el carril `contpaqi` de `ops/vl/crontab.feeds` refresca
 * **cada minuto**. Sin este servicio, lo construido es un exportador.
 *
 * ── ⚠️ Lo que NO está probado contra datos reales ───────────────────────────────────────────
 * La migración `[CP.8.1]` **no está aplicada** (`contpaqi.*` en 0 tablas), así que este servicio
 * no se ha ejercido de punta a punta. Lo que sí está probado es la regla que ejecuta. Queda
 * declarado acá y en el tracker — no se da por bueno porque compile.
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/** `job_key` del latido. ⚠️ Tiene que existir en `CRON_JOBS` o el sensor da verde incondicional. */
export const JOB_KEY = 'contpaqi_cuadre';

@Injectable()
export class ContpaqiCuadreService {
  private readonly log = new Logger(ContpaqiCuadreService.name);

  constructor(@Inject('KNEX_NEW_DB') private readonly db: Knex) {}

  /**
   * Cada 10 minutos. ⚠️ **Sin `timeZone`**: el contenedor corre en UTC y pasarle una zona a un
   * `@Cron` de intervalo no cambia nada salvo confundir a quien lo lee (gotcha del repo). Para un
   * job de intervalo la zona es irrelevante — no tiene hora de pared.
   *
   * La cadencia sale de medir el otro lado: el carril de vuelta corre cada minuto, así que 10 min
   * es tiempo de sobra para que una póliza importada aparezca, y no castiga la base con una
   * consulta cada minuto sobre 128 mil filas.
   */
  @Cron('0 */10 * * * *')
  async cron(): Promise<void> {
    try {
      const r = await this.cuadrarPendientes();
      if (r.total) this.log.log(`cuadre: ${r.sincronizados}/${r.juzgables} sincronizados de ${r.total} pendientes`);
    } catch (e) {
      this.log.error(`cuadre falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Una pasada. Devuelve el resumen que el latido publica.
   *
   * `hoy` se puede inyectar para poder probarlo: el motor no lee el reloj (si lo hiciera, su
   * candado cambiaría de resultado según el día en que se corra) y este servicio tampoco debería
   * imponérselo a escondidas.
   */
  async cuadrarPendientes(hoy?: string): Promise<ReturnType<typeof resumirCuadre>> {
    const t0 = Date.now();
    const fechaHoy = hoy ?? new Date().toISOString().slice(0, 10);
    let error: string | null = null;
    let resumen = resumirCuadre([]);

    try {
      // 1. Lo que está esperando confirmación. `verificada IS NULL` es la clave: `false` ya tuvo
      //    veredicto y volver a juzgarlo pisaría un motivo escrito.
      const pendientes: ExportPendiente[] = (await this.db('contpaqi.poliza_exports')
        .where({ tenant_id: MEGA })
        .whereIn('estado', ['entregada', 'armada'])
        .whereNull('verificada')
        .select(
          'evento_tipo', 'evento_id', 'periodo', 'total', 'asiento',
          this.db.raw(`asiento->>'fecha' as fecha`),
          this.db.raw(`(asiento->>'tipo_poliza')::int as tipo_poliza`),
          this.db.raw(`asiento->>'token' as token`),
          this.db.raw(`to_char(updated_at, 'YYYY-MM-DD') as entregada_en`),
        )) as unknown as ExportPendiente[];

      if (!pendientes.length) {
        // ⭐ Cero pendientes NO es un error, y tampoco es salud: es silencio. Se late igual, con
        // la nota diciéndolo, para que el tablero distinga "nada que hacer" de "no corrió".
        resumen = resumirCuadre([]);
        return resumen;
      }

      // 2. Los candidatos: las pólizas que el carril de vuelta trajo con un token nuestro, más
      //    las del periodo (para el pareo por importe, que es el fallback).
      //    ⚠️ Una sola consulta, no una por evento: con 128 mil pólizas, N consultas serían N
      //    scans. El universo de interés es chico — los periodos que tocan los pendientes.
      // ⭐ Medido el 2026-10-09 contra prod: traer el periodo COMPLETO daba **17,596 filas en
      // 238 ms** para un solo mes. Pasa el gate de 500 ms por poco y se lo come con 3 periodos
      // pendientes — y la mayoría de esas filas no puede casar con nada.
      //
      // El fallback por importe sólo necesita las pólizas que comparten **fecha Y total** con
      // algún pendiente. Es una sobre-aproximación deliberada (no se filtra por tipo acá): el
      // motor hace el pareo exacto, y este `WHERE` sólo está para no arrastrar el mes entero.
      const fechas = [...new Set(pendientes.map((p) => p.fecha).filter(Boolean))];
      const totales = [...new Set(pendientes.map((p) => Number(p.total)).filter((n) => Number.isFinite(n)))];
      const candidatos: CandidatoContpaqi[] = (await this.db('analytics.gl_polizas')
        .where({ tenant_id: MEGA })
        .where((qb) => {
          // Por token: la llave de certeza. Barata — son sólo las pólizas que nosotros pusimos.
          qb.whereILike('concepto', `${PREFIJO}%`);
          // Por importe: el fallback, acotado a lo que puede casar.
          if (fechas.length && totales.length) {
            // `= ANY(?::tipo[])` y no `whereIn(raw, …)`: lo segundo funciona en runtime pero
            // knex no lo tipa, y un `any` escondido en el camino del dinero es justo lo que no
            // conviene normalizar. Esta forma es la misma consulta y sí typechequea.
            qb.orWhere((q) => q
              .whereRaw(`to_char(fecha, 'YYYY-MM-DD') = ANY(?::text[])`, [fechas])
              .whereRaw('cargos = ANY(?::numeric[])', [totales]));
          }
        })
        .select(
          'ejercicio', 'periodo', 'tipo_pol', 'folio', 'guid', 'concepto',
          this.db.raw(`to_char(fecha, 'YYYY-MM-DD') as fecha`),
          this.db.raw('cargos::float8 as cargos'),
          this.db.raw('abonos::float8 as abonos'),
        )) as unknown as CandidatoContpaqi[];

      // 3. El motor decide. Acá no hay lógica de negocio: sólo se le pasa cada pendiente con el
      //    universo de candidatos y se guarda lo que dictamine.
      const resultados: ResultadoCuadre[] = [];
      for (const p of pendientes) {
        const r = cuadrar({ ...p, total: Number(p.total) }, candidatos, fechaHoy);
        resultados.push(r);
        await this.guardar(p, r);
      }

      resumen = resumirCuadre(resultados);
      return resumen;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      await this.latir(resumen, Date.now() - t0, error);
    }
  }

  /**
   * Escribe el veredicto. ⛔ **`aplicada` sólo llega por el veredicto homónimo** — ningún otro
   * camino asciende un evento, que es justo lo que separa un puente de un exportador.
   */
  private async guardar(p: ExportPendiente, r: ResultadoCuadre): Promise<void> {
    const estado = r.veredicto === 'aplicada' ? 'aplicada'
      : r.veredicto === 'no_aparecio' ? 'rechazada'
      : undefined; // `probable`, `difiere`, `ambiguo` y `esperando` NO mueven el estado: el
                   // evento sigue entregado y su veredicto vive en `verificada` + `motivo`.
    await this.db('contpaqi.poliza_exports')
      .where({ tenant_id: MEGA, evento_tipo: p.evento_tipo, evento_id: p.evento_id })
      .update({
        ...(estado ? { estado } : {}),
        verificada: r.verificada,
        // Sólo se sella la hora cuando hubo veredicto de verdad. `esperando` deja `NULL`: todavía
        // no se verificó nada, y poner una fecha ahí haría ver revisado lo que sigue en el aire.
        verificada_en: r.verificada === null ? null : this.db.fn.now(),
        contpaqi_folio: r.contpaqi_folio,
        contpaqi_guid: r.contpaqi_guid,
        motivo: r.motivo,
        updated_at: this.db.fn.now(),
      });
  }

  /**
   * Latido. ⭐ Mide **ENTREGA** —cuántos eventos están de verdad sincronizados— y no "el proceso
   * corrió" (ADR-053). Un cuadre que corre perfecto sobre cero eventos no es salud: es silencio,
   * y la nota lo dice con esas palabras.
   *
   * ⚠️ `JOB_KEY` tiene que estar en `CRON_JOBS` de `db-health.service.ts`: sin umbral registrado
   * el sensor cae en `cfg ? classify : 'ok'` y da **verde incondicional** (lo midió la Fase VP).
   */
  private async latir(
    resumen: ReturnType<typeof resumirCuadre>, ms: number, error: string | null,
  ): Promise<void> {
    try {
      const nota = resumen.total === 0
        ? 'sin eventos pendientes de cuadrar'
        : `${resumen.sincronizados}/${resumen.juzgables} sincronizados · ${resumen.por.esperando} esperando · `
          + `${resumen.por.difiere} difieren · ${resumen.por.probable} por confirmar · ${resumen.por.no_aparecio} no aparecieron`;
      await this.db('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: JOB_KEY,
          label: 'Cuadre del puente ContPAQi',
          last_start: this.db.fn.now(),
          last_finish: this.db.fn.now(),
          status: error ? 'error' : 'ok',
          rows_affected: resumen.total,
          duration_ms: ms,
          note: error ? null : nota,
          error: error ? error.slice(0, 500) : null,
          host: 'api',
          updated_at: this.db.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch { /* el latido nunca rompe al que late */ }
  }

  /** Para la bandeja de `[CP.8.11]`: lo que no cuadró y necesita a una persona. */
  async divergencias(): Promise<unknown[]> {
    return this.db('contpaqi.poliza_exports')
      .where({ tenant_id: MEGA })
      // Dos casos, y son distintos: lo que YA tuvo veredicto negativo (difiere · ambiguo ·
      // no_aparecio), y lo que casó sólo por importe — `probable`, que no asciende solo y está
      // esperando que una persona confirme. Lo que sigue en `esperando` NO entra: todavía no se
      // le puede pedir nada a nadie.
      .where((qb) => qb
        .where('verificada', false)
        .orWhere((q) => q.whereNull('verificada').whereNotNull('contpaqi_folio')))
      .orderBy('updated_at', 'desc')
      .limit(200)
      .select('evento_tipo', 'evento_id', 'periodo', 'total', 'estado', 'verificada',
        'contpaqi_folio', 'contpaqi_guid', 'motivo', 'updated_at');
  }

  /** El plazo que usa el motor, para que la bandeja lo muestre sin repetir la constante. */
  get plazoDias(): number {
    return PLAZO_DIAS;
  }
}
