import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { EmissionErrorKind } from './emission-errors.service';
import { SAT_ERROR_CATALOG, SatErrorSolution, resolveSolution } from './sat-error-catalog';

export interface HealthCheck {
  key: string;
  status: 'ok' | 'warn' | 'critical';
  titulo: string;
  detalle: string;
  solucion?: string;
  deep_link?: string;
  fix_label?: string;
}

const LIST_COLS = [
  'id', 'kind', 'dedup_key', 'status', 'order_id', 'cfdi_uuid', 'receptor_rfc', 'receptor_nombre',
  'serie', 'folio', 'total', 'num_parcialidad', 'http_status', 'pac_provider', 'pac_code',
  'error_message', 'error_detail', 'attempts', 'first_seen_at', 'last_seen_at', 'resolved_at',
];

export interface DiagnosticRow {
  id: string; kind: EmissionErrorKind; status: string;
  order_id: string | null; cfdi_uuid: string | null;
  receptor_rfc: string | null; receptor_nombre: string | null;
  serie: string | null; folio: string | null; total: string | number | null;
  http_status: number | null; pac_code: string | null;
  error_message: string | null; error_detail: string | null;
  attempts: number; first_seen_at: string; last_seen_at: string;
  solucion: SatErrorSolution;
  can_retry_order: boolean;
}

/**
 * FD.2 — Servicio del tablero de Diagnóstico de facturación. Lee los errores de
 * emisión capturados (fiscal.emission_errors) y enriquece cada uno con la base de
 * conocimiento SAT/PAC (FD.1): qué pasó, por qué y cómo se arregla. NO llama al PAC
 * ni escribe comprobantes: solo lee + traduce + permite descartar.
 */
@Injectable()
export class EmissionDiagnosticsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(f: { status?: 'open' | 'resolved' | 'all'; kind?: EmissionErrorKind; limit?: number }): Promise<DiagnosticRow[]> {
    const status = f.status || 'open';
    const limit = Math.min(Number(f.limit) || 200, 500);
    const rows = await this.tk.run((trx) =>
      trx('fiscal.emission_errors')
        .select(LIST_COLS)
        .modify((b: any) => {
          if (status !== 'all') b.where('status', status);
          if (f.kind) b.where('kind', f.kind);
        })
        .orderByRaw(`(status = 'open') desc`)
        .orderBy('last_seen_at', 'desc')
        .limit(limit),
    );
    return rows.map((r: any) => this.enrich(r));
  }

  /** Detalle completo (incluye el sobre crudo del PAC) para el panel técnico. */
  async detail(id: string): Promise<DiagnosticRow & { pac_raw: unknown }> {
    const row = await this.tk.run((trx) =>
      trx('fiscal.emission_errors').where({ id }).first());
    if (!row) throw new NotFoundException('Error no encontrado.');
    return { ...this.enrich(row), pac_raw: row.pac_raw };
  }

  async stats(): Promise<{
    open_total: number; criticos: number;
    por_tipo: { kind: EmissionErrorKind; count: number }[];
    por_severidad: { severity: string; count: number }[];
  }> {
    const rows = await this.tk.run((trx) =>
      trx('fiscal.emission_errors').select('kind', 'pac_code', 'error_message', 'error_detail').where('status', 'open'));
    const byKind = new Map<string, number>();
    const bySev = new Map<string, number>();
    let criticos = 0;
    for (const r of rows) {
      byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
      const sol = resolveSolution({ code: r.pac_code, message: r.error_message, detail: r.error_detail, kind: r.kind });
      const sev = sol.severity || 'warn';
      bySev.set(sev, (bySev.get(sev) || 0) + 1);
      if (sev === 'critical') criticos++;
    }
    return {
      open_total: rows.length,
      criticos,
      por_tipo: [...byKind.entries()].map(([kind, count]) => ({ kind: kind as EmissionErrorKind, count })),
      por_severidad: [...bySev.entries()].map(([severity, count]) => ({ severity, count })),
    };
  }

  /** Catálogo de conocimiento (referencia consultable en el tablero). */
  catalog(): SatErrorSolution[] {
    return SAT_ERROR_CATALOG;
  }

  /** Descartar manualmente (el usuario ya lo atendió o no aplica). */
  async dismiss(id: string): Promise<{ id: string; status: string }> {
    const n = await this.tk.run((trx) =>
      trx('fiscal.emission_errors').where({ id }).update({ status: 'resolved', resolved_at: trx.fn.now(), updated_at: trx.fn.now() }));
    if (!n) throw new NotFoundException('Error no encontrado.');
    return { id, status: 'resolved' };
  }

  /**
   * FD.3 — Revisión preventiva (on-demand, sin cron): detecta problemas de
   * configuración que causarían errores ANTES de intentar facturar. Cada check trae
   * su solución + deep-link. Todo es defensivo: una fuente ausente no rompe.
   */
  async health(): Promise<HealthCheck[]> {
    const tid = this.tenantCtx.requireTenantId();
    const checks: HealthCheck[] = [];
    await this.tk.run(async (trx) => {
      // 1) Emisor configurado (sin esto NO se puede timbrar nada)
      const [{ count: issuers }] = await trx('fiscal.issuer_config').where('active', true).count<{ count: string }[]>('* as count');
      if (Number(issuers) === 0) {
        checks.push({
          key: 'emisor', status: 'critical', titulo: 'Sin emisor configurado',
          detalle: 'No hay datos fiscales del emisor. No se puede timbrar ninguna factura.',
          solucion: 'Configura el emisor (RFC, razón social, régimen, CP) en Facturación → Emisor.',
          deep_link: '/contabilidad/facturar', fix_label: 'Configurar emisor',
        });
      } else {
        checks.push({ key: 'emisor', status: 'ok', titulo: 'Emisor configurado', detalle: `${issuers} emisor(es) activo(s).` });
      }

      // 2) e.firma / CSD por vencer o vencida (fuente de descarga masiva + contabilidad e.)
      let creds: any[] = [];
      try { creds = await trx('fiscal.sat_credentials').where('active', true).select('rfc', 'cer_valid_to'); } catch { creds = []; }
      const now = Date.now(); const in30 = now + 30 * 864e5;
      const ts = (d: any) => (d ? new Date(d).getTime() : NaN);
      const expired = creds.filter((c) => ts(c.cer_valid_to) && ts(c.cer_valid_to) < now);
      const expiring = creds.filter((c) => ts(c.cer_valid_to) >= now && ts(c.cer_valid_to) < in30);
      if (expired.length) {
        checks.push({
          key: 'efirma', status: 'critical', titulo: 'e.firma / CSD vencida',
          detalle: `${expired.length} credencial(es) vencida(s): ${expired.map((c) => c.rfc).join(', ')}.`,
          solucion: 'Renueva la e.firma/CSD en el SAT y actualízala en Credenciales.',
          deep_link: '/contabilidad/credenciales', fix_label: 'Ir a e.firma',
        });
      } else if (expiring.length) {
        checks.push({
          key: 'efirma', status: 'warn', titulo: 'e.firma / CSD por vencer',
          detalle: `${expiring.length} credencial(es) vence(n) en menos de 30 días.`,
          solucion: 'Renueva antes del vencimiento para no interrumpir descargas ni contabilidad electrónica.',
          deep_link: '/contabilidad/credenciales', fix_label: 'Ir a e.firma',
        });
      }

      // 3) Cobertura del código agrupador SAT (catálogo XML válido)
      try {
        const r = await trx.raw(
          `WITH mayores AS (
             SELECT DISTINCT cuenta_mayor FROM analytics.ledger_monthly
              WHERE tenant_id = :tid AND cuenta_mayor IS NOT NULL AND btrim(cuenta_mayor) <> '')
           SELECT count(*)::int AS total, count(m.cuenta_mayor)::int AS mapped
             FROM mayores x
             LEFT JOIN fiscal.cod_agrupador_map m ON m.cuenta_mayor = x.cuenta_mayor AND m.tenant_id = :tid`,
          { tid },
        );
        const total = Number(r.rows?.[0]?.total || 0);
        const mapped = Number(r.rows?.[0]?.mapped || 0);
        const unmapped = total - mapped;
        if (total > 0 && unmapped > 0) {
          checks.push({
            key: 'cod_agrupador', status: 'warn', titulo: 'Cuentas sin código agrupador SAT',
            detalle: `${unmapped}/${total} cuentas mayor sin mapear → el catálogo de cuentas XML saldría inválido.`,
            solucion: 'Mapea las cuentas faltantes en Contabilidad electrónica (usa “Auto-sugerir” y revisa).',
            deep_link: '/contabilidad/contabilidad', fix_label: 'Ir a contabilidad e.',
          });
        }
      } catch { /* analytics.ledger_monthly puede no existir aún: no rompe */ }
    });
    return checks;
  }

  private enrich(r: any): DiagnosticRow {
    const solucion = resolveSolution({ code: r.pac_code, message: r.error_message, detail: r.error_detail, kind: r.kind });
    return {
      id: r.id, kind: r.kind, status: r.status,
      order_id: r.order_id ?? null, cfdi_uuid: r.cfdi_uuid ?? null,
      receptor_rfc: r.receptor_rfc ?? null, receptor_nombre: r.receptor_nombre ?? null,
      serie: r.serie ?? null, folio: r.folio ?? null, total: r.total ?? null,
      http_status: r.http_status ?? null, pac_code: r.pac_code ?? null,
      error_message: r.error_message ?? null, error_detail: r.error_detail ?? null,
      attempts: Number(r.attempts) || 1, first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
      solucion,
      // El reintento automático solo aplica al timbrado ligado a un pedido (reusa
      // el retry idempotente de Comercial). El resto se corrige desde su pantalla.
      can_retry_order: r.kind === 'timbrado' && !!r.order_id,
    };
  }
}
