import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PA.3 — Tablero de asignación de equipos POR FOLIO (staffing por pasillo).
 *
 * Sobre el LAYOUT de pasillos (PA.1, `warehouse_aisles`), para UN folio pone
 * 1 supervisor + un equipo de contadores en cada pasillo. Se persiste en
 * `inventory_count_assignments` con `aisle_id` (filas aisle-scoped). Regenerable.
 *
 * Generador "parejo" (decisión del usuario 2026-06-19, override del proporcional
 * de ADR-024): contadores ÷ pasillos, el resto de a 1 → equipos difieren máx. 1.
 * NO toca el flujo de conteo (eso es PA.4). Separado de warehouse-aisles.service
 * (ese es el layout permanente; esto es el tablero por folio).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GenerateTeamsDto {
  supervisor_ids?: string[];
  counter_ids?: string[];
  /** Pasillos a cubrir; vacío = todos los activos del almacén del folio. */
  aisle_ids?: string[];
}
export interface SetTeamsDto {
  teams: { aisle_id: string; supervisor_id?: string | null; counter_ids?: string[] }[];
}

@Injectable()
export class InventoryTeamService {
  private readonly logger = new Logger(InventoryTeamService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private userId(): string | null {
    return this.tenantCtx.get()?.userId || null;
  }

  private async folioOrThrow(trx: any, countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    const folio = await trx('commercial.inventory_counts').where('id', countId).first();
    if (!folio) throw new NotFoundException('Folio no encontrado');
    return folio;
  }

  /** Tablero del folio: pasillos del almacén + su equipo (supervisor + contadores). */
  async getBoard(countId: string) {
    return this.tk.run(async (trx) => {
      const folio = await this.folioOrThrow(trx, countId);
      const aisles = await trx('commercial.warehouse_aisles')
        .where('warehouse_id', folio.warehouse_id)
        .andWhere('active', true)
        .orderBy([
          { column: 'grid_row', order: 'asc' },
          { column: 'grid_col', order: 'asc' },
        ])
        .select('id', 'code', 'name', 'grid_row', 'grid_col', 'span_rows', 'span_cols');
      const teams = await this.teamsFor(trx, countId, aisles);
      return { warehouse_id: folio.warehouse_id, status: folio.status, aisles: teams };
    });
  }

  /** Genera equipos PAREJOS y los persiste (reescribe las filas aisle-scoped). */
  async generate(countId: string, dto: GenerateTeamsDto) {
    const supIds = [...new Set((dto.supervisor_ids || []).filter((x) => UUID.test(x)))];
    const cntIds = [...new Set((dto.counter_ids || []).filter((x) => UUID.test(x)))];
    return this.tk.run(async (trx) => {
      const folio = await this.folioOrThrow(trx, countId);
      if (folio.status === 'reconciled' || folio.status === 'cancelled')
        throw new ConflictException('El folio ya está cerrado.');

      const reqAisleIds = [...new Set((dto.aisle_ids || []).filter((x) => UUID.test(x)))];
      let aislesQ = trx('commercial.warehouse_aisles')
        .where('warehouse_id', folio.warehouse_id)
        .andWhere('active', true)
        .orderBy([
          { column: 'grid_row', order: 'asc' },
          { column: 'grid_col', order: 'asc' },
        ]);
      if (reqAisleIds.length) aislesQ = aislesQ.whereIn('id', reqAisleIds);
      const aisles = await aislesQ.select('id', 'code', 'name', 'grid_row', 'grid_col', 'span_rows', 'span_cols');
      if (!aisles.length)
        throw new BadRequestException('No hay pasillos activos en este almacén. Definí pasillos primero (Pasillos).');

      const n = aisles.length;
      const base = Math.floor(cntIds.length / n);
      const rem = cntIds.length % n;
      const uid = this.userId();

      await trx('commercial.inventory_count_assignments')
        .where('count_id', countId)
        .whereNotNull('aisle_id')
        .del();

      const rows: any[] = [];
      let ci = 0;
      aisles.forEach((aisle, i) => {
        const sup = supIds[i]; // 1 supervisor por pasillo (en orden)
        if (sup) rows.push(this.row(trx, countId, sup, 'supervisor', aisle.id, uid));
        const take = base + (i < rem ? 1 : 0); // contadores parejos
        for (let k = 0; k < take; k++) {
          const c = cntIds[ci++];
          if (c) rows.push(this.row(trx, countId, c, 'counter', aisle.id, uid));
        }
      });
      if (rows.length) await trx('commercial.inventory_count_assignments').insert(rows);

      const teams = await this.teamsFor(trx, countId, aisles);
      return {
        ok: true,
        aisles: n,
        supervisors_used: Math.min(supIds.length, n),
        counters_assigned: cntIds.length,
        aisles_without_supervisor: Math.max(0, n - supIds.length),
        teams,
      };
    });
  }

  /** Set manual del tablero (ajuste fino tras auto-generar). */
  async setTeams(countId: string, dto: SetTeamsDto) {
    const teams = Array.isArray(dto?.teams) ? dto.teams : [];
    return this.tk.run(async (trx) => {
      const folio = await this.folioOrThrow(trx, countId);
      if (folio.status === 'reconciled' || folio.status === 'cancelled')
        throw new ConflictException('El folio ya está cerrado.');

      const valid = await trx('commercial.warehouse_aisles')
        .where('warehouse_id', folio.warehouse_id)
        .andWhere('active', true)
        .pluck('id');
      const validSet = new Set<string>(valid);
      const uid = this.userId();

      await trx('commercial.inventory_count_assignments')
        .where('count_id', countId)
        .whereNotNull('aisle_id')
        .del();

      const rows: any[] = [];
      for (const t of teams) {
        if (!t?.aisle_id || !validSet.has(t.aisle_id)) continue;
        if (t.supervisor_id && UUID.test(t.supervisor_id))
          rows.push(this.row(trx, countId, t.supervisor_id, 'supervisor', t.aisle_id, uid));
        const counters = [...new Set((t.counter_ids || []).filter((x) => UUID.test(x)))];
        for (const c of counters) rows.push(this.row(trx, countId, c, 'counter', t.aisle_id, uid));
      }
      if (rows.length) await trx('commercial.inventory_count_assignments').insert(rows);

      const aisles = await trx('commercial.warehouse_aisles')
        .where('warehouse_id', folio.warehouse_id)
        .andWhere('active', true)
        .orderBy([
          { column: 'grid_row', order: 'asc' },
          { column: 'grid_col', order: 'asc' },
        ])
        .select('id', 'code', 'name', 'grid_row', 'grid_col', 'span_rows', 'span_cols');
      return { ok: true, teams: await this.teamsFor(trx, countId, aisles) };
    });
  }

  private row(trx: any, countId: string, userId: string, role: 'counter' | 'supervisor', aisleId: string, by: string | null) {
    return {
      tenant_id: trx.raw('public.current_tenant_id()'),
      count_id: countId,
      user_id: userId,
      assignment_role: role,
      aisle_id: aisleId,
      assigned_by: by,
    };
  }

  private async teamsFor(
    trx: any,
    countId: string,
    aisles: { id: string; code: string; name: string; grid_row: number; grid_col: number; span_rows: number; span_cols: number }[],
  ) {
    const assigns = await trx('commercial.inventory_count_assignments as a')
      .leftJoin('identity.users as u', 'u.id', 'a.user_id')
      .where('a.count_id', countId)
      .whereNotNull('a.aisle_id')
      .select('a.aisle_id', 'a.assignment_role', 'a.user_id', 'u.username', 'u.nombre');

    const byAisle = new Map<string, any>();
    for (const a of aisles)
      byAisle.set(a.id, {
        aisle_id: a.id,
        code: a.code,
        name: a.name,
        grid_row: a.grid_row,
        grid_col: a.grid_col,
        span_rows: a.span_rows,
        span_cols: a.span_cols,
        supervisor: null,
        counters: [],
      });
    for (const r of assigns) {
      const grp = byAisle.get(r.aisle_id);
      if (!grp) continue;
      const person = { user_id: r.user_id, name: r.nombre || r.username || '—' };
      if (r.assignment_role === 'supervisor') grp.supervisor = person;
      else grp.counters.push(person);
    }
    return [...byAisle.values()];
  }
}
