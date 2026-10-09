import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService } from '@megadulces/platform-core';
import {
  resumirCambios,
  type PriceChangeNoticeDto,
  type PriceNoticeCut,
  type PriceNoticeRecipientsDto,
  type PriceNoticeShareRequestDto,
  type PriceNoticeShareResultDto,
} from '@megadulces/contracts';
import { CommercialLabelsService } from './commercial-labels.service';

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const ZONA_MX = 'America/Mexico_City';
const PLAZA = /^[0-9]{2}$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
/** La bitácora que alcanza la pantalla de cambios llega a 60 días: más atrás no hay de dónde contar. */
const VENTANA_DIAS = 60;
const MAX_NOTA = 500;
/** Freno contra el reenvío accidental: la misma persona, la misma plaza y el mismo día. */
const REENVIO_MIN = 10;

/** Lo que dejó una corrida del generador, por tenant. Se escribe en el latido: un aviso que no salió se DECLARA. */
export interface PriceNoticeRunResult {
  fecha: string;
  corte: 'manana' | 'tarde';
  /** Plazas con bitácora en la ventana. */
  plazas: number;
  creados: number;
  actualizados: number;
  /** La plaza SÍ tiene dato de ese día y no hubo cambios que valgan una etiqueta (no se avisa: D4). */
  sin_cambios: number;
  /** La bitácora de la plaza todavía no llega a ese día: «no sé» no es «no hubo». Nunca se cuenta como cero. */
  sin_dato: string[];
  /** Plazas que tuvieron aviso y no tienen a NADIE con tienda asignada que lo vea (D5). */
  sin_destinatarios: string[];
  errores: string[];
}

/**
 * `[ETQ-AVISOS.1–3]` Avisos de cambios de precio a las sucursales, y el envío manual de Compras.
 *
 * ── Qué hace y cuándo ──────────────────────────────────────────────────────────────────────
 * Dos cortes diarios (D1), hora de México:
 *   · **07:30 — `manana`**: resume AYER. Es el día que la encargada revisa al abrir la tienda.
 *   · **14:00 — `tarde`**: resume lo que va de HOY, para no esperar al día siguiente.
 * Juntos cubren todo el día sin hueco: lo de la noche cae en el corte de la mañana siguiente.
 *
 * ── De dónde sale lo que cuenta ────────────────────────────────────────────────────────────
 * De la MISMA bitácora, el MISMO filtro y la MISMA regla de agrupado que la pantalla
 * (`CommercialLabelsService.filasDelDia` + `resumirCambios` del contrato). Si el aviso dijera
 * 14 y la lista mostrara 12 nadie volvería a creerle a ninguno de los dos.
 *
 * ── Lo que NO hace, a propósito ────────────────────────────────────────────────────────────
 *  · **Un día sin cambios no genera aviso** (`productos >= 1`, lo hace cumplir la tabla): un aviso
 *    vacío enseña a ignorar la campana.
 *  · **Sin dato no es cero.** Si la bitácora de la plaza no llega a ese día, no se avisa y se
 *    DECLARA en el latido (`sin_dato`). Decir «no hubo cambios» porque el dato no había llegado
 *    es exactamente la mentira que la Fase VP existe para matar.
 *  · No hay WebSocket: el worker (donde corre el cron) no lo tiene (ADR-080). La fila ES la
 *    entrega; la campana la recoge por poll.
 *
 * El cron se apaga con `ENABLE_PRICE_CHANGE_NOTICES=false`; el disparo manual siempre funciona.
 */
@Injectable()
export class PriceChangeNoticesService {
  private readonly logger = new Logger(PriceChangeNoticesService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly labels: CommercialLabelsService,
  ) {}

  // ───────────────────────────── Generador (cron) ─────────────────────────────

  /** 07:30 MX — resume AYER. */
  @Cron('0 30 7 * * *', { timeZone: ZONA_MX })
  async programadoManana(): Promise<void> {
    await this.programado('manana');
  }

  /** 14:00 MX — resume lo que va de HOY. */
  @Cron('0 0 14 * * *', { timeZone: ZONA_MX })
  async programadoTarde(): Promise<void> {
    await this.programado('tarde');
  }

  private async programado(corte: 'manana' | 'tarde'): Promise<void> {
    if (process.env.ENABLE_PRICE_CHANGE_NOTICES === 'false') return;
    if (this.running) {
      this.logger.warn(`Skip ${corte}: la corrida anterior sigue en curso`);
      return;
    }
    try {
      await this.generarTodos(corte);
    } catch (e) {
      // `generarTodos` ya dejó su latido en `error`; acá sólo se evita que el cron tire el proceso.
      this.logger.error(`[ETQ-AVISOS] corte ${corte} falló: ${(e as Error).message}`);
    }
  }

  /** El día que resume cada corte. Separado y público para que el candado lo pruebe sin reloj. */
  static fechaDelCorte(corte: 'manana' | 'tarde'): string {
    return CommercialLabelsService.diaMx(corte === 'manana' ? -1 : 0);
  }

  async generarTodos(corte: 'manana' | 'tarde', fecha?: string): Promise<PriceNoticeRunResult> {
    this.running = true;
    const t0 = Date.now();
    const dia = fecha ?? PriceChangeNoticesService.fechaDelCorte(corte);
    const acc: PriceNoticeRunResult = {
      fecha: dia, corte, plazas: 0, creados: 0, actualizados: 0, sin_cambios: 0,
      sin_dato: [], sin_destinatarios: [], errores: [],
    };
    let error: string | null = null;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const r = await this.generarParaTenant(t.id, corte, dia);
        acc.plazas += r.plazas;
        acc.creados += r.creados;
        acc.actualizados += r.actualizados;
        acc.sin_cambios += r.sin_cambios;
        acc.sin_dato.push(...r.sin_dato);
        acc.sin_destinatarios.push(...r.sin_destinatarios);
        acc.errores.push(...r.errores);
      }
      this.logger.log(
        `Avisos de precio ${corte} (${dia}): ${acc.plazas} plazas · ${acc.creados} nuevos · ` +
        `${acc.actualizados} actualizados · ${acc.sin_cambios} sin cambios · ` +
        `${acc.sin_dato.length} sin dato · ${acc.sin_destinatarios.length} sin destinatarios`,
      );
      return acc;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.running = false;
      await this.latir(acc, Date.now() - t0, error);
    }
  }

  async generarParaTenant(tenantId: string, corte: 'manana' | 'tarde', fecha: string): Promise<PriceNoticeRunResult> {
    const r: PriceNoticeRunResult = {
      fecha, corte, plazas: 0, creados: 0, actualizados: 0, sin_cambios: 0,
      sin_dato: [], sin_destinatarios: [], errores: [],
    };
    return this.tk.run(tenantId, async (trx) => {
      const plazas = (await this.labels.branchesIn(trx)).filter((b) => PLAZA.test(b.sucursal) && b.sucursal !== '00');
      const destinatarios = await this.destinatariosIn(trx, tenantId);
      r.plazas = plazas.length;

      for (const p of plazas) {
        // Sin dato NO es cero: si la bitácora de la plaza no llega a ese día no se sabe si hubo cambios.
        if (p.ultimo_dia < fecha) { r.sin_dato.push(p.sucursal); continue; }
        try {
          // Un SAVEPOINT por plaza: si una falla, la transacción no queda abortada para las demás.
          await trx.raw('SAVEPOINT pcn_plaza');
          const filas = await this.labels.filasDelDia(trx, p.sucursal, fecha);
          const res = resumirCambios(filas);
          if (res.productos < 1) {
            r.sin_cambios++;
          } else {
            const { rows } = await trx.raw(
              `INSERT INTO commercial.price_change_notices
                 (tenant_id, plaza, fecha, corte, origen, productos, suben, bajan, sin_precio)
               VALUES (?, ?, ?::date, ?, 'auto', ?, ?, ?, ?)
               ON CONFLICT (tenant_id, plaza, fecha, corte) WHERE origen = 'auto'
               DO UPDATE SET productos = EXCLUDED.productos, suben = EXCLUDED.suben,
                             bajan = EXCLUDED.bajan, sin_precio = EXCLUDED.sin_precio
               RETURNING (xmax = 0) AS nuevo`,
              [tenantId, p.sucursal, fecha, corte, res.productos, res.suben, res.bajan, res.sin_precio],
            );
            if (rows[0]?.nuevo) r.creados++; else r.actualizados++;
            if (!destinatarios.get(p.sucursal)) r.sin_destinatarios.push(p.sucursal);
          }
          await trx.raw('RELEASE SAVEPOINT pcn_plaza');
        } catch (e) {
          await trx.raw('ROLLBACK TO SAVEPOINT pcn_plaza');
          await trx.raw('RELEASE SAVEPOINT pcn_plaza');
          r.errores.push(`${p.sucursal}: ${(e as Error).message}`);
          this.logger.error(`[ETQ-AVISOS] plaza ${p.sucursal} ${fecha}: ${(e as Error).message}`);
        }
      }
      if (r.sin_destinatarios.length) {
        // D5: se DECLARA. El aviso queda en la bandeja para quien tenga alcance sobre esa plaza,
        // pero en vivo no le llega a nadie con tienda asignada.
        this.logger.warn(`[ETQ-AVISOS] sin nadie con tienda asignada que lo vea: plaza(s) ${r.sin_destinatarios.join(', ')}`);
      }
      return r;
    });
  }

  /**
   * Cuántas personas con tienda asignada ven los avisos de cada plaza: usuarios activos con
   * `STORE_LABELS_VER` cuyo `warehouse_code` es esa plaza.
   *
   * ⚠️ Es una cuenta de quienes tienen la PLAZA ASIGNADA, y por eso puede dar 0 para una plaza que
   * sí tiene quien la vea: quien no tiene alcance declarado ve todas (patrón de `ScopeService`,
   * `[VEC.4]`). Dar 0 no apaga el aviso — lo DECLARA, que es lo que D5 pide.
   */
  private async destinatariosIn(trx: Knex.Transaction, tenantId: string): Promise<Map<string, number>> {
    const { rows } = await trx.raw(
      `SELECT u.warehouse_code AS plaza, count(DISTINCT u.id)::int AS n
         FROM identity.users u
         JOIN identity.role_permissions rp
           ON rp.role_name = u.role_name AND rp.tenant_id = u.tenant_id AND rp.deleted_at IS NULL
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
          AND u.warehouse_code IS NOT NULL
          AND (rp.permissions ->> 'STORE_LABELS_VER') = 'true'
        GROUP BY u.warehouse_code`,
      [tenantId],
    );
    return new Map<string, number>((rows as any[]).map((x): [string, number] => [String(x.plaza).trim(), Number(x.n)]));
  }

  /**
   * Latido a `analytics.cron_runs`. Obligatorio, no cosmético: su umbral vive en `CRON_JOBS`
   * (`price_change_notices`) y sin registrarlo `db-health` cae en `cfg ? classify : 'ok'`.
   *
   * `error` cuando la corrida falló, o cuando NINGUNA plaza tenía dato de ese día (la ingesta de la
   * bitácora está caída y todo lo demás se vería «sin cambios»). Cero plazas procesadas también es
   * falla, no éxito silencioso. Un día sin cambios en plazas con dato SÍ es `ok`: es lo normal.
   */
  private async latir(r: PriceNoticeRunResult, ms: number, error: string | null): Promise<void> {
    const sinFuente = r.plazas === 0 || r.sin_dato.length === r.plazas;
    const falloTodas = r.plazas > 0 && r.errores.length >= r.plazas;
    const status = error || sinFuente || falloTodas ? 'error' : 'ok';
    const nota = `${r.corte} ${r.fecha} · ${r.plazas} plazas · ${r.creados} nuevos · ${r.actualizados} act. · ` +
      `${r.sin_cambios} sin cambios` +
      (r.sin_dato.length ? ` · SIN DATO: ${r.sin_dato.join(',')}` : '') +
      (r.sin_destinatarios.length ? ` · sin destinatarios: ${r.sin_destinatarios.join(',')}` : '') +
      (r.errores.length ? ` · ${r.errores.length} con error` : '');
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'price_change_notices',
          label: 'Avisos de cambios de precio',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status,
          rows_affected: r.creados + r.actualizados,
          duration_ms: ms,
          note: error ? null : nota.slice(0, 480),
          error: error
            ? error.slice(0, 500)
            : status === 'error'
              ? (r.plazas === 0 ? 'cero plazas con bitácora' : sinFuente ? 'la bitácora no llega a ese día en NINGUNA plaza' : 'falló en todas las plazas')
              : null,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch {
      /* el latido nunca rompe al que late (criterio de cron-heartbeat.js) */
    }
  }

  // ───────────────────────────── Lectura (campana) ─────────────────────────────

  /**
   * Los avisos que le tocan a quien pregunta. `plazas`: el alcance YA resuelto por `ScopeService`
   * (`null` = sin recorte, `[]` = no ve nada). Sin `desde`, los últimos 3 días: la campana no
   * necesita el historial, y un aviso de hace una semana ya no es una noticia.
   */
  async list(plazas: string[] | null, desde?: string): Promise<PriceChangeNoticeDto[]> {
    if (plazas !== null && !plazas.length) return [];
    const since = desde && !Number.isNaN(Date.parse(desde)) ? new Date(desde).toISOString() : null;
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT n.id, n.plaza, w.name AS plaza_nombre, n.fecha::text AS fecha, n.corte, n.origen, n.productos,
                n.suben, n.bajan, n.sin_precio, n.nota, coalesce(u.nombre, u.username) AS enviado_por, n.created_at
           FROM commercial.price_change_notices n
           LEFT JOIN identity.users u ON u.id = n.created_by AND u.tenant_id = n.tenant_id
           LEFT JOIN commercial.warehouses w ON w.tenant_id = n.tenant_id AND w.code = n.plaza AND w.deleted_at IS NULL
          WHERE n.created_at > coalesce(?::timestamptz, now() - interval '3 days')
            AND (?::text[] IS NULL OR n.plaza = ANY(?::text[]))
          ORDER BY n.created_at DESC
          LIMIT 100`,
        [since, plazas, plazas],
      );
      return (rows as any[]).map((x) => ({
        id: String(x.id),
        plaza: String(x.plaza),
        plaza_nombre: x.plaza_nombre ?? null,
        fecha: String(x.fecha),
        corte: x.corte as PriceNoticeCut,
        origen: x.origen as 'auto' | 'compras',
        productos: Number(x.productos),
        suben: Number(x.suben),
        bajan: Number(x.bajan),
        sin_precio: Number(x.sin_precio),
        nota: x.nota ?? null,
        enviado_por: x.origen === 'compras' ? (x.enviado_por ?? null) : null,
        created_at: new Date(x.created_at).toISOString(),
      }));
    });
  }

  // ───────────────────────────── Compras comparte ─────────────────────────────

  /** Para el diálogo de compartir: por plaza, cuántos la ven y hasta qué día llega su bitácora. */
  async recipients(): Promise<PriceNoticeRecipientsDto[]> {
    return this.tk.run(async (trx) => {
      const tenantId = await this.tenantId(trx);
      const plazas = (await this.labels.branchesIn(trx)).filter((b) => PLAZA.test(b.sucursal) && b.sucursal !== '00');
      const dest = await this.destinatariosIn(trx, tenantId);
      return plazas.map((b) => ({
        plaza: b.sucursal, nombre: b.nombre, destinatarios: dest.get(b.sucursal) ?? 0, ultimo_dia: b.ultimo_dia,
      }));
    });
  }

  /**
   * Compras manda el aviso a una o varias plazas. Cada plaza se resuelve POR SEPARADO y devuelve su
   * propio estado con el motivo: un «no se envió» sin razón no se puede corregir.
   *
   * ⛔ Nunca avisa de lo que no puede afirmar: sin cambios no manda un aviso vacío (D4); sin dato
   * de ese día no dice «no hubo», dice `sin_dato`.
   *
   * `alcance` es el del que manda (`ScopeService`): quien sólo ve ciertas plazas no puede avisarle
   * a otras. Una plaza fuera de su alcance se reporta como `plaza_invalida`, igual que una que no
   * existe — no se confirma qué plazas hay más allá de lo que puede ver.
   */
  async share(dto: PriceNoticeShareRequestDto, actorId: string, alcance: string[] | null): Promise<PriceNoticeShareResultDto[]> {
    const plazasPedidas = Array.from(new Set((dto?.plazas ?? []).map((p) => String(p ?? '').trim())));
    if (!plazasPedidas.length) throw new BadRequestException('Elige al menos una sucursal.');
    if (plazasPedidas.length > 20) throw new BadRequestException('Máximo 20 sucursales por envío.');

    const hoy = CommercialLabelsService.diaMx(0);
    const fecha = dto?.fecha ?? CommercialLabelsService.diaMx(-1);
    if (!DIA.test(fecha)) throw new BadRequestException('La fecha debe ser YYYY-MM-DD.');
    if (fecha > hoy) throw new BadRequestException('No se puede avisar de un día que todavía no llega.');
    if (fecha < CommercialLabelsService.diaMx(-VENTANA_DIAS)) {
      throw new BadRequestException(`Sólo hay bitácora de los últimos ${VENTANA_DIAS} días.`);
    }
    const nota = String(dto?.nota ?? '').trim() || null;
    if (nota && nota.length > MAX_NOTA) throw new BadRequestException(`La nota no puede pasar de ${MAX_NOTA} caracteres.`);

    return this.tk.run(async (trx) => {
      const tenantId = await this.tenantId(trx);
      const plazas = new Map((await this.labels.branchesIn(trx)).map((b) => [b.sucursal, b]));
      const dest = await this.destinatariosIn(trx, tenantId);
      const out: PriceNoticeShareResultDto[] = [];

      for (const plaza of plazasPedidas) {
        const info = plazas.get(plaza);
        const permitida = PLAZA.test(plaza) && plaza !== '00' && !!info && (alcance === null || alcance.includes(plaza));
        const destinatarios = dest.get(plaza) ?? 0;
        if (!permitida) { out.push({ plaza, estado: 'plaza_invalida', productos: 0, destinatarios: 0, id: null }); continue; }
        // Sin dato NO es cero.
        if (info!.ultimo_dia < fecha) { out.push({ plaza, estado: 'sin_dato', productos: 0, destinatarios, id: null }); continue; }

        const res = resumirCambios(await this.labels.filasDelDia(trx, plaza, fecha));
        if (res.productos < 1) { out.push({ plaza, estado: 'sin_cambios', productos: 0, destinatarios, id: null }); continue; }

        const { rows: yaMando } = await trx.raw(
          `SELECT 1 FROM commercial.price_change_notices
            WHERE tenant_id = ? AND origen = 'compras' AND created_by = ? AND plaza = ? AND fecha = ?::date
              AND created_at > now() - (? || ' minutes')::interval
            LIMIT 1`,
          [tenantId, actorId, plaza, fecha, String(REENVIO_MIN)],
        );
        if (yaMando.length) { out.push({ plaza, estado: 'repetido', productos: res.productos, destinatarios, id: null }); continue; }

        const { rows } = await trx.raw(
          `INSERT INTO commercial.price_change_notices
             (tenant_id, plaza, fecha, corte, origen, productos, suben, bajan, sin_precio, nota, created_by)
           VALUES (?, ?, ?::date, 'compras', 'compras', ?, ?, ?, ?, ?, ?)
           RETURNING id`,
          [tenantId, plaza, fecha, res.productos, res.suben, res.bajan, res.sin_precio, nota, actorId],
        );
        out.push({ plaza, estado: 'enviado', productos: res.productos, destinatarios, id: String(rows[0].id) });
      }
      return out;
    });
  }

  private async tenantId(trx: Knex.Transaction): Promise<string> {
    const { rows } = await trx.raw(`SELECT public.current_tenant_id()::text AS t`);
    return String(rows[0].t);
  }
}
