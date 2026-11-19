import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  TenantKnexService, TenantContextService, ScopeService, isPlatformAdminRole, permisoEfectivoSql,
} from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT, FinanceNotifierPort, warehouseName } from '@megadulces/contracts';
import type { AvisoSucursal, DevueltaFila, DevueltasResumen } from '@megadulces/contracts';

/**
 * `[RE.83]` — **Una factura devuelta le llega a quien la tiene que volver a subir.**
 *
 * Edgar, 2026-11-19: «cada que se devuelve hay que notificar a los usuarios que pueden subir de cada
 * sucursal, y también un botón para notificar manualmente a esas sucursales».
 *
 * Hasta acá devolver sólo cambiaba el estado de la evidencia: la sucursal no se enteraba, y en la
 * pantalla ni siquiera había una bandeja donde encontrar lo devuelto.
 *
 * ── A quién ──────────────────────────────────────────────────────────────────────────────────
 * Quien puede SUBIR en esa sucursal: llave efectiva `COMPRAS_ENTRADAS_GESTIONAR` (rol, complementos y
 * ajuste por persona — `permisoEfectivoSql`) **y** alcance de ESCRITURA sobre la sucursal (el mismo
 * `ScopeService.canWrite` con el que `attach` decide si deja subir). Sin el god-mode: el superadmin puede
 * capturar en todas, y un aviso a los ocho por cada devolución es ruido que nadie atiende.
 *
 * ── Por qué no se pierde ─────────────────────────────────────────────────────────────────────
 * El aviso en vivo (WebSocket, al cuarto de cada persona) sólo le llega a quien tiene la Suite abierta.
 * Lo que no se pierde es la **devuelta misma**: la campana lee `devueltasMias()` por poll — la lista
 * de lo devuelto que sigue sin papel nuevo — igual que lee las requisiciones por aprobar (`[PQ.35]`).
 * No hay tabla de avisos ni cron: la fuente es el estado de la evidencia.
 *
 * ── El aviso manual ──────────────────────────────────────────────────────────────────────────
 * Deja una fila por devuelta en `finance.goods_receipt_proof_history` (`status_to = 'aviso_sucursal'`):
 * queda en la cadena de la entrada quién avisó y cuándo, y la campana lo vuelve a mostrar como nuevo
 * (su llave es la devuelta + la hora del último aviso). Devuelve a cuántas personas les llega: un aviso
 * que no le llega a nadie se DICE, no se da por enviado.
 */
const GESTIONAR = 'COMPRAS_ENTRADAS_GESTIONAR';
/** Lo que la campana trae de una vez. La cuenta (`n`) va aparte y es la de verdad. */
const TOPE_RECIENTES = 30;

@Injectable()
export class ReceiptDevueltasService {
  private readonly logger = new Logger(ReceiptDevueltasService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /**
   * Devueltas que siguen esperando papel nuevo: la ÚLTIMA evidencia de la entrada está rechazada (si
   * la sucursal ya subió otra, deja de estar devuelta) y la entrada no se descartó. `sucursales = null`
   * es sin filtro.
   */
  private async devueltas(trx: Knex.Transaction, sucursales: string[] | null, tope: number | null = TOPE_RECIENTES): Promise<{ n: number; filas: DevueltaFila[] }> {
    if (sucursales && !sucursales.length) return { n: 0, filas: [] };
    const hayDescartes = await this.existeTabla(trx, 'goods_receipt_discards');
    const hayHistorial = await this.existeTabla(trx, 'goods_receipt_proof_history');
    const binds: unknown[] = [];
    const filtroSuc = sucursales ? (binds.push(sucursales), 'AND p.sucursal = ANY(?)') : '';
    const sinDescarte = hayDescartes
      ? `AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_discards x
           WHERE x.tenant_id = p.tenant_id AND x.sucursal = p.sucursal AND x.folio = p.folio)`
      : '';
    const ultimoAviso = hayHistorial
      ? `(SELECT max(h.changed_at) FROM finance.goods_receipt_proof_history h
           WHERE h.tenant_id = p.tenant_id AND h.proof_id = p.id AND h.status_to = 'aviso_sucursal')`
      : 'NULL::timestamptz';
    const { rows } = await trx.raw(`
      SELECT p.id AS proof_id, p.sucursal, p.folio, p.proveedor_nombre AS proveedor,
             p.receipt_monto::numeric AS monto, p.motivo_rechazo AS motivo, p.motivo_codigo,
             p.validated_by AS devuelta_por, p.validated_at AS devuelta_at,
             GREATEST(p.validated_at, ${ultimoAviso}) AS aviso_at,
             count(*) OVER () AS n
        FROM finance.goods_receipt_proofs p
       WHERE p.tenant_id = public.current_tenant_id()
         AND p.status = 'rechazado'
         ${filtroSuc}
         AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_proofs q
              WHERE q.tenant_id = p.tenant_id AND q.sucursal = p.sucursal AND q.folio = p.folio
                AND q.id <> p.id AND q.created_at >= p.created_at)
         ${sinDescarte}
       ORDER BY aviso_at DESC NULLS LAST
       ${tope ? `LIMIT ${Number(tope)}` : ''}`, binds);
    const filas = (rows as any[]).map((r) => ({
      proof_id: r.proof_id, sucursal: r.sucursal, sucursal_nombre: warehouseName(r.sucursal), folio: r.folio,
      proveedor: r.proveedor ?? null, monto: r.monto == null ? null : Number(r.monto),
      motivo: r.motivo ?? null, motivo_codigo: r.motivo_codigo ?? null, devuelta_por: r.devuelta_por ?? null,
      devuelta_at: new Date(r.devuelta_at).toISOString(),
      aviso_at: new Date(r.aviso_at ?? r.devuelta_at).toISOString(),
    }));
    return { n: rows.length ? Number((rows as any[])[0].n) : 0, filas };
  }

  /**
   * Para la campana: las devueltas de las sucursales donde quien pregunta puede SUBIR. Quien sube en
   * TODAS (oficina) no es «de la sucursal»: responde `de_sucursal: false` y la campana no lo muestra —
   * la bandeja «Devueltas» sigue a su alcance.
   */
  async devueltasMias(): Promise<DevueltasResumen> {
    const s = await this.scope.current();
    if (s.dims.warehouse.modeWrite === 'all') return { n: 0, recientes: [], de_sucursal: false };
    const donde = this.scope.intersectWrite(s, 'warehouse', null);
    return this.tk.run(async (trx) => {
      const { n, filas } = await this.devueltas(trx, donde);
      return { n, recientes: filas, de_sucursal: true };
    });
  }

  /**
   * Quién puede subir en cada sucursal pedida: llave efectiva + alcance de escritura. Fuera el god-mode
   * y quien escribe en TODAS: medido en prod (2026-11-19), 12 puestos de oficina (compras, finanzas,
   * tesorería, marketing…) tienen la llave con escritura `all`; con ellos, cada devolución le llegaría a
   * ~20 personas de oficina. Lo pedido es avisar a la gente DE la sucursal.
   */
  private async capturistas(tenantId: string, sucursales: string[]): Promise<Map<string, string[]>> {
    const efectivo = permisoEfectivoSql('u');
    const candidatos: { id: string; username: string; role_name: string | null }[] = await this.tk.run(tenantId, (trx) =>
      trx('identity.users as u')
        .where('u.activo', true).whereNull('u.deleted_at')
        .whereRaw(efectivo, [GESTIONAR, GESTIONAR])
        .select('u.id', 'u.username', 'u.role_name'));
    const porSucursal = new Map<string, string[]>(sucursales.map((x) => [x, []]));
    for (const c of candidatos) {
      if (!c.username || isPlatformAdminRole(c.role_name)) continue;
      const alcance = await this.scope.forUser(tenantId, c.id, c.role_name ?? undefined);
      if (alcance.dims.warehouse.modeWrite === 'all') continue;
      for (const suc of sucursales) {
        if (this.scope.canWrite(alcance, 'warehouse', suc)) porSucursal.get(suc)!.push(c.username);
      }
    }
    return porSucursal;
  }

  /** Empuja el aviso al cuarto de cada capturista. Best-effort: nunca tumba la operación que lo pidió. */
  private async empujar(tenantId: string, suc: string, usuarios: string[], titulo: string, mensaje: string): Promise<void> {
    if (!this.notifier?.notify) return;
    const route = `/compras/revision-facturas?bandeja=devueltas&suc=${encodeURIComponent(suc)}`;
    for (const u of usuarios) {
      await this.notifier.notify(tenantId, {
        key: 'entradas_devuelta', type: 'entradas_devuelta', severity: 'warn',
        title: titulo, message: mensaje, route, para_usuario: u, data: { sucursal: suc, tipo: 'captura' },
      }).catch((e: unknown) => this.logger.warn(`aviso de devuelta a ${u} falló: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  /**
   * Después de devolver (la transacción ya confirmó): avisa a quien puede subir en esa sucursal.
   * Devuelve a cuántas personas les llega; nunca lanza.
   */
  async alDevolver(proofId: string): Promise<{ destinatarios: number | null }> {
    try {
      const tenantId = this.tenantCtx.requireTenantId();
      const p = await this.tk.run(tenantId, (trx) => trx('finance.goods_receipt_proofs').where({ id: proofId })
        .first('sucursal', 'folio', 'proveedor_nombre', 'motivo_rechazo'));
      if (!p) return { destinatarios: null };
      const usuarios = (await this.capturistas(tenantId, [p.sucursal])).get(p.sucursal) ?? [];
      await this.empujar(tenantId, p.sucursal, usuarios,
        `Factura devuelta · ${warehouseName(p.sucursal)} · entrada ${p.folio}`,
        `${p.proveedor_nombre ?? 'Proveedor sin nombre'}${p.motivo_rechazo ? ` · ${p.motivo_rechazo}` : ''}. Sube el papel correcto.`);
      return { destinatarios: usuarios.length };
    } catch (e) {
      this.logger.warn(`[RE.83] el aviso de la devuelta ${proofId} no salió: ${e instanceof Error ? e.message : String(e)}`);
      return { destinatarios: null };
    }
  }

  /**
   * El botón «Avisar a la sucursal»: recuerda TODAS sus devueltas pendientes. Sólo sobre sucursales
   * del alcance de escritura de quien avisa (el mismo que le deja devolver).
   */
  async avisarSucursales(pedidas: string[], actor?: string): Promise<AvisoSucursal[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const limpias = [...new Set((pedidas || []).map((x) => String(x).trim()).filter(Boolean))];
    if (!limpias.length) throw new BadRequestException('di a qué sucursal avisar');
    if (limpias.length > 20) throw new BadRequestException('demasiadas sucursales en un aviso');
    for (const suc of limpias) await this.scope.assertCanWrite('warehouse', suc);

    const porSuc = await this.tk.run(tenantId, async (trx) => {
      if (!(await this.existeTabla(trx, 'goods_receipt_proof_history'))) {
        throw new BadRequestException('falta el historial de evidencias: el aviso no tendría dónde quedar escrito');
      }
      const out = new Map<string, DevueltaFila[]>();
      for (const suc of limpias) {
        // Todas, no sólo las 30 de la campana: el aviso es de la sucursal entera.
        const { filas } = await this.devueltas(trx, [suc], null);
        out.set(suc, filas);
        if (filas.length) {
          await trx('finance.goods_receipt_proof_history').insert(filas.map((f) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            proof_id: f.proof_id, sucursal: f.sucursal, folio: f.folio,
            status_from: 'rechazado', status_to: 'aviso_sucursal',
            motivo: 'Aviso a la sucursal: la factura sigue devuelta', changed_by: actor ?? null,
          })));
        }
      }
      return out;
    });

    const quienes = await this.capturistas(tenantId, limpias);
    const res: AvisoSucursal[] = [];
    for (const suc of limpias) {
      const filas = porSuc.get(suc) ?? [];
      const usuarios = quienes.get(suc) ?? [];
      if (filas.length && usuarios.length) {
        await this.empujar(tenantId, suc, usuarios,
          `${filas.length} factura(s) devuelta(s) en ${warehouseName(suc)}`,
          `${actor ? actor + ' te recuerda' : 'Recordatorio'}: siguen esperando el papel correcto. La más vieja es la entrada ${filas[filas.length - 1].folio}.`);
      }
      res.push({ sucursal: suc, sucursal_nombre: warehouseName(suc), devueltas: filas.length, destinatarios: usuarios.length });
    }
    this.logger.log(`[RE.83] aviso manual por ${actor ?? '?'}: ${res.map((r) => `${r.sucursal_nombre} ${r.devueltas} devuelta(s) → ${r.destinatarios} persona(s)`).join(' · ')}`);
    return res;
  }

  private async existeTabla(trx: Knex.Transaction, tabla: string): Promise<boolean> {
    const { rows } = await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS ok`, [`finance.${tabla}`]);
    return !!rows[0]?.ok;
  }
}
