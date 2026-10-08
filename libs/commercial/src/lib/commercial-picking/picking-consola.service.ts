import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  ConsolaSurtidoAlmacen,
  ConsolaSurtidoDestino,
  ConsolaSurtidoOla,
  ConsolaSurtidoResponse,
  KeplerWavesAutoResponse,
} from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { PickingService } from './picking.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** El código de destino es el de Kepler (`kdm1.c10`, medido: hasta 13 caracteres, sin raros); sólo se frena lo imposible. */
const DESTINO_RE = /^\P{Cc}{1,20}$/u;

interface OlaSqlRow {
  id: string;
  code: string;
  status: string;
  origen: string | null;
  armada_por: 'consola' | 'auto';
  prioridad: number;
  prioridad_motivo: string | null;
  assigned_to: string | null;
  assigned_nombre: string | null;
  created_at: Date;
  started_at: Date | null;
  liberada_at: Date | null;
  renglones: number;
  tocados: number;
  pedidos: string[] | null;
  destinos: string[] | null;
  hora_salida: string | null;
}

/**
 * `[GP.3c.2]` **La consola de surtido: quién prioriza la fila** (`FASE_GP` §8.3).
 *
 * Decisión de Francisco (2026-10-08): el surtidor TOMA el siguiente sin elegir; quien decide el
 * orden es el coordinador (coordinador de embarques, encargado de tienda, supervisor), con su
 * permiso propio `ALMACEN_SURTIDO_COORDINAR`. Desde aquí:
 *
 *  · ve la fila en el MISMO orden en que "Tomar siguiente" la va a dar (urgente → salida más
 *    próxima → lo más viejo), con quién trae cada surtido y su avance;
 *  · captura la hora de salida de cada destino del día;
 *  · marca urgente (con motivo), libera un surtido de quien se fue, o lo cancela (con motivo);
 *  · ajusta el umbral de la tanda del almacén y arma los surtidos pendientes.
 *
 * ⚠️ Alcance: un encargado sólo maneja SU sucursal (`ScopeService`, área almacén, fail-closed). Un
 * almacén fuera de su alcance responde igual que uno que no existe.
 */
@Injectable()
export class PickingConsolaService {
  private readonly logger = new Logger(PickingConsolaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly picking: PickingService,
  ) {}

  /** Los almacenes que quien consulta puede manejar: los de su alcance (todos si no tiene). */
  async almacenes(): Promise<ConsolaSurtidoAlmacen[]> {
    const visibles = this.scope.intersect(await this.scope.current('almacen'), 'warehouse', null);
    const filas: Array<{ id: string; code: string; nombre: string | null }> = await this.tk.run((trx) =>
      trx('commercial.warehouses')
        .whereNull('deleted_at')
        .whereRaw(`btrim(code) ~ '^[0-9]{2}$'`)
        .orderBy('code')
        .select('id', trx.raw('btrim(code) AS code'), trx.raw(`COALESCE(NULLIF(btrim(name), ''), btrim(code)) AS nombre`)),
    );
    const lista = visibles === null ? filas : filas.filter((f) => [...visibles].includes(f.code));
    return lista.map((f) => ({ id: f.id, code: f.code, nombre: f.nombre ?? f.code }));
  }

  async consola(warehouseId: string): Promise<ConsolaSurtidoResponse> {
    const alm = await this.almacenEnAlcance(warehouseId);
    const umbral = await this.picking.umbralTanda(alm.id);
    const pool = await this.picking.poolKepler({ warehouse_id: alm.id });

    return this.tk.run(async (trx) => {
      const fecha = await this.hoyMx(trx);
      const { rows } = await trx.raw(
        `SELECT pw.id, pw.code, pw.status, pw.origen, pw.armada_por, pw.prioridad, pw.prioridad_motivo,
                pw.assigned_to, COALESCE(NULLIF(btrim(u.nombre), ''), u.username) AS assigned_nombre,
                pw.created_at, pw.started_at, pw.liberada_at,
                (SELECT count(*) FROM commercial.wave_lines wl WHERE wl.wave_id = pw.id)::int AS renglones,
                (SELECT count(*) FROM commercial.wave_lines wl
                  WHERE wl.wave_id = pw.id AND wl.status <> 'pendiente')::int AS tocados,
                (SELECT array_agg(COALESCE(o.code,
                          'UD40' || lpad(wo.kepler_serie::text, 2, '0') || '-' || wo.kepler_folio) ORDER BY wo.added_at)
                   FROM commercial.wave_orders wo
                   LEFT JOIN commercial.orders o ON o.id = wo.order_id AND wo.source <> 'kepler'
                  WHERE wo.wave_id = pw.id) AS pedidos,
                (SELECT array_agg(DISTINCT COALESCE(wo.destino_nombre, wo.destino_code))
                   FROM commercial.wave_orders wo
                  WHERE wo.wave_id = pw.id AND wo.destino_code IS NOT NULL) AS destinos,
                (SELECT to_char(min(d.hora_salida), 'HH24:MI')
                   FROM commercial.wave_orders wo
                   JOIN commercial.picking_departures d
                     ON d.warehouse_id = pw.warehouse_id AND d.fecha = ?::date AND d.destino_code = wo.destino_code
                  WHERE wo.wave_id = pw.id) AS hora_salida
           FROM commercial.picking_waves pw
           LEFT JOIN identity.users u ON u.id = pw.assigned_to
          WHERE pw.warehouse_id = ? AND pw.status IN ('abierta', 'en_surtido')
          -- El MISMO orden de "Tomar siguiente" (PickingService.asignarOla).
          ORDER BY pw.prioridad DESC, hora_salida ASC NULLS LAST, pw.created_at, pw.id`,
        [fecha, alm.id],
      );
      const olas: ConsolaSurtidoOla[] = (rows as OlaSqlRow[]).map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        origen: r.origen,
        armada_por: r.armada_por,
        prioridad: Number(r.prioridad) === 1 ? 1 : 0,
        prioridad_motivo: r.prioridad_motivo,
        assigned_to: r.assigned_to,
        assigned_nombre: r.assigned_nombre,
        created_at: new Date(r.created_at).toISOString(),
        started_at: r.started_at ? new Date(r.started_at).toISOString() : null,
        // La misma condición con la que "Tomar siguiente" la acepta (PickingService.asignarOla).
        tomable: !r.assigned_to && (r.status === 'abierta' || (r.status === 'en_surtido' && !!r.liberada_at)),
        renglones: Number(r.renglones) || 0,
        tocados: Number(r.tocados) || 0,
        pedidos: r.pedidos ?? [],
        destinos: (r.destinos ?? []).filter((d): d is string => !!d),
        hora_salida: r.hora_salida,
      }));

      const { rows: hechas } = await trx.raw(
        `SELECT count(*)::int AS n FROM commercial.picking_waves
          WHERE warehouse_id = ? AND status = 'surtida'
            AND (finished_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`,
        [alm.id, fecha],
      );

      // ── Destinos del día: lo que falta armar (pool) + lo que ya está en surtido + sus horas ──
      const destinos = new Map<string, ConsolaSurtidoDestino>();
      const destino = (code: string, nombre: string | null): ConsolaSurtidoDestino => {
        let d = destinos.get(code);
        if (!d) {
          d = { destino_code: code, destino_nombre: nombre, por_armar: 0, en_surtido: 0, hora_salida: null };
          destinos.set(code, d);
        }
        if (!d.destino_nombre && nombre) d.destino_nombre = nombre;
        return d;
      };
      for (const p of pool.data) if (p.cliente_code) destino(p.cliente_code, p.customer_name).por_armar++;
      const { rows: enOla } = await trx.raw(
        `SELECT wo.destino_code, max(wo.destino_nombre) AS destino_nombre, count(*)::int AS n
           FROM commercial.wave_orders wo
           JOIN commercial.picking_waves pw ON pw.id = wo.wave_id
          WHERE pw.warehouse_id = ? AND pw.status IN ('abierta', 'en_surtido') AND wo.destino_code IS NOT NULL
          GROUP BY wo.destino_code`,
        [alm.id],
      );
      for (const r of enOla as Array<{ destino_code: string; destino_nombre: string | null; n: number }>) {
        destino(r.destino_code, r.destino_nombre).en_surtido += Number(r.n) || 0;
      }
      const { rows: salidas } = await trx.raw(
        `SELECT destino_code, destino_nombre, to_char(hora_salida, 'HH24:MI') AS hora
           FROM commercial.picking_departures WHERE warehouse_id = ? AND fecha = ?::date`,
        [alm.id, fecha],
      );
      for (const s of salidas as Array<{ destino_code: string; destino_nombre: string | null; hora: string }>) {
        destino(s.destino_code, s.destino_nombre).hora_salida = s.hora;
      }

      const elegibles = pool.data.filter((p) => p.sin_catalogo === 0 && p.lines > 0);
      return {
        warehouse_id: alm.id,
        sucursal: alm.code,
        fecha,
        umbral_tanda: umbral,
        olas,
        surtidas_hoy: Number((hechas as Array<{ n: number }>)[0]?.n) || 0,
        por_armar: {
          pedidos: pool.data.length,
          // Con el umbral DEL ALMACÉN, no con el fijo que trae cada fila del pool.
          tanda: elegibles.filter((p) => p.lines <= umbral).length,
          individual: elegibles.filter((p) => p.lines > umbral).length,
          bloqueados: pool.data.filter((p) => p.sin_catalogo > 0).length,
          atorados: pool.atorados,
        },
        // Primero los que tienen hora (por hora), después los que la esperan (por nombre).
        destinos: [...destinos.values()].sort(
          (a, b) =>
            (a.hora_salida ?? '99:99').localeCompare(b.hora_salida ?? '99:99') ||
            (a.destino_nombre ?? a.destino_code).localeCompare(b.destino_nombre ?? b.destino_code),
        ),
      };
    });
  }

  /** Urgente va antes que todo en "Tomar siguiente". Marcarlo exige motivo: queda quién y por qué. */
  async prioridad(waveId: string, dto: { urgente: boolean; motivo?: string }): Promise<{ id: string; prioridad: 0 | 1 }> {
    if (typeof dto?.urgente !== 'boolean') throw new BadRequestException('urgente debe ser true o false.');
    const urgente = dto.urgente;
    const motivo = String(dto?.motivo ?? '').trim();
    if (urgente && motivo.length < 3) throw new BadRequestException('Marcar urgente necesita un motivo (al menos 3 letras).');
    await this.olaViva(waveId);
    const userId = this.tenantCtx.get()?.userId || null;
    const n = await this.tk.run((trx) =>
      trx('commercial.picking_waves').where({ id: waveId }).whereIn('status', ['abierta', 'en_surtido']).update({
        prioridad: urgente ? 1 : 0,
        prioridad_motivo: urgente ? motivo.slice(0, 300) : null,
        prioridad_por: userId,
        prioridad_at: trx.fn.now(),
        updated_at: trx.fn.now(),
        updated_by: userId,
      }),
    );
    if (!n) throw new ConflictException('Ese surtido se acaba de terminar o cancelar.');
    this.logger.log(`[GP.3c] ola ${waveId} ${urgente ? 'URGENTE: ' + motivo : 'normal'}`);
    return { id: waveId, prioridad: urgente ? 1 : 0 };
  }

  /**
   * Quita el surtido a quien lo trae (se fue, se enfermó, lo movieron): vuelve a la fila y lo toma
   * el siguiente surtidor, CON lo que ya se marcó. No borra nada.
   */
  async liberar(waveId: string): Promise<{ id: string; liberada: true }> {
    const w = await this.olaViva(waveId);
    if (!w.assigned_to) throw new ConflictException('Ese surtido no lo trae nadie.');
    const userId = this.tenantCtx.get()?.userId || null;
    // Sólo si sigue en manos de quien la consola vio: si entre medio la cerró o la tomó otro, no
    // se le quita a nadie más ni se borra quién la surtió.
    const n = await this.tk.run((trx) =>
      trx('commercial.picking_waves')
        .where({ id: waveId, assigned_to: w.assigned_to })
        .whereIn('status', ['abierta', 'en_surtido'])
        .update({
          assigned_to: null,
          liberada_at: trx.fn.now(),
          liberada_de: w.assigned_to,
          liberada_por: userId,
          notes: trx.raw(`concat_ws(' · ', notes, ?::text)`, ['[GP.3c] liberada desde la consola']),
          updated_at: trx.fn.now(),
          updated_by: userId,
        }),
    );
    if (!n) throw new ConflictException('Ese surtido acaba de cambiar (se terminó o lo tomó otro). Actualiza la consola.');
    return { id: waveId, liberada: true };
  }

  /** Cancelar exige motivo: los pedidos vuelven a la fila y alguien tiene que saber por qué. */
  async cancelar(waveId: string, dto: { motivo?: string }): Promise<{ id: string; cancelada: true }> {
    const motivo = String(dto?.motivo ?? '').trim();
    if (motivo.length < 3) throw new BadRequestException('Cancelar un surtido necesita un motivo (al menos 3 letras).');
    await this.olaViva(waveId);
    await this.picking.cancelWave(waveId, `[GP.3c] ${motivo.slice(0, 300)}`);
    return { id: waveId, cancelada: true };
  }

  /** La hora de salida de un destino HOY. `hora_salida: null` la borra. */
  async salida(dto: {
    warehouse_id: string;
    destino_code: string;
    destino_nombre?: string | null;
    hora_salida: string | null;
  }): Promise<{ destino_code: string; hora_salida: string | null }> {
    const alm = await this.almacenParaEscribir(dto?.warehouse_id);
    const destino = String(dto?.destino_code ?? '').trim();
    if (!DESTINO_RE.test(destino)) throw new BadRequestException('destino_code inválido');
    const hora = dto.hora_salida == null || dto.hora_salida === '' ? null : String(dto.hora_salida).trim();
    if (hora !== null && !HORA_RE.test(hora)) throw new BadRequestException('hora_salida debe ser HH:MM (24 h)');
    const userId = this.tenantCtx.get()?.userId || null;
    await this.tk.run(async (trx) => {
      const fecha = await this.hoyMx(trx);
      if (hora === null) {
        await trx('commercial.picking_departures').where({ warehouse_id: alm.id, fecha, destino_code: destino }).del();
        return;
      }
      await trx('commercial.picking_departures')
        .insert({
          warehouse_id: alm.id,
          fecha,
          destino_code: destino,
          destino_nombre: dto.destino_nombre ? String(dto.destino_nombre).slice(0, 120) : null,
          hora_salida: hora,
          created_by: userId,
          updated_by: userId,
        })
        .onConflict(['tenant_id', 'warehouse_id', 'fecha', 'destino_code'])
        .merge({ hora_salida: hora, updated_at: trx.fn.now(), updated_by: userId });
    });
    return { destino_code: destino, hora_salida: hora };
  }

  /** Hasta cuántos renglones un pedido va en tanda con otros, en este almacén. */
  async umbral(dto: { warehouse_id: string; umbral_tanda: number }): Promise<{ umbral_tanda: number }> {
    const alm = await this.almacenParaEscribir(dto?.warehouse_id);
    const u = Number(dto?.umbral_tanda);
    if (!Number.isInteger(u) || u < 1 || u > 50) throw new BadRequestException('umbral_tanda debe ser un entero entre 1 y 50');
    const userId = this.tenantCtx.get()?.userId || null;
    await this.tk.run((trx) =>
      trx('commercial.picking_settings')
        .insert({ warehouse_id: alm.id, umbral_tanda: u, created_by: userId, updated_by: userId })
        .onConflict(['tenant_id', 'warehouse_id'])
        .merge({ umbral_tanda: u, updated_at: trx.fn.now(), updated_by: userId }),
    );
    return { umbral_tanda: u };
  }

  /** Arma ya los surtidos pendientes (sin esperar a que un surtidor apriete "Tomar siguiente"). */
  async armar(dto: { warehouse_id: string; origen?: string }): Promise<KeplerWavesAutoResponse> {
    const alm = await this.almacenParaEscribir(dto?.warehouse_id);
    return this.picking.crearOlasKepler({ warehouse_id: alm.id, origen: dto.origen });
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────────

  private async hoyMx(trx: Knex.Transaction): Promise<string> {
    const { rows } = await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`);
    return (rows as Array<{ d: string }>)[0].d;
  }

  /**
   * El almacén, si es una sucursal Kepler y está dentro del alcance de quien consulta. Fuera de
   * alcance responde igual que "no existe": no se confirma qué hay en otra sucursal.
   */
  /** Para cambiar algo no basta con verlo: el alcance de escritura (`mode_write`) tiene que incluir la sucursal. */
  private async almacenParaEscribir(warehouseId: string): Promise<{ id: string; code: string }> {
    const alm = await this.almacenEnAlcance(warehouseId);
    await this.scope.assertCanWrite('warehouse', alm.code, 'almacen');
    return alm;
  }

  private async almacenEnAlcance(warehouseId: string): Promise<{ id: string; code: string }> {
    if (!UUID_RE.test(warehouseId || '')) throw new BadRequestException('warehouse_id inválido');
    const w: { id: string; code: string | null } | undefined = await this.tk.run((trx) =>
      trx('commercial.warehouses').where({ id: warehouseId }).whereNull('deleted_at').first('id', 'code'),
    );
    const code = String(w?.code ?? '').trim();
    if (!w || !/^\d{2}$/.test(code)) throw new NotFoundException('Almacén no encontrado.');
    const visibles = this.scope.intersect(await this.scope.current('almacen'), 'warehouse', null);
    if (visibles !== null && ![...visibles].includes(code)) throw new NotFoundException('Almacén no encontrado.');
    return { id: w.id, code };
  }

  /** La ola, viva (abierta o en surtido) y de un almacén dentro del alcance. */
  private async olaViva(waveId: string): Promise<{ id: string; assigned_to: string | null }> {
    if (!UUID_RE.test(waveId || '')) throw new BadRequestException('waveId inválido');
    const w: { id: string; warehouse_id: string; status: string; assigned_to: string | null } | undefined =
      await this.tk.run((trx) =>
        trx('commercial.picking_waves').where({ id: waveId }).first('id', 'warehouse_id', 'status', 'assigned_to'),
      );
    if (!w) throw new NotFoundException('Surtido no encontrado.');
    await this.almacenParaEscribir(w.warehouse_id);
    if (!['abierta', 'en_surtido'].includes(w.status)) {
      throw new ConflictException(`Ese surtido ya está '${w.status}'.`);
    }
    return { id: w.id, assigned_to: w.assigned_to };
  }
}
