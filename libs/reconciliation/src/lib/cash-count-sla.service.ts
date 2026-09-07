import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { RECON_NOTIFIER_PORT, ReconNotifierPort } from '@megadulces/contracts';
import { MovementReconcileService } from './movement-reconcile.service';

/**
 * SM.21 — El corte sin contar deja de ser invisible.
 *
 * El problema medido el 2026-09-02: **76 de 78 cortes cerrados no tienen conteo
 * físico**. No es un dato que falte jalar — Kepler no guarda denominaciones en
 * ningún lado (barridas las 1,275 columnas numéricas del ERP) — es trabajo que
 * no se hizo. Y mientras no tenga dueño ni reloj, no se va a hacer: contar el
 * cajón compite contra atender clientes y siempre pierde.
 *
 * Así que el turno cerrado se vuelve **exigible**: Kepler cierra → arranca el
 * plazo → vencido pasa a la bandeja del supervisor como cualquier descuadre, con
 * alerta al canal que ya existe. Reusa `reconciliation.discrepancies` a propósito:
 * el encargado ya mira esa bandeja todos los días, y una cola nueva en otro lado
 * es una cola que nadie abre.
 *
 * ── Por qué los plazos son estos
 *
 * `SLA_MIN = 45` — la mediana entre cortes de una misma caja es de horas, y el
 * cierre real toma minutos; 45 da margen para terminar de atender sin que el
 * efectivo se enfríe.
 *
 * `CRITICO_MIN = 720` (12 h) — pasado eso el turno cambió de día: ese efectivo ya
 * se depositó, se mezcló o se fue en sangrías. **Ya no se puede contar**, y el
 * hallazgo deja de ser un recordatorio para volverse un hueco permanente de
 * control. Por eso sube a `critical` en vez de apagarse.
 *
 * Lo que este servicio NO hace: inventar el conteo. Un turno vencido queda
 * marcado como no verificable, no como cuadrado.
 */
@Injectable()
export class CashCountSlaService {
  private readonly logger = new Logger(CashCountSlaService.name);
  private running = false;

  static readonly SLA_MIN = 45;
  static readonly CRITICO_MIN = 720;
  /**
   * A la cajera se le avisa **antes** que al supervisor: a los 5 min de que Kepler
   * cerró, cuando todavía está parada frente al cajón. El plazo de 45 min es para
   * escalar, no para pedir — pedir a los 45 ya llega tarde, el efectivo se guardó
   * y ella se fue a otra cosa.
   *
   * El aviso se repite en cada barrido (cada 15 min) mientras el corte siga sin
   * contar: no es spam, es la única forma de que llegue si no estaba conectada la
   * primera vez. Deja de sonar en cuanto cuenta.
   */
  private static readonly AVISO_CAJERA_MIN = 5;
  /** Ventana de barrido. Más atrás no sirve: el hallazgo ya existe y es idempotente. */
  private static readonly DIAS = 7;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly engine: MovementReconcileService,
    @Optional() @Inject(RECON_NOTIFIER_PORT) private readonly notifier?: ReconNotifierPort,
  ) {}

  /**
   * Cada 5 min. Antes era 15, que alcanzaba para escalar al supervisor pero llegaba
   * tarde para lo otro: el aviso "haz tu arqueo" tiene que caerle a la cajera
   * mientras sigue parada frente al cajón, no veinte minutos después. La consulta
   * es un índice sobre 3 días de cortes: correrla más seguido no cuesta nada.
   */
  @Cron('0 */5 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: barrido previo aún corriendo'); return; }
    await this.scanAllTenants('cron');
  }

  async scanAllTenants(source = 'cron'): Promise<{ tenants: number; vencidos: number; nuevos: number; avisados: number }> {
    this.running = true;
    let vencidos = 0, nuevos = 0, avisados = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          const r = await this.scanTenant(t.id);
          vencidos += r.vencidos; nuevos += r.nuevos; avisados += r.avisados;
        } catch (e: any) {
          this.logger.warn(`barrido tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      if (vencidos || avisados) this.logger.log(`SLA ${source}: ${vencidos} fuera de plazo (${nuevos} nuevos) · ${avisados} avisos "haz tu arqueo".`);
      return { tenants: tenants.length, vencidos, nuevos, avisados };
    } finally {
      this.running = false;
    }
  }

  /** Barrido del tenant de la request. El controlador no necesita saber su UUID. */
  async scanCurrentTenant(): Promise<{ vencidos: number; nuevos: number; avisados: number }> {
    return this.scanTenant(this.tenantCtx.requireTenantId());
  }

  async scanTenant(tenantId: string): Promise<{ vencidos: number; nuevos: number; avisados: number }> {
    // Dos consultas con el mismo SQL y distinto plazo: la de la cajera (5 min) es
    // un superconjunto de la del supervisor (45), así que se pide una sola vez con
    // el plazo corto y se parte acá.
    const todos = await this.tk.run(tenantId, async (trx) => {
      const { rows } = await trx.raw(VENCIDOS, {
        tenant: tenantId, dias: CashCountSlaService.DIAS, sla: CashCountSlaService.AVISO_CAJERA_MIN,
      });
      return rows as VencidoRow[];
    });
    const avisados = await this.avisarCajeras(tenantId, todos)
      + await this.avisarRetiros(tenantId);
    const filas = todos.filter((f) => Number(f.sin_contar_min) >= CashCountSlaService.SLA_MIN);
    if (!filas.length) return { vencidos: 0, nuevos: 0, avisados };

    let nuevos = 0;
    const criticosNuevos: any[] = [];
    await this.tk.run(tenantId, async (trx) => {
      await this.engine.ensureRule(trx, tenantId, 'arqueo_no_realizado');
      for (const f of filas) {
        const min = Number(f.sin_contar_min);
        // Ya no se puede contar: el hallazgo pasa de recordatorio a hueco de control.
        const vencido = min >= CashCountSlaService.CRITICO_MIN;
        const horas = Math.floor(min / 60);
        const importe = Number(f.efectivo_contado || 0);
        const esInsert = await this.engine.upsertDiscrepancy(trx, tenantId, {
          rule_key: 'arqueo_no_realizado', plano: 'caja',
          severity: vencido ? 'critical' : 'warn',
          // El score ordena la bandeja: pesa el monto, no solo la demora — un turno
          // de $60k sin contar importa más que uno de $900 igual de atrasado.
          score: Math.min(1, (importe / 100000) * 0.7 + Math.min(1, min / CashCountSlaService.CRITICO_MIN) * 0.3),
          titulo: `Corte sin contar${vencido ? ' (ya no se puede)' : ''}: suc ${f.warehouse_code} caja ${f.caja} — ${f.cajero_cierre || 's/cajera'}`,
          resumen: vencido
            ? `El turno del ${f.business_date} cerró hace ${horas} h y nadie contó el efectivo. Ese dinero ya se movió: el corte queda SIN VERIFICAR de forma permanente. Kepler declaró ${money(importe)}, pero su contado no es un conteo (74.6% de los cortes cierra al centavo exacto).`
            : `Kepler cerró el turno del ${f.business_date} hace ${min} min y todavía nadie cuenta el cajón. Plazo: ${CashCountSlaService.SLA_MIN} min. Kepler declaró ${money(importe)} — sin conteo físico no hay con qué contrastarlo.`,
          entity: {
            sucursal: f.warehouse_code, caja: f.caja, cajero: f.cajero_cierre || null,
            folio: f.folio, fecha: f.business_date, sin_contar_min: min,
          },
          periodo: f.business_date,
          esperado: Number(f.efectivo_esperado || 0), observado: null, diferencia: null,
          importe,
          causa_probable: vencido ? 'arqueo_no_verificable' : 'arqueo_pendiente',
          evidencia: {
            params: { sla_min: CashCountSlaService.SLA_MIN, critico_min: CashCountSlaService.CRITICO_MIN },
            hora_cierre: f.hora_cierre, sin_contar_min: min,
            kepler_contado: importe, kepler_billetes: Number(f.arqueo_billetes || 0),
            kepler_monedas: Number(f.arqueo_monedas || 0), kepler_retirado: Number(f.efectivo_retirado || 0),
            origen: 'sla_arqueo',
          },
          dedup_key: `arqueo_no_realizado:${f.warehouse_code}:${f.caja}:${f.business_date}:${f.folio}`,
        });
        if (esInsert) {
          nuevos++;
          if (vencido) criticosNuevos.push({ warehouse_code: f.warehouse_code, caja: f.caja, business_date: f.business_date, cajero: f.cajero_cierre, importe });
        }
      }
    });

    // WS fuera de la transacción y best-effort: avisar no puede tumbar el barrido.
    if (this.notifier && criticosNuevos.length) {
      for (const c of criticosNuevos) {
        await this.notifier.notifyBadCut(tenantId, { ...c, motivo: 'arqueo_no_realizado' } as any)
          .catch((e) => this.logger.warn(`notifyBadCut falló: ${e?.message || e}`));
      }
    }
    return { vencidos: filas.length, nuevos, avisados };
  }

  /**
   * "Haz tu arqueo", a cada cajera que tiene un corte cerrado sin contar.
   *
   * Es lo que faltaba para que el flujo se cierre solo: hoy el turno la espera en
   * la pantalla, pero si no la abre no se entera de nada — y eso explica buena
   * parte del 1% de cumplimiento. No es que la gente se niegue a contar: nada se
   * lo pide en el momento.
   *
   * Sin `cajero_cierre` no hay a quién avisarle. Esos son los 16 códigos de Kepler
   * que no tienen usuario en el sistema: se cuentan aparte para que el hueco se
   * vea en el log en vez de desaparecer en un `continue`.
   */
  private async avisarCajeras(tenantId: string, filas: VencidoRow[]): Promise<number> {
    if (!this.notifier?.notifyArqueoDue || !filas.length) return 0;
    let avisados = 0, sinCajera = 0;
    for (const f of filas) {
      const cajero = (f.cajero_cierre || '').trim();
      if (!cajero) { sinCajera++; continue; }
      const min = Number(f.sin_contar_min);
      await this.notifier.notifyArqueoDue(tenantId, {
        cajero_code: cajero,
        warehouse_code: f.warehouse_code, caja: f.caja,
        business_date: f.business_date, folio: f.folio,
        hora_cierre: f.hora_cierre, cerrado_hace_min: min,
        vencido: min >= CashCountSlaService.SLA_MIN,
      }).then(() => { avisados++; })
        .catch((e: any) => this.logger.warn(`aviso a ${cajero} falló: ${e?.message || e}`));
    }
    if (sinCajera) this.logger.warn(`${sinCajera} cortes sin contar no tienen a quién avisarle (código de Kepler sin usuario).`);
    return avisados;
  }

  /**
   * "Cuenta lo que estás sacando", cuando Kepler pidió el retiro.
   *
   * Esto es lo que faltaba para cubrir el dinero completo: contar solo al cierre
   * verifica ~$9,000 de $27,000 cobrados, porque el resto ya salió en sangrías.
   * El aviso llega en el momento en que el efectivo sale del cajón, que es la
   * única ventana en que todavía se puede contar.
   */
  private async avisarRetiros(tenantId: string): Promise<number> {
    if (!this.notifier?.notifyArqueoDue) return 0;
    const filas = await this.tk.run(tenantId, async (trx) => {
      const r: any = await trx.raw(RETIROS_PENDIENTES, { tenant: tenantId });
      return r.rows as RetiroPendienteRow[];
    }).catch((e: any) => { this.logger.warn(`retiros pendientes falló: ${e?.message || e}`); return [] as RetiroPendienteRow[]; });

    let n = 0;
    for (const f of filas) {
      const cajero = (f.cajero_cierre || '').trim();
      if (!cajero) continue;
      await this.notifier.notifyArqueoDue(tenantId, {
        cajero_code: cajero,
        warehouse_code: f.warehouse_code, caja: f.caja,
        business_date: f.business_date, folio: f.folio,
        hora_cierre: null,                       // el turno sigue abierto: no hay hora de cierre
        cerrado_hace_min: Number(f.sin_contar_min),
        vencido: false,
        motivo: 'retiro',
      } as any).then(() => { n++; })
        .catch((e: any) => this.logger.warn(`aviso de retiro a ${cajero} falló: ${e?.message || e}`));
    }
    return n;
  }

  /**
   * Tablero de cumplimiento: qué porcentaje de los cortes llegó a tener conteo
   * físico, y cuánto tardó. Es la métrica que hace que la cola sirva — sin ella
   * el hallazgo se acumula y nadie rinde cuentas.
   *
   * `mediana_min` se calcula solo sobre los arqueados: promediar los pendientes
   * como "infinito" daría un número que no significa nada.
   */
  async cumplimiento(q: { desde?: string; warehouseCodes?: string[] | null }): Promise<CumplimientoRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (q.warehouseCodes && !q.warehouseCodes.length) return [];
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(CUMPLIMIENTO, {
        tenant: tenantId,
        desde: q.desde || null,
        sucs: q.warehouseCodes ?? null,
        critico: CashCountSlaService.CRITICO_MIN,
      });
      return rows as CumplimientoRow[];
    });
  }
}

interface VencidoRow {
  warehouse_code: string; caja: string; folio: string; business_date: string;
  hora_cierre: string | null; cajero_cierre: string | null;
  efectivo_esperado: string | null; efectivo_contado: string | null;
  arqueo_billetes: string | null; arqueo_monedas: string | null; efectivo_retirado: string | null;
  sin_contar_min: string;
}

interface RetiroPendienteRow {
  warehouse_code: string; caja: string; folio: string; business_date: string;
  cajero_cierre: string | null;
  retirado_kepler: string; contado_nuestro: string; sin_contar: string; sin_contar_min: string;
}

export interface CumplimientoRow {
  warehouse_code: string; warehouse_name: string | null;
  cortes: number; arqueados: number; pct: number;
  pendientes: number; no_verificables: number;
  mediana_min: number | null; monto_sin_verificar: number;
}

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

/**
 * Cortes cerrados, sin conteo nuestro, pasados del plazo.
 *
 * Se lee de `analytics.cash_cuts` y no del ODS: acá interesa el corte ya cerrado
 * y con montos (para poder pesar el hallazgo por dinero), que es justo lo que esa
 * tabla garantiza. El sync de SM.20 la mantiene al día sola.
 *
 * El minuto se cuenta desde el cierre REAL (fecha del corte + hora de cierre) en
 * hora de México, no desde `created_at`: si el importer corrió tarde, el reloj no
 * puede arrancar tarde con él.
 */
const VENCIDOS = `
  SELECT cc.warehouse_code, cc.caja, cc.folio, cc.business_date::text AS business_date,
         cc.hora_cierre, cc.cajero_cierre,
         cc.efectivo_esperado, cc.efectivo_contado,
         cc.arqueo_billetes, cc.arqueo_monedas, cc.efectivo_retirado,
         GREATEST(0, floor(EXTRACT(EPOCH FROM (
           (now() AT TIME ZONE 'America/Mexico_City')
           - (cc.business_date + COALESCE(NULLIF(btrim(cc.hora_cierre), ''), '23:59:00')::time)
         )) / 60))::int AS sin_contar_min
    FROM analytics.cash_cuts cc
   WHERE cc.tenant_id = CAST(:tenant AS uuid)
     AND cc.business_date >= current_date - CAST(:dias AS int)
     AND COALESCE(cc.efectivo_contado, 0) <> 0
     AND NOT EXISTS (
           SELECT 1 FROM reconciliation.blind_counts b
            WHERE b.tenant_id = cc.tenant_id
              AND b.warehouse_code = cc.warehouse_code
              AND b.tipo = 'cierre'
              AND b.cash_cut_folio = cc.folio)
     AND GREATEST(0, floor(EXTRACT(EPOCH FROM (
           (now() AT TIME ZONE 'America/Mexico_City')
           - (cc.business_date + COALESCE(NULLIF(btrim(cc.hora_cierre), ''), '23:59:00')::time)
         )) / 60)) >= CAST(:sla AS int)
   ORDER BY cc.efectivo_contado DESC NULLS LAST
   LIMIT 500
`;

/**
 * Retiros que Kepler ya pidió y todavía nadie contó.
 *
 * El disparador NO lo inventamos: cuando la caja junta su límite (`c46`, típicamente
 * $15,000) Kepler le pide a la cajera sacar el dinero, y al hacerlo **sube `c48`**
 * en el turno ABIERTO. Verificado en vivo: suc 01 caja 1 con `c48 = 15,000.00`
 * contra `c46 = 15,000.00`, turno sin cerrar.
 *
 * Kepler guarda el ACUMULADO, no cada sangría. Así que la señal es la diferencia:
 * lo que el ERP dice que salió menos lo que nosotros ya contamos. Mientras esa
 * brecha sea de más de un peso, hay efectivo que salió del cajón sin registro de
 * qué billetes era — y eso es lo que se le pide contar.
 *
 * Es **stateless a propósito**: no guarda "último visto" en memoria ni en tabla.
 * Al reiniciar la API no se pierde ni se duplica nada, porque la pregunta se
 * responde entera contra la base cada vez.
 */
const RETIROS_PENDIENTES = `
  SELECT k.sucursal            AS warehouse_code,
         k.c2                  AS caja,
         k.c3::bigint::text    AS folio,
         k.c5::date::text      AS business_date,
         NULLIF(btrim(k.c8), '') AS cajero_cierre,
         NULLIF(btrim(k.c6), '') AS hora_cierre,
         round(k.c48, 2)       AS retirado_kepler,
         COALESCE(b.contado, 0) AS contado_nuestro,
         round(k.c48 - COALESCE(b.contado, 0), 2) AS sin_contar,
         GREATEST(0, floor(EXTRACT(EPOCH FROM (
           (now() AT TIME ZONE 'America/Mexico_City')
           - (k.c5::date + COALESCE(NULLIF(btrim(k.c6), ''), '00:00:00')::time)
         )) / 60))::int AS sin_contar_min
    FROM kepler_ods.kdpv_folio_caja k
    LEFT JOIN LATERAL (
      SELECT sum(bc.total_contado) AS contado
        FROM reconciliation.blind_counts bc
       WHERE bc.tenant_id = CAST(:tenant AS uuid)
         AND bc.tipo = 'retiro'
         AND bc.warehouse_code = k.sucursal
         AND bc.cash_cut_folio = k.c3::bigint::text
    ) b ON true
   WHERE k.c10::date = DATE '1800-01-01'            -- turno ABIERTO: la caja sigue cobrando
     AND k.c5::date >= current_date - 1
     AND COALESCE(k.c48, 0) > 0                     -- Kepler ya pidió al menos un retiro
     AND (k.c48 - COALESCE(b.contado, 0)) > 1       -- y falta contar parte de eso
   ORDER BY (k.c48 - COALESCE(b.contado, 0)) DESC
   LIMIT 200
`;

const CUMPLIMIENTO = `
  WITH base AS (
    SELECT cc.warehouse_code, cc.warehouse_name, cc.folio, cc.efectivo_contado,
           GREATEST(0, floor(EXTRACT(EPOCH FROM (
             (now() AT TIME ZONE 'America/Mexico_City')
             - (cc.business_date + COALESCE(NULLIF(btrim(cc.hora_cierre), ''), '23:59:00')::time)
           )) / 60))::int AS edad_min,
           b.id AS arqueo_id,
           CASE WHEN b.id IS NULL THEN NULL ELSE
             GREATEST(0, floor(EXTRACT(EPOCH FROM (
               (b.created_at AT TIME ZONE 'America/Mexico_City')
               - (cc.business_date + COALESCE(NULLIF(btrim(cc.hora_cierre), ''), '23:59:00')::time)
             )) / 60))::int
           END AS tardo_min
      FROM analytics.cash_cuts cc
      LEFT JOIN reconciliation.blind_counts b
        ON b.tenant_id = cc.tenant_id AND b.warehouse_code = cc.warehouse_code
       AND b.tipo = 'cierre' AND b.cash_cut_folio = cc.folio
     WHERE cc.tenant_id = CAST(:tenant AS uuid)
       AND COALESCE(cc.efectivo_contado, 0) <> 0
       AND (CAST(:desde AS date) IS NULL OR cc.business_date >= CAST(:desde AS date))
       AND (CAST(:sucs AS text[]) IS NULL OR cc.warehouse_code = ANY(CAST(:sucs AS text[])))
  )
  SELECT warehouse_code, max(warehouse_name) AS warehouse_name,
         count(*)::int                                             AS cortes,
         count(arqueo_id)::int                                     AS arqueados,
         round(100.0 * count(arqueo_id) / NULLIF(count(*), 0), 1)::float AS pct,
         count(*) FILTER (WHERE arqueo_id IS NULL AND edad_min <  CAST(:critico AS int))::int AS pendientes,
         count(*) FILTER (WHERE arqueo_id IS NULL AND edad_min >= CAST(:critico AS int))::int AS no_verificables,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY tardo_min)::int AS mediana_min,
         COALESCE(round(sum(efectivo_contado) FILTER (WHERE arqueo_id IS NULL), 2), 0)::float AS monto_sin_verificar
    FROM base
   GROUP BY warehouse_code
   ORDER BY monto_sin_verificar DESC
`;
