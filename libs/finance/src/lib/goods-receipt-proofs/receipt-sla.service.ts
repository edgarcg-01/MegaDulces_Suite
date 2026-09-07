import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT, FinanceNotifierPort } from '@megadulces/contracts';

/**
 * `[RE.27.C]` — La cola de entradas deja de ser invisible.
 *
 * Lo medido en prod el 2026-09-07, que es lo que justifica que esto exista:
 *
 *   · **177 comprobantes esperando revisor. 153 fuera del plazo de 3 días.**
 *     14 días de espera promedio, el más viejo de 27, **$7.3 M**.
 *   · **26 personas pueden validar. Tres lo hicieron alguna vez.** Ocho decisiones
 *     en total y **cero rechazos, nunca**.
 *   · **1,199 entradas de los últimos 30 días sin ninguna evidencia** ($57.4 M),
 *     con seis de nueve sucursales en cero.
 *
 * Los dos plazos ya estaban configurados en `finance.receipt_settings`
 * (`sla_capture_days` y `sla_review_days`, ambos en 3) y **ninguno disparaba nada**.
 * El módulo tenía dos crons —apareo de gemelas y watcher de órdenes nuevas— y cero
 * notificación. O sea: el reloj existía y no sonaba.
 *
 * ── Lo que este servicio NO hace, y es lo importante
 *
 * **No crea una bandeja nueva.** La lección está escrita en el servicio hermano
 * (`cash-count-sla.service.ts`, SM.21), que resolvió este mismo problema para los
 * cortes de caja: *"una cola nueva en otro lado es una cola que nadie abre"*. La
 * bandeja ya existe y es la pantalla donde se trabaja — el aviso apunta ahí, con
 * la sucursal ya filtrada.
 *
 * Tampoco inventa el trabajo: una entrada vencida queda marcada como pendiente, no
 * como resuelta.
 *
 * ── Por qué un aviso POR SUCURSAL y no por comprobante
 *
 * El primer barrido encontraría 153 vencidos. 153 avisos no son 153 recordatorios,
 * son ruido, y el destino de una campana con ruido es que se apague. Se manda un
 * resumen por sucursal —*"N esperando · la más vieja de X días · $Y"*— con la
 * sucursal en `data` para que la campana pueda filtrarlo por el alcance de cada
 * quien: sin eso, 25 personas recibirían el aviso de Padre Hidalgo.
 *
 * ── El anti-repetición
 *
 * Vive en memoria, no en tabla. Es a propósito: el aviso es un recordatorio, no un
 * hecho que haya que auditar, y una tabla nueva para esto sería la bandeja que este
 * servicio justamente evita. La contrapartida honesta: **un reinicio de la API
 * vuelve a avisar una vez**. Es aceptable — repetir un recordatorio cuesta menos que
 * perderlo, que es el estado actual.
 */
@Injectable()
export class ReceiptSlaService {
  private readonly logger = new Logger(ReceiptSlaService.name);
  private running = false;

  /**
   * Cada cuánto se repite el aviso de una misma sucursal mientras siga vencida.
   * 12 h: una vez por jornada. Más seguido es acoso; menos, y el que entra en la
   * tarde no se entera hasta el día siguiente.
   */
  private static readonly SILENCIO_MS = 12 * 60 * 60 * 1000;
  private readonly ultimoAviso = new Map<string, number>();

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /**
   * Una vez por hora en horario de oficina. El plazo se mide en DÍAS, así que
   * barrer más seguido no adelanta nada; y de noche no hay a quién avisarle.
   *
   * `timeZone` explícito aunque el contenedor ya esté en México: depender de la
   * TZ del host es la forma de que un cambio de imagen mueva la hora sin que
   * nadie lo note (GOTCHAS §7).
   */
  @Cron('0 15 8-19 * * 1-6', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: barrido previo aún corriendo'); return; }
    await this.scanAllTenants('cron');
  }

  async scanAllTenants(source = 'cron'): Promise<{ tenants: number; revision: number; captura: number; avisos: number }> {
    this.running = true;
    let revision = 0, captura = 0, avisos = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          const r = await this.scanTenant(t.id);
          revision += r.revision; captura += r.captura; avisos += r.avisos;
        } catch (e: any) {
          this.logger.warn(`barrido tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      if (revision || captura) {
        this.logger.log(
          `SLA entradas ${source}: ${revision} comprobante(s) esperando revisor · `
          + `${captura} entrada(s) sin evidencia · ${avisos} aviso(s).`,
        );
      }
      return { tenants: tenants.length, revision, captura, avisos };
    } finally {
      this.running = false;
    }
  }

  /** Barrido del tenant de la request, para el endpoint manual. */
  async scanCurrentTenant(): Promise<ReturnType<ReceiptSlaService['scanTenant']>> {
    return this.scanTenant(this.tenantCtx.requireTenantId());
  }

  async scanTenant(tenantId: string): Promise<{ revision: number; captura: number; avisos: number; detalle: FilaSla[] }> {
    const detalle = await this.tk.run(tenantId, async (trx) => {
      const cfg = await trx('finance.receipt_settings').where({ tenant_id: tenantId }).first();
      const slaRevision = Number(cfg?.sla_review_days ?? 3);
      const slaCaptura = Number(cfg?.sla_capture_days ?? 3);
      const arranque = cfg?.reception_start ?? '2026-08-01';

      const { rows } = await trx.raw(SQL_SLA, {
        tenant: tenantId, sla_revision: slaRevision, sla_captura: slaCaptura, arranque,
      });
      return (rows as FilaSla[]).map((r) => ({
        ...r,
        esperando: Number(r.esperando) || 0,
        sin_evidencia: Number(r.sin_evidencia) || 0,
        dias_peor_revision: Number(r.dias_peor_revision) || 0,
        dias_peor_captura: Number(r.dias_peor_captura) || 0,
        monto_revision: Number(r.monto_revision) || 0,
        monto_captura: Number(r.monto_captura) || 0,
        sla_revision: slaRevision,
        sla_captura: slaCaptura,
      }));
    });

    const revision = detalle.reduce((a, f) => a + f.esperando, 0);
    const captura = detalle.reduce((a, f) => a + f.sin_evidencia, 0);
    // Avisar va FUERA de la transacción y es best-effort: la campana no puede
    // tumbar el barrido, y el barrido sin campana sigue sirviendo para el log.
    const avisos = await this.avisar(tenantId, detalle);
    return { revision, captura, avisos, detalle };
  }

  private async avisar(tenantId: string, filas: FilaSla[]): Promise<number> {
    if (!this.notifier?.notify) return 0;
    let n = 0;
    for (const f of filas) {
      for (const tipo of ['revision', 'captura'] as const) {
        const cuantos = tipo === 'revision' ? f.esperando : f.sin_evidencia;
        if (!cuantos) continue;

        const llave = `${tenantId}:${f.sucursal}:${tipo}`;
        const ahora = Date.now();
        if (ahora - (this.ultimoAviso.get(llave) ?? 0) < ReceiptSlaService.SILENCIO_MS) continue;

        const dias = tipo === 'revision' ? f.dias_peor_revision : f.dias_peor_captura;
        const monto = tipo === 'revision' ? f.monto_revision : f.monto_captura;
        const plazo = tipo === 'revision' ? f.sla_revision : f.sla_captura;
        const suc = f.sucursal_nombre ? `${f.sucursal} ${f.sucursal_nombre}` : f.sucursal;

        await this.notifier.notify(tenantId, {
          key: `entradas_sla_${tipo}`,
          // Tipo propio: esto NO es un aviso de Finanzas. La cola de órdenes de
          // entrada la atiende Compras, y el tipo es por donde la campana decide
          // a quién le llega.
          type: 'entradas_sla',
          // `warn` y no `critical`: es trabajo atrasado, no dinero perdido. Reservar
          // el rojo para lo que de verdad no tiene vuelta atrás es lo que hace que
          // el rojo signifique algo.
          severity: 'warn',
          title: tipo === 'revision'
            ? `${cuantos} remisión(es) esperando revisión en ${suc}`
            : `${cuantos} entrada(s) sin factura en ${suc}`,
          message: tipo === 'revision'
            ? `La más vieja lleva ${dias} día(s) esperando (plazo: ${plazo}). Son ${money(monto)} sin confirmar de quién es el papel ni por cuánto.`
            : `La más vieja lleva ${dias} día(s) sin que nadie suba el papel (plazo: ${plazo}). Son ${money(monto)} recibidos sin comprobante.`,
          // Deep-link con la sucursal YA filtrada: el aviso tiene que terminar en la
          // fila, no en una lista de 4,800 donde hay que volver a buscar.
          route: tipo === 'revision'
            ? `/compras/entradas/control/ordenes?estado=por_validar&warehouse_codes=${encodeURIComponent(f.sucursal)}`
            : `/compras/entradas?warehouse_codes=${encodeURIComponent(f.sucursal)}`,
          // `sucursal` viaja para que la campana filtre por el ALCANCE de cada quien:
          // el permiso de validar lo tienen 25 personas y sólo unas pocas trabajan
          // esta sucursal. Un aviso que le llega a todos no lo atiende nadie.
          data: { sucursal: f.sucursal, tipo, cuantos, dias, monto, plazo },
        }).then(() => { this.ultimoAviso.set(llave, ahora); n++; })
          .catch((e: any) => this.logger.warn(`aviso ${llave} falló: ${e?.message || e}`));
      }
    }
    return n;
  }
}

const money = (n: number) => '$' + Math.round(n).toLocaleString('es-MX');

export interface FilaSla {
  sucursal: string;
  sucursal_nombre: string | null;
  /** Comprobantes en `recibido` con más días que `sla_review_days`. */
  esperando: number;
  dias_peor_revision: number;
  monto_revision: number;
  /** Entradas del carril al día, sin evidencia, con más días que `sla_capture_days`. */
  sin_evidencia: number;
  dias_peor_captura: number;
  monto_captura: number;
  sla_revision: number;
  sla_captura: number;
}

/**
 * Las dos señales en una pasada, agregadas por sucursal.
 *
 * Decisiones que espejan la consulta de la pantalla, para que los números coincidan
 * con lo que alguien ve al hacer clic en el aviso:
 *   · `dup_of_folio IS NULL` — la copia de oficinas no se cuenta dos veces (RE.12).
 *   · las **descartadas** salen: nunca van a tener factura, y dejarlas dentro haría
 *     que una sucursal viva vencida por traspasos que nadie va a facturar (RE.20.3).
 *   · sólo el carril **al día** (`receipt_date >= reception_start`): el rezago
 *     anterior al arranque del proceso no tiene plazo, por definición.
 */
const SQL_SLA = `
WITH ult AS (
  SELECT p.sucursal, p.folio,
         (array_agg(p.status      ORDER BY p.created_at DESC, (p.status = 'recibido') DESC, p.id DESC))[1] AS status,
         (array_agg(p.created_at  ORDER BY p.created_at DESC, (p.status = 'recibido') DESC, p.id DESC))[1] AS created_at,
         (array_agg(p.receipt_monto ORDER BY p.created_at DESC, (p.status = 'recibido') DESC, p.id DESC))[1] AS monto
    FROM finance.goods_receipt_proofs p
   WHERE p.tenant_id = :tenant
   GROUP BY p.sucursal, p.folio
),
base AS (
  SELECT c.sucursal, c.folio, c.receipt_date, c.monto,
         u.status AS proof_status,
         (current_date - (u.created_at AT TIME ZONE 'America/Mexico_City')::date) AS dias_esperando,
         (current_date - LEAST(c.receipt_date, current_date))                     AS dias_desde_entrada
    FROM analytics.erp_goods_receipts c
    LEFT JOIN ult u ON u.sucursal = c.sucursal AND u.folio = c.folio
   WHERE c.tenant_id = :tenant
     AND c.dup_of_folio IS NULL
     AND c.receipt_date >= :arranque
     AND NOT EXISTS (
       SELECT 1 FROM finance.goods_receipt_discards x
        WHERE x.tenant_id = c.tenant_id AND x.sucursal = c.sucursal AND x.folio = c.folio)
)
SELECT b.sucursal,
       w.name AS sucursal_nombre,
       COUNT(*) FILTER (WHERE b.proof_status = 'recibido' AND b.dias_esperando > :sla_revision)::int AS esperando,
       COALESCE(MAX(b.dias_esperando) FILTER (WHERE b.proof_status = 'recibido' AND b.dias_esperando > :sla_revision), 0)::int AS dias_peor_revision,
       COALESCE(SUM(b.monto)          FILTER (WHERE b.proof_status = 'recibido' AND b.dias_esperando > :sla_revision), 0)::numeric AS monto_revision,
       COUNT(*) FILTER (WHERE b.proof_status IS NULL AND b.dias_desde_entrada > :sla_captura)::int AS sin_evidencia,
       COALESCE(MAX(b.dias_desde_entrada) FILTER (WHERE b.proof_status IS NULL AND b.dias_desde_entrada > :sla_captura), 0)::int AS dias_peor_captura,
       COALESCE(SUM(b.monto)              FILTER (WHERE b.proof_status IS NULL AND b.dias_desde_entrada > :sla_captura), 0)::numeric AS monto_captura
  FROM base b
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id = :tenant AND w.deleted_at IS NULL
   AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END) = b.sucursal
 GROUP BY b.sucursal, w.name
HAVING COUNT(*) FILTER (WHERE b.proof_status = 'recibido' AND b.dias_esperando > :sla_revision) > 0
    OR COUNT(*) FILTER (WHERE b.proof_status IS NULL AND b.dias_desde_entrada > :sla_captura) > 0
 ORDER BY 1
`;
