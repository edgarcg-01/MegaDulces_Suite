import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MA.2 — Motor de tareas de conciliación (Maat · ADR-028/016).
 *
 * Toma los hallazgos de retiros sin conciliar (finance.findings, regla
 * banco_retiro_sin_kepler), los AGRUPA por proveedor+periodo y los REPARTE a los
 * usuarios de Finanzas. El humano resuelve EN KEPLER (captura la póliza que
 * falta); esta capa SOLO rastrea — nunca escribe en Kepler.
 *
 *   motor decide (qué falta + a quién) · agente comunica · humano ejecuta en
 *   Kepler · feedback = re-match verifica el cierre. El LLM queda fuera del lazo.
 *
 * Reparto DETERMINISTA: round-robin balanceado por carga abierta (desempate por
 * id de usuario). Manual: el líder reasigna a una persona concreta. Cierre
 * VERIFICADO: cuando el movimiento vuelve a cruzarse (recon_status=matched), la
 * tarea pasa a resuelto sin depender del auto-reporte.
 */

const STATUS = ['pendiente', 'en_proceso', 'resuelto', 'no_aplica'];
const DEFAULT_MIN_IMPORTE = 100000; // "empezar por los grandes" — se baja con el tiempo.

// Ruido bancario a descartar al derivar el proveedor del concepto del estado de cuenta.
const STOP = new Set([
  'spei', 'enviado', 'recibido', 'pago', 'pagos', 'transferencia', 'transf', 'traspaso',
  'deposito', 'retiro', 'cargo', 'abono', 'banco', 'banamex', 'bbva', 'banorte', 'santander',
  'ref', 'folio', 'cie', 'clabe', 'cuenta', 'proveedor', 'factura', 'fact', 'spei', 'interbancaria',
  'liquidacion', 'orden', 'mxn', 'com', 'iva', 'nomina',
]);

@Injectable()
export class MaatReconTasksService {
  private readonly logger = new Logger(MaatReconTasksService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private n(v: any): number { return Number(v || 0); }

  /** Deriva una clave estable de proveedor desde el concepto bancario (best-effort). */
  private proveedorKey(concept?: string): { key: string; label: string } {
    const raw = (concept || '').trim();
    const clean = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const tokens = clean.split(/[^A-Z0-9]+/).filter(Boolean)
      .filter((t) => !/^\d+$/.test(t))     // fuera refs/montos
      .filter((t) => t.length >= 3)
      .filter((t) => !STOP.has(t.toLowerCase()));
    const key = tokens.slice(0, 4).map((t) => t.toLowerCase()).sort().join('_');
    const label = raw ? raw.slice(0, 70) : (tokens.slice(0, 4).join(' ') || 'Sin concepto');
    return { key, label };
  }

  // ── MOTOR: construir tareas + repartir ──────────────────────────────────

  /**
   * Construye/actualiza tareas desde los hallazgos banco_retiro_sin_kepler del
   * periodo, agrupando por proveedor. UPSERT idempotente; solo movimientos que
   * SIGUEN sin conciliar (recon_status=unmatched). No re-abre tareas cerradas ni
   * pisa la asignación existente. `minImporte` filtra por total del grupo (grandes primero).
   */
  async buildTasks(period: string, minImporte = DEFAULT_MIN_IMPORTE) {
    this.tenantCtx.requireTenantId();
    if (!period) throw new BadRequestException('period requerido (YYYY-MM)');
    return this.tk.run(async (trx) => {
      const rows: any[] = await trx('finance.findings as f')
        .joinRaw("JOIN finance.bank_movements bm ON bm.id = NULLIF(f.entity->>'bank_movement_id','')::uuid")
        .where('f.rule_key', 'banco_retiro_sin_kepler')
        .where('f.periodo', period)
        .whereIn('f.status', ['nuevo', 'en_revision'])
        .where('bm.recon_status', 'unmatched')
        .select('f.id as finding_id', trx.raw('f.importe::numeric AS importe'),
          trx.raw("COALESCE(f.evidencia->>'concept','') AS concept"));

      // Agrupar por proveedor. Sin concepto → grupo propio por finding (degrada bien).
      const groups = new Map<string, { key: string; label: string; ids: string[]; importe: number }>();
      for (const r of rows) {
        let { key, label } = this.proveedorKey(r.concept);
        if (!key) { key = `mov_${r.finding_id}`; }
        const g = groups.get(key) || { key, label, ids: [], importe: 0 };
        g.ids.push(r.finding_id);
        g.importe += this.n(r.importe);
        if (!g.label && label) g.label = label;
        groups.set(key, g);
      }

      let upserted = 0, skippedSmall = 0;
      for (const g of groups.values()) {
        if (g.importe < minImporte) { skippedSmall++; continue; }
        const res = await trx.raw(
          `INSERT INTO finance.recon_tasks
             (tenant_id, rule_key, periodo, group_key, proveedor_label, finding_ids, n_movimientos, importe_total, created_at, updated_at)
           VALUES (public.current_tenant_id(), 'banco_retiro_sin_kepler', ?, ?, ?, ?::jsonb, ?, ?, now(), now())
           ON CONFLICT (tenant_id, rule_key, periodo, group_key) DO UPDATE
             SET finding_ids = EXCLUDED.finding_ids, n_movimientos = EXCLUDED.n_movimientos,
                 importe_total = EXCLUDED.importe_total, proveedor_label = EXCLUDED.proveedor_label,
                 updated_at = now()
             WHERE finance.recon_tasks.status IN ('pendiente','en_proceso')
           RETURNING (xmax = 0) AS is_insert`,
          [period, g.key, g.label, JSON.stringify(g.ids), g.ids.length, g.importe.toFixed(2)],
        );
        if (res.rows?.length) upserted++;
      }
      this.logger.log(`buildTasks ${period}: ${groups.size} grupos, ${upserted} tareas upsertadas (≥${minImporte}), ${skippedSmall} chicas omitidas.`);
      return { periodo: period, grupos: groups.size, upserted, skipped_small: skippedSmall, min_importe: minImporte };
    });
  }

  /** Usuarios de Finanzas candidatos (los que pueden resolver: FINANCE_BANK_GESTIONAR). */
  async financeUsers(): Promise<{ id: string; username: string; full_name: string | null }[]> {
    return this.tk.run(async (trx) =>
      trx('users as u')
        .join('role_permissions as rp', function (this: any) {
          this.on('rp.role_name', 'u.role_name').andOn('rp.tenant_id', 'u.tenant_id');
        })
        .where('u.activo', true)
        .whereNot('u.role_name', 'customer_b2b')
        .whereRaw(`COALESCE((rp.permissions->>'FINANCE_BANK_GESTIONAR')::boolean, false) = true`)
        .select('u.id', 'u.username', trx.raw('u.nombre AS full_name'))
        .orderBy('u.id'),
    );
  }

  /**
   * Reparto automático: asigna las tareas pendientes sin dueño a los usuarios de
   * Finanzas por round-robin balanceado (al de menor carga abierta). Determinista.
   * Idempotente (solo toma las que no tienen assigned_to).
   */
  async assignPending(period?: string) {
    this.tenantCtx.requireTenantId();
    const users = await this.financeUsers();
    if (!users.length) { this.logger.warn('assignPending: no hay usuarios de Finanzas — quedan en el pool.'); return { assigned: 0, users: 0 }; }

    return this.tk.run(async (trx) => {
      // Carga abierta actual por usuario.
      const load = new Map<string, number>(users.map((u) => [u.id, 0]));
      const openRows = await trx('finance.recon_tasks')
        .whereIn('status', ['pendiente', 'en_proceso']).whereNotNull('assigned_to').select('assigned_to');
      for (const r of openRows as any[]) if (load.has(r.assigned_to)) load.set(r.assigned_to, (load.get(r.assigned_to) || 0) + 1);

      const q = trx('finance.recon_tasks').where('status', 'pendiente').whereNull('assigned_to');
      if (period) q.where('periodo', period);
      const tasks = await q.orderBy('importe_total', 'desc').select('id');

      let assigned = 0;
      for (const t of tasks as any[]) {
        const pick = [...users].sort((a, b) => (load.get(a.id)! - load.get(b.id)!) || (a.id < b.id ? -1 : 1))[0];
        await trx('finance.recon_tasks').where('id', t.id).update({
          assigned_to: pick.id, assigned_to_username: pick.username || pick.full_name || null,
          assigned_by: 'maat', assigned_at: trx.fn.now(), updated_at: trx.fn.now(),
        });
        load.set(pick.id, (load.get(pick.id) || 0) + 1);
        assigned++;
      }
      this.logger.log(`assignPending${period ? ` ${period}` : ''}: ${assigned} tareas repartidas entre ${users.length} usuarios.`);
      return { assigned, users: users.length };
    });
  }

  /** Orquestación: construir → verificar cierre → repartir. Entrada del cron/endpoint. */
  async run(period: string, minImporte = DEFAULT_MIN_IMPORTE) {
    const build = await this.buildTasks(period, minImporte);
    const closed = await this.verifyClosure(period);
    const assign = await this.assignPending(period);
    return { ...build, ...assign, cerradas_verificadas: closed.closed };
  }

  // ── CICLO DE VIDA ────────────────────────────────────────────────────────

  /**
   * Cierre VERIFICADO: una tarea activa cuyos movimientos YA cruzaron en Kepler
   * (recon_status=matched) pasa a resuelto (source=verificado). No confía en el
   * auto-reporte: comprueba el re-match real.
   */
  async verifyClosure(period?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = trx('finance.recon_tasks').whereIn('status', ['pendiente', 'en_proceso']);
      if (period) q.where('periodo', period);
      const tasks = await q.select('id', 'finding_ids');
      let closed = 0;
      for (const t of tasks as any[]) {
        const ids: string[] = Array.isArray(t.finding_ids) ? t.finding_ids : JSON.parse(t.finding_ids || '[]');
        if (!ids.length) continue;
        // ¿cuántos de los movimientos de esta tarea siguen sin conciliar?
        const pend: any = await trx('finance.findings as f')
          .joinRaw("JOIN finance.bank_movements bm ON bm.id = NULLIF(f.entity->>'bank_movement_id','')::uuid")
          .whereIn('f.id', ids).where('bm.recon_status', 'unmatched')
          .count('* as c').first();
        if (Number(pend?.c || 0) === 0) {
          await trx('finance.recon_tasks').where('id', t.id).update({
            status: 'resuelto', resolution_source: 'verificado', resolved_at: trx.fn.now(),
            resolved_by: 'maat', updated_at: trx.fn.now(),
          });
          closed++;
        }
      }
      if (closed) this.logger.log(`verifyClosure${period ? ` ${period}` : ''}: ${closed} tareas cerradas por re-match.`);
      return { closed };
    });
  }

  /** Cambia el estado (en_proceso / resuelto / no_aplica) — auto-reporte del asignado. */
  async setStatus(id: string, status: string, opts: { note?: string; kepler_ref?: string; actor?: string } = {}) {
    this.tenantCtx.requireTenantId();
    if (!STATUS.includes(status)) throw new BadRequestException(`status inválido (${STATUS.join('|')})`);
    return this.tk.run(async (trx) => {
      const patch: any = { status, updated_at: trx.fn.now() };
      if (opts.note !== undefined) patch.resolution_note = opts.note;
      if (opts.kepler_ref !== undefined) patch.kepler_ref = opts.kepler_ref;
      if (status === 'resuelto' || status === 'no_aplica') {
        patch.resolved_at = trx.fn.now(); patch.resolved_by = opts.actor || null; patch.resolution_source = 'manual';
      } else {
        patch.resolved_at = null; patch.resolved_by = null; patch.resolution_source = null;
      }
      const [row] = await trx('finance.recon_tasks').where('id', id).update(patch)
        .returning(['id', 'status', 'resolution_source']);
      if (!row) throw new BadRequestException('tarea no encontrada');
      this.logger.log(`recon_task ${id} → ${status}${opts.actor ? ` por ${opts.actor}` : ''}`);
      return row;
    });
  }

  /** Asignación/reasignación MANUAL (líder). userId null = devolver al pool. */
  async assignManual(id: string, userId: string | null, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let username: string | null = null;
      if (userId) {
        const u = await trx('users').where('id', userId).where('activo', true).select('username', 'nombre').first();
        if (!u) throw new BadRequestException('usuario no encontrado o inactivo');
        username = u.username || u.nombre || null;
      }
      const [row] = await trx('finance.recon_tasks').where('id', id).update({
        assigned_to: userId, assigned_to_username: username,
        assigned_by: actor || 'manual', assigned_at: userId ? trx.fn.now() : null, updated_at: trx.fn.now(),
      }).returning(['id', 'assigned_to', 'assigned_to_username']);
      if (!row) throw new BadRequestException('tarea no encontrada');
      return row;
    });
  }

  // ── LECTURA ────────────────────────────────────────────────────────────

  /** Bandeja de tareas. scope='me' filtra por el usuario actual; 'pool' = sin asignar. */
  async list(q: { scope?: 'me' | 'all' | 'pool'; userId?: string; status?: string; periodo?: string; limit?: number }) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return this.tk.run(async (trx) => {
      const b = trx('finance.recon_tasks')
        .select('id', 'rule_key', 'periodo', 'group_key', 'proveedor_label', 'finding_ids',
          'n_movimientos', trx.raw('importe_total::numeric AS importe_total'),
          'assigned_to', 'assigned_to_username', 'assigned_by', 'assigned_at',
          'status', 'due_at', 'resolved_at', 'resolved_by', 'resolution_note', 'resolution_source', 'kepler_ref',
          'created_at', 'updated_at')
        .orderBy('status').orderBy('importe_total', 'desc').limit(limit);
      if (q.scope === 'me' && q.userId) b.where('assigned_to', q.userId);
      else if (q.scope === 'pool') b.whereNull('assigned_to');
      if (q.status) b.where('status', q.status);
      else b.whereIn('status', ['pendiente', 'en_proceso']);
      if (q.periodo) b.where('periodo', q.periodo);
      const rows = await b;
      return rows.map((r: any) => ({ ...r, importe_total: Number(r.importe_total), finding_ids: Array.isArray(r.finding_ids) ? r.finding_ids : JSON.parse(r.finding_ids || '[]') }));
    });
  }

  /** KPIs de la bandeja de tareas + carga por usuario de Finanzas. */
  async stats(period?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = () => {
        const x = trx('finance.recon_tasks');
        if (period) x.where('periodo', period);
        return x;
      };
      const totals: any = await base().select(
        trx.raw("COUNT(*) FILTER (WHERE status='pendiente')::int AS pendientes"),
        trx.raw("COUNT(*) FILTER (WHERE status='en_proceso')::int AS en_proceso"),
        trx.raw("COUNT(*) FILTER (WHERE status='resuelto')::int AS resueltas"),
        trx.raw("COUNT(*) FILTER (WHERE assigned_to IS NULL AND status IN ('pendiente','en_proceso'))::int AS pool"),
        trx.raw("ROUND(SUM(importe_total) FILTER (WHERE status IN ('pendiente','en_proceso'))::numeric,2) AS monto_abierto"),
      ).first();
      const porUsuario = await base().whereIn('status', ['pendiente', 'en_proceso']).whereNotNull('assigned_to')
        .groupBy('assigned_to', 'assigned_to_username')
        .select('assigned_to', 'assigned_to_username',
          trx.raw('COUNT(*)::int AS n'), trx.raw('ROUND(SUM(importe_total)::numeric,2) AS monto'))
        .orderByRaw('COUNT(*) DESC');
      return {
        pendientes: Number(totals?.pendientes || 0),
        en_proceso: Number(totals?.en_proceso || 0),
        resueltas: Number(totals?.resueltas || 0),
        pool: Number(totals?.pool || 0),
        monto_abierto: Number(totals?.monto_abierto || 0),
        por_usuario: (porUsuario as any[]).map((u) => ({ user_id: u.assigned_to, username: u.assigned_to_username, n: Number(u.n), monto: Number(u.monto) })),
      };
    });
  }
}
