import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  ChecadoCajaP,
  ChecadoCerrarCajaResponse,
  ChecadoEscanearDto,
  ChecadoEscaneoResponse,
  ChecadoEtiquetaCJ,
  ChecadoEtiquetaP,
  ChecadoEtiquetasResponse,
  ChecadoPedido,
  ChecadoRenglon,
  ChecadoSiguienteDto,
  ChecadoTerminarDto,
  ChecadoTerminarResponse,
  ChecadoTomarResponse,
  ConsolaSurtidoAlmacen,
} from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { PickingCapturaService } from './picking-captura.service';
import { PickingConsolaService } from './picking-consola.service';
import { esCerrada, resolverCodigo, unidadMayor, type KdiiFila } from './checado-codigo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana de surtidos que se ofrecen para checar (igual que la bandeja de Facturación). */
const DIAS = 30;
/** Cuántos pedidos listos se evalúan a fondo por toque (el orden ya viene de la consulta). */
const LOTE = 60;
const TOL = 0.001;
/** En kilos la báscula y Kepler no coinciden al gramo: medio por ciento de holgura. */
const TOL_PESO = 0.005;
const ORIGENES = new Set(['TELEMARK', 'SUCURSAL']);

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** ¿Lo checado cuadra con lo esperado? En kilos con holgura relativa; en piezas exacto. */
export function cuadraChecado(esperado: number, checado: number, sePesa: boolean): boolean {
  const tol = sePesa ? Math.max(TOL, TOL_PESO * Math.max(esperado, checado)) : TOL;
  return Math.abs(checado - esperado) <= tol;
}

/** Estado de un renglón para la pantalla. */
export function estadoRenglon(esperado: number, checado: number, sePesa: boolean): ChecadoRenglon['estado'] {
  if (cuadraChecado(esperado, checado, sePesa)) return 'completo';
  if (checado <= TOL) return 'pendiente';
  return checado < esperado ? 'falta' : 'sobra';
}

/** ¿Este escaneo pasaría de lo esperado? Entonces NO se registra: lo que sobra se regresa. */
export function excede(esperado: number, checadoAntes: number, agrega: number, sePesa: boolean): boolean {
  const nuevo = checadoAntes + agrega;
  return nuevo > esperado && !cuadraChecado(esperado, nuevo, sePesa);
}

/**
 * Las etiquetas de unidad cerrada, numeradas sobre TODO el pedido: "1/7 … 7/7" (decisión de
 * Francisco, 2026-10-08). Una por caja escaneada; "3 cajas sin etiqueta" da tres.
 */
export function etiquetasCJ(cajas: Array<{ sku: string | null; producto: string | null; unidad: string | null; cajas: number }>): ChecadoEtiquetaCJ[] {
  const total = cajas.reduce((s, c) => s + Math.max(0, Math.round(c.cajas)), 0);
  const out: ChecadoEtiquetaCJ[] = [];
  let n = 0;
  for (const c of cajas) {
    for (let i = 0; i < Math.max(0, Math.round(c.cajas)); i++) {
      n += 1;
      out.push({ n, total, sku: c.sku, producto: c.producto, unidad: c.unidad });
    }
  }
  return out;
}

interface Linea {
  id: string;
  sku: string | null;
  product_name: string | null;
  qty_unit: string | null;
  qty_expected: string;
  qty_checked: string;
  unidad_mayor: string | null;
  factor_mayor: string | null;
  se_pesa: boolean;
}

interface Chk {
  id: string;
  status: string;
  assigned_to: string;
  order_code: string;
  destino_nombre: string | null;
  sucursal: string;
}

/**
 * `[GP.4]` **El checado** (`FASE_GP` §9).
 *
 * El checador toca "Tomar siguiente" y recibe el pedido más urgente que:
 *  · ya se surtió en la Suite;
 *  · Facturación ya pasó a **SURTIDO en Kepler** y cuadra con lo surtido (GP.3d);
 *  · **él no surtió** (P4): ni arrancó la ola, ni la terminó, ni se la quitaron a él, ni marcó un
 *    renglón de ese pedido.
 *
 * Luego **rastrilla**: cada escaneo se resuelve contra el catálogo de Kepler de la sucursal. Lo que
 * viene en unidad CERRADA (CJA/BTO/CUB) cuenta como una caja con su etiqueta "n/N"; lo demás cae en
 * la **caja P abierta**, y así queda escrito qué va en cada caja. Lo que sobra NO se registra (se
 * regresa). Lo checado es lo que sale (P7). Nada escribe en Kepler (ADR-086).
 */
@Injectable()
export class ChecadoService {
  private readonly logger = new Logger(ChecadoService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly captura: PickingCapturaService,
    private readonly consola: PickingConsolaService,
  ) {}

  /** Las sucursales donde puede checar quien consulta (su alcance). */
  almacenes(): Promise<ConsolaSurtidoAlmacen[]> {
    return this.consola.almacenes();
  }

  async mio(): Promise<ChecadoPedido | null> {
    const userId = this.usuario();
    return this.tk.run(async (trx) => {
      const mio = await trx('commercial.order_checks').where({ assigned_to: userId, status: 'en_checado' }).orderBy('started_at').first('id');
      return mio ? this.cargar(trx, mio.id) : null;
    });
  }

  async tomarSiguiente(dto: ChecadoSiguienteDto): Promise<ChecadoTomarResponse> {
    const userId = this.usuario();
    const alm = await this.almacenParaEscribir(dto?.warehouse_id);
    const origen = dto?.origen ? String(dto.origen).toUpperCase() : null;
    if (origen && !ORIGENES.has(origen)) throw new BadRequestException('Origen no válido.');

    return this.tk.run(async (trx) => {
      // Un checador, un pedido: dos toques seguidos no le dan dos pedidos.
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`gp4-checador:${userId}`]);
      const mio = await trx('commercial.order_checks').where({ assigned_to: userId, status: 'en_checado' }).orderBy('started_at').first('id');
      if (mio) return { estado: 'asignado', ya_era_tuyo: true, pedido: await this.cargar(trx, mio.id) };

      // Todos los surtidos sin checar de la ventana, con el estatus VIGENTE de Kepler. Filtrar por
      // estatus ANTES de recortar: si no, los que Kepler ya checó por fuera ocupan el lote y el que
      // sí está listo nunca se ofrece. El orden es el de la fila del surtidor.
      const { rows } = await trx.raw(
        `SELECT wo.order_id, pw.id AS wave_id, wo.kepler_sucursal, wo.kepler_serie, wo.kepler_folio, wo.destino_nombre,
                (SELECT wol.order_code FROM commercial.wave_order_lines wol
                  WHERE wol.wave_id = pw.id AND wol.order_id = wo.order_id LIMIT 1) AS order_code,
                hh.estatus
           FROM commercial.picking_waves pw
           JOIN commercial.wave_orders wo ON wo.wave_id = pw.id AND wo.source = 'kepler'
           LEFT JOIN LATERAL (
             SELECT upper(NULLIF(btrim(h.c11::text), '')) AS estatus
               FROM kepler_ods.kdm1 h
              WHERE h.c2 = 'U' AND h.c3 = 'D' AND btrim(h.sucursal) = wo.kepler_sucursal AND (h.c4)::integer = 40
                AND (h.c5)::integer = wo.kepler_serie AND btrim(h.c6) = wo.kepler_folio AND btrim(h.c1) = btrim(h.sucursal)
              ORDER BY h.c9 DESC
              LIMIT 1
           ) hh ON true
          WHERE pw.warehouse_id = ? AND pw.status = 'surtida'
            AND pw.finished_at >= now() - (? || ' days')::interval
            AND (?::text IS NULL OR pw.origen = ?::text)
            AND EXISTS (SELECT 1 FROM commercial.wave_order_lines wol WHERE wol.wave_id = pw.id AND wol.order_id = wo.order_id)
            AND NOT EXISTS (SELECT 1 FROM commercial.order_checks oc WHERE oc.order_id = wo.order_id AND oc.status <> 'cancelado')
            -- P4: quien arrancó la ola, quien la terminó y a quien se la quitaron no la checan…
            AND pw.picked_by IS DISTINCT FROM ?::uuid
            AND pw.assigned_to IS DISTINCT FROM ?::uuid
            AND pw.liberada_de IS DISTINCT FROM ?::uuid
            -- …ni quien marcó un renglón de ESTE pedido.
            AND NOT EXISTS (
                  SELECT 1 FROM commercial.wave_lines wl
                    JOIN commercial.wave_allocations wa ON wa.wave_id = wl.wave_id AND wa.product_id = wl.product_id
                   WHERE wl.wave_id = pw.id AND wa.order_id = wo.order_id AND wl.picked_by = ?::uuid)
          ORDER BY pw.prioridad DESC,
                   (SELECT min(d.hora_salida) FROM commercial.picking_departures d
                     WHERE d.warehouse_id = pw.warehouse_id
                       AND d.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date
                       AND d.destino_code = wo.destino_code) ASC NULLS LAST,
                   pw.finished_at, wo.order_id`,
        [alm.id, DIAS, origen, origen, userId, userId, userId, userId],
      );
      type Cand = { order_id: string; wave_id: string; kepler_sucursal: string; kepler_serie: number; kepler_folio: string; destino_nombre: string | null; order_code: string | null; estatus: string | null };
      const todos = rows as Cand[];
      const listos = todos.filter((c) => c.estatus === 'SURTIDO');
      let esperando = todos.filter((c) => c.estatus === 'AUTORIZADO').length;
      const fuera = todos.filter((c) => c.estatus === 'CHECADO' || c.estatus === 'EMBARCADO').length;

      for (let i = 0; i < listos.length; i += LOTE) {
        const lote = listos.slice(i, i + LOTE);
        const estados = await this.captura.estadosDe(trx, lote.map((c) => c.order_id));
        for (const c of lote) {
          const e = estados.get(c.order_id);
          // En SURTIDO pero sin cuadrar con lo surtido: Facturación todavía tiene que corregirlo.
          if (!e || e.estado !== 'capturado') {
            esperando += 1;
            continue;
          }
          const { rows: ins } = await trx.raw(
            `INSERT INTO commercial.order_checks
               (warehouse_id, wave_id, order_id, order_code, kepler_sucursal, kepler_serie, kepler_folio, destino_nombre,
                assigned_to, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, order_id) WHERE status <> 'cancelado' DO NOTHING
             RETURNING id`,
            [alm.id, c.wave_id, c.order_id, c.order_code ?? `UD40${String(c.kepler_serie).padStart(2, '0')}-${c.kepler_folio}`,
             c.kepler_sucursal, c.kepler_serie, c.kepler_folio, c.destino_nombre, userId, userId, userId],
          );
          if (!ins.length) continue; // otro checador se lo llevó en este instante
          await this.crearRenglones(trx, ins[0].id, c.wave_id, c.order_id, alm.code);
          this.logger.log(`[GP.4] checado ${c.order_code} → ${userId}`);
          return { estado: 'asignado', ya_era_tuyo: false, pedido: await this.cargar(trx, ins[0].id) };
        }
      }

      const partes: string[] = [];
      if (esperando) partes.push(`${esperando === 1 ? '1 pedido surtido espera' : `${esperando} pedidos surtidos esperan`} a que Facturación ${esperando === 1 ? 'lo pase' : 'los pase'} a SURTIDO en Kepler.`);
      if (fuera) partes.push(`${fuera === 1 ? '1 pedido surtido ya está' : `${fuera} pedidos surtidos ya están`} checados en Kepler sin haber pasado por aquí.`);
      return {
        estado: 'sin_trabajo',
        motivo: partes.join(' ') || 'No hay pedidos surtidos por checar en esta sucursal.',
        esperando_facturacion: esperando,
        checados_fuera: fuera,
      };
    });
  }

  async escanear(checkId: string, dto: ChecadoEscanearDto): Promise<ChecadoEscaneoResponse> {
    const code = String(dto?.code ?? '').trim();
    if (!code || code.length > 40) throw new BadRequestException('Escanea o escribe un código.');
    const peso = dto?.peso_kg == null ? null : Number(dto.peso_kg);
    if (peso !== null && (!Number.isFinite(peso) || peso <= 0 || peso > 5000)) throw new BadRequestException('El peso no es válido.');
    const cantidad = peso !== null ? 1 : dto?.cantidad == null ? 1 : Number(dto.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) throw new BadRequestException('La cantidad va de 1 a 999.');
    const comoCajas = dto?.como_cajas === true;
    const userId = this.usuario();

    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      const lineas = (await trx('commercial.order_check_lines').where({ check_id: chk.id })) as Linea[];
      const porSku = new Map(lineas.filter((l) => l.sku).map((l) => [String(l.sku), l]));
      const responder = async (resultado: ChecadoEscaneoResponse['resultado'], mensaje: string, producto: string | null) =>
        ({ resultado, mensaje, producto, pedido: await this.cargar(trx, chk.id) });

      const res = resolverCodigo(code, await this.kdiiPorCodigo(trx, chk.sucursal, code), new Set(porSku.keys()));
      if (res.tipo === 'desconocido') return responder('desconocido', `El código ${code} no está en el catálogo de Kepler de esta sucursal.`, null);
      if (res.tipo === 'ambiguo') return responder('ambiguo', `El código ${code} lo tienen varios productos (${res.candidatos.join(', ')}). Escanea otra etiqueta del producto.`, null);
      const r = res.resuelto;
      const linea = porSku.get(r.sku);

      if (!linea) {
        await trx('commercial.check_scans').insert({
          check_id: chk.id, code, sku: r.sku, unidad: r.unidad, factor: r.factor,
          qty_units: cantidad, qty_base: r3(cantidad * r.factor), kind: 'ajeno', scanned_by: userId,
        });
        return responder('ajeno', `${r.nombre ?? r.sku} no va en este pedido. Sepáralo.`, r.nombre);
      }
      const nombre = linea.product_name ?? r.sku;

      // Qué se está contando: una caja cerrada (por su etiqueta, o la pieza con "son cajas") o
      // paquetería suelta que va a la caja P.
      let unidad = r.unidad;
      let factor = r.factor;
      if (comoCajas) {
        if (!linea.unidad_mayor || linea.factor_mayor == null) {
          return responder('no_es_caja', `${nombre} no viene en caja cerrada: escanéalo como pieza o paquete.`, nombre);
        }
        unidad = linea.unidad_mayor;
        factor = Number(linea.factor_mayor);
      }
      const kind: 'mayor' | 'menor' = comoCajas || esCerrada(unidad) ? 'mayor' : 'menor';

      // Se vende por kilo y va suelto: manda la báscula.
      let qtyBase = r3(cantidad * factor);
      const pesado = linea.se_pesa && kind === 'menor' && factor === 1;
      if (pesado) {
        if (peso === null) return responder('pide_peso', `Pesa ${nombre} y escribe los kilos.`, nombre);
        qtyBase = r3(peso);
      }

      // Lo que sobra NO se registra: físicamente se regresa a su lugar.
      const esperado = Number(linea.qty_expected);
      const antes = Number(linea.qty_checked);
      if (excede(esperado, antes, qtyBase, linea.se_pesa)) {
        return responder('sobra', `Ya van completas: ${esperado} ${linea.qty_unit ?? ''} de ${nombre}. Esto sobra: regrésalo a su lugar (no se contó).`.replace('  ', ' '), nombre);
      }

      const paquete = kind === 'menor' ? await this.cajaAbierta(trx, chk.id, userId) : null;
      await trx('commercial.check_scans').insert({
        check_id: chk.id, line_id: linea.id, package_id: paquete, code, sku: r.sku, unidad, factor,
        qty_units: cantidad, qty_base: qtyBase, kind, weight_kg: pesado ? qtyBase : null, scanned_by: userId,
      });
      await trx('commercial.order_check_lines').where({ id: linea.id }).update({ qty_checked: r3(antes + qtyBase), updated_at: trx.fn.now() });

      const cuanto = pesado ? `${qtyBase} kg` : `${cantidad} ${unidad ?? ''}`.trim();
      return responder('ok', `+${cuanto} · ${nombre}${kind === 'menor' ? ' → caja P' : ''}`, nombre);
    });
  }

  async deshacer(checkId: string, scanId: string): Promise<ChecadoPedido> {
    if (!UUID_RE.test(scanId || '')) throw new BadRequestException('Escaneo inválido.');
    const userId = this.usuario();
    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      const scan = await trx('commercial.check_scans').where({ id: scanId, check_id: chk.id }).whereNull('undone_at').forUpdate().first();
      if (!scan) throw new ConflictException('Ese escaneo ya se deshizo.');
      if (scan.package_id) {
        const caja = await trx('commercial.check_packages').where({ id: scan.package_id }).first('status', 'numero');
        if (caja?.status === 'cerrada') throw new ConflictException(`La caja P${caja.numero} ya se cerró y etiquetó: ese escaneo ya no se deshace.`);
      }
      await trx('commercial.check_scans').where({ id: scanId }).update({ undone_at: trx.fn.now() });
      if (scan.line_id) {
        await trx.raw(`UPDATE commercial.order_check_lines SET qty_checked = GREATEST(0, qty_checked - ?), updated_at = now() WHERE id = ?`, [Number(scan.qty_base), scan.line_id]);
      }
      return this.cargar(trx, chk.id);
    });
  }

  async cerrarCaja(checkId: string): Promise<ChecadoCerrarCajaResponse> {
    const userId = this.usuario();
    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      const etiqueta = await this.cerrarAbierta(trx, chk);
      if (!etiqueta) throw new ConflictException('No hay una caja P con paquetería para cerrar.');
      return { etiqueta, pedido: await this.cargar(trx, chk.id) };
    });
  }

  async terminar(checkId: string, dto: ChecadoTerminarDto): Promise<ChecadoTerminarResponse> {
    const userId = this.usuario();
    const espera = dto?.wait_location ? String(dto.wait_location).trim().slice(0, 40) : null;
    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      const etiquetaP = await this.cerrarAbierta(trx, chk);
      await this.descartarCajaVacia(trx, chk.id);

      const pedido = await this.cargar(trx, chk.id);
      const diferencias = pedido.renglones
        .filter((l) => l.estado !== 'completo')
        .map((l) => ({ sku: l.sku, producto: l.producto, unidad: l.unidad, esperado: l.esperado, checado: l.checado }));
      const cajasP = pedido.cajas_p.filter((c) => c.status === 'cerrada').length;

      await trx('commercial.order_checks').where({ id: chk.id }).update({
        status: 'checado', finished_at: trx.fn.now(), wait_location: espera, updated_at: trx.fn.now(), updated_by: userId,
      });
      this.logger.log(`[GP.4] checado terminado ${chk.order_code}: ${diferencias.length} diferencia(s), ${cajasP} caja(s) P`);
      return {
        order_code: chk.order_code,
        destino: chk.destino_nombre,
        diferencias,
        etiquetas_cj: await this.etiquetasCJDe(trx, chk.id),
        etiqueta_p: etiquetaP,
        cajas_p: cajasP,
      };
    });
  }

  /**
   * El checador suelta el pedido (se tiene que ir, se equivocó de pedido): vuelve a la fila para
   * que lo tome otro, que lo checa desde cero. Lo escaneado queda en la bitácora del checado
   * cancelado; no se borra nada.
   */
  async soltar(checkId: string): Promise<{ id: string; soltado: true }> {
    const userId = this.usuario();
    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      await trx('commercial.order_checks').where({ id: chk.id }).update({
        status: 'cancelado',
        notes: trx.raw(`concat_ws(' · ', notes, ?::text)`, ['[GP.4] soltado por el checador']),
        updated_at: trx.fn.now(),
        updated_by: userId,
      });
      return { id: chk.id, soltado: true };
    });
  }

  /** Las etiquetas de un pedido ya checado por quien consulta, para reimprimir. */
  async etiquetas(checkId: string): Promise<ChecadoEtiquetasResponse> {
    if (!UUID_RE.test(checkId || '')) throw new BadRequestException('Checado inválido.');
    const userId = this.usuario();
    return this.tk.run(async (trx) => {
      const chk = await trx('commercial.order_checks').where({ id: checkId }).first('id', 'assigned_to', 'order_code', 'destino_nombre');
      if (!chk) throw new NotFoundException('Checado no encontrado.');
      if (chk.assigned_to !== userId) throw new ConflictException('Ese pedido lo checó otra persona.');
      const { rows } = await trx.raw(
        `SELECT c.id, c.numero, coalesce(sum(s.qty_units), 0) AS articulos, count(DISTINCT s.line_id)::int AS productos
           FROM commercial.check_packages c
           LEFT JOIN commercial.check_scans s ON s.package_id = c.id AND s.undone_at IS NULL
          WHERE c.check_id = ? AND c.status = 'cerrada'
          GROUP BY c.id, c.numero ORDER BY c.numero`,
        [chk.id],
      );
      return {
        order_code: chk.order_code,
        destino: chk.destino_nombre,
        etiquetas_cj: await this.etiquetasCJDe(trx, chk.id),
        cajas_p: (rows as Array<{ id: string; numero: number; articulos: string; productos: number }>).map((r) => ({
          id: r.id, numero: Number(r.numero), order_code: chk.order_code, destino: chk.destino_nombre,
          articulos: r3(Number(r.articulos)), productos: Number(r.productos),
        })),
      };
    });
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────────

  private usuario(): string {
    const id = this.tenantCtx.get()?.userId;
    if (!id) throw new ForbiddenException('Sin usuario.');
    return id;
  }

  private async almacenParaEscribir(warehouseId: string): Promise<{ id: string; code: string }> {
    if (!UUID_RE.test(warehouseId || '')) throw new BadRequestException('warehouse_id inválido');
    const w: { id: string; code: string | null } | undefined = await this.tk.run((trx) =>
      trx('commercial.warehouses').where({ id: warehouseId }).whereNull('deleted_at').first('id', 'code'),
    );
    const code = String(w?.code ?? '').trim();
    if (!w || !/^\d{2}$/.test(code)) throw new NotFoundException('Almacén no encontrado.');
    const visibles = this.scope.intersect(await this.scope.current('almacen'), 'warehouse', null);
    if (visibles !== null && ![...visibles].includes(code)) throw new NotFoundException('Almacén no encontrado.');
    await this.scope.assertCanWrite('warehouse', code, 'almacen');
    return { id: w.id, code };
  }

  /** El checado, sólo si lo trae quien llama y sigue abierto. Toma candado de fila. */
  private async checadoMio(trx: Knex.Transaction, checkId: string, userId: string): Promise<Chk> {
    if (!UUID_RE.test(checkId || '')) throw new BadRequestException('Checado inválido.');
    const chk = await trx('commercial.order_checks as oc')
      .join('commercial.warehouses as w', 'w.id', 'oc.warehouse_id')
      .where('oc.id', checkId)
      .forUpdate('oc')
      .first('oc.id', 'oc.status', 'oc.assigned_to', 'oc.order_code', 'oc.destino_nombre', trx.raw('btrim(w.code) AS sucursal'));
    if (!chk) throw new NotFoundException('Checado no encontrado.');
    if (chk.assigned_to !== userId) throw new ConflictException('Este pedido lo está checando otra persona.');
    if (chk.status !== 'en_checado') throw new ConflictException(`Este checado ya está ${chk.status}.`);
    return chk as Chk;
  }

  /** La caja P abierta del checado; si no hay, abre la siguiente (P1, P2…). */
  private async cajaAbierta(trx: Knex.Transaction, checkId: string, userId: string): Promise<string> {
    const abierta = await trx('commercial.check_packages').where({ check_id: checkId, status: 'abierta' }).first('id');
    if (abierta) return abierta.id;
    const { rows } = await trx.raw(`SELECT coalesce(max(numero), 0) + 1 AS n FROM commercial.check_packages WHERE check_id = ?`, [checkId]);
    const [nueva] = await trx('commercial.check_packages').insert({ check_id: checkId, numero: Number(rows[0].n), created_by: userId }).returning('id');
    return (nueva as { id: string }).id;
  }

  /** Cierra la caja P abierta si lleva algo, y devuelve su etiqueta. null = no había o iba vacía. */
  private async cerrarAbierta(trx: Knex.Transaction, chk: { id: string; order_code: string; destino_nombre: string | null }): Promise<ChecadoEtiquetaP | null> {
    const caja = await trx('commercial.check_packages').where({ check_id: chk.id, status: 'abierta' }).forUpdate().first('id', 'numero');
    if (!caja) return null;
    const { rows } = await trx.raw(
      `SELECT coalesce(sum(qty_units), 0) AS articulos, count(DISTINCT line_id)::int AS productos
         FROM commercial.check_scans WHERE package_id = ? AND undone_at IS NULL`,
      [caja.id],
    );
    if (Number(rows[0].articulos) <= 0) return null;
    await trx('commercial.check_packages').where({ id: caja.id }).update({
      status: 'cerrada', closed_at: trx.fn.now(), label_printed_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
    return { id: caja.id, numero: Number(caja.numero), order_code: chk.order_code, destino: chk.destino_nombre, articulos: r3(Number(rows[0].articulos)), productos: Number(rows[0].productos) };
  }

  /**
   * Una caja P abierta que quedó vacía (todo lo que llevaba se deshizo) no se queda colgada. Sus
   * escaneos deshechos se borran primero: apuntan a la caja, y un escaneo de paquetería no puede
   * quedar sin caja (CHECK de la migración). Sin esto, Terminar fallaba y el pedido se atoraba.
   */
  private async descartarCajaVacia(trx: Knex.Transaction, checkId: string): Promise<void> {
    const abiertas = await trx('commercial.check_packages').where({ check_id: checkId, status: 'abierta' }).pluck('id');
    if (!abiertas.length) return;
    await trx('commercial.check_scans').whereIn('package_id', abiertas).whereNotNull('undone_at').del();
    await trx('commercial.check_packages')
      .whereIn('id', abiertas)
      .whereNotExists(trx('commercial.check_scans as s').whereRaw('s.package_id = commercial.check_packages.id'))
      .del();
  }

  private async etiquetasCJDe(trx: Knex.Transaction, checkId: string): Promise<ChecadoEtiquetaCJ[]> {
    const { rows } = await trx.raw(
      `SELECT l.sku, l.product_name, s.unidad, sum(s.qty_units) AS cajas
         FROM commercial.check_scans s
         JOIN commercial.order_check_lines l ON l.id = s.line_id
        WHERE s.check_id = ? AND s.kind = 'mayor' AND s.undone_at IS NULL
        GROUP BY l.sku, l.product_name, s.unidad
        ORDER BY l.product_name, l.sku`,
      [checkId],
    );
    return etiquetasCJ((rows as Array<{ sku: string | null; product_name: string | null; unidad: string | null; cajas: string }>)
      .map((r) => ({ sku: r.sku, producto: r.product_name, unidad: r.unidad, cajas: Number(r.cajas) })));
  }

  /** Los renglones del checado: lo surtido (ya en Kepler) + la caja cerrada del producto en Kepler. */
  private async crearRenglones(trx: Knex.Transaction, checkId: string, waveId: string, orderId: string, sucursal: string): Promise<void> {
    const { rows } = await trx.raw(
      `SELECT wol.product_id, p.sku, p.nombre, wol.qty_unit, coalesce(wa.qty_allocated, 0) AS esperado, wl.picked_by
         FROM commercial.wave_order_lines wol
         LEFT JOIN catalog.products p ON p.id = wol.product_id
         LEFT JOIN commercial.wave_allocations wa ON wa.wave_id = wol.wave_id AND wa.order_id = wol.order_id AND wa.product_id = wol.product_id
         LEFT JOIN commercial.wave_lines wl ON wl.wave_id = wol.wave_id AND wl.product_id = wol.product_id
        WHERE wol.wave_id = ? AND wol.order_id = ?`,
      [waveId, orderId],
    );
    const renglones = (rows as Array<{ product_id: string; sku: string | null; nombre: string | null; qty_unit: string | null; esperado: string; picked_by: string | null }>)
      .filter((r) => Number(r.esperado) > TOL);
    if (!renglones.length) return;
    const kdii = new Map((await this.kdiiPorSku(trx, sucursal, renglones.map((r) => r.sku).filter((s): s is string => !!s))).map((f) => [f.sku, f]));
    await trx('commercial.order_check_lines').insert(
      renglones.map((r) => {
        const f = r.sku ? kdii.get(r.sku) : undefined;
        const mayor = f ? unidadMayor(f) : null;
        return {
          check_id: checkId,
          product_id: r.product_id,
          sku: r.sku,
          product_name: (r.nombre ?? f?.nombre ?? '').slice(0, 200) || null,
          qty_unit: r.qty_unit ? r.qty_unit.slice(0, 20) : null,
          qty_expected: Number(r.esperado),
          unidad_mayor: mayor?.unidad ? mayor.unidad.slice(0, 20) : null,
          factor_mayor: mayor?.factor ?? null,
          se_pesa: String(r.qty_unit ?? '').toUpperCase() === 'KG',
          picked_by: r.picked_by,
        };
      }),
    );
  }

  private static readonly KDII_COLS = `
    btrim(c1) AS sku, NULLIF(btrim(c2), '') AS nombre,
    upper(NULLIF(btrim(c11), '')) AS u1,
    upper(NULLIF(btrim(c80), '')) AS u2, NULLIF(btrim(c81::text), '')::numeric AS f2,
    upper(NULLIF(btrim(c83), '')) AS u3, NULLIF(btrim(c84::text), '')::numeric AS f3,
    btrim(c7) AS b1, btrim(c93) AS b2, btrim(c102) AS b3,
    btrim(c82) AS d1, btrim(c95) AS d2, btrim(c96) AS d3,
    btrim(c85) AS t1`;

  /** Desempate fijo si la sucursal trae dos fichas de la misma clave: la de caja más grande. */
  private static readonly KDII_ORDEN = `ORDER BY btrim(c1), NULLIF(btrim(c84::text), '')::numeric DESC NULLS LAST, NULLIF(btrim(c81::text), '')::numeric DESC NULLS LAST`;

  private aFila(r: Record<string, unknown>): KdiiFila {
    const s = (k: string): string | null => (r[k] == null ? null : String(r[k]));
    const n = (k: string): number | null => (r[k] == null ? null : Number(r[k]));
    return {
      sku: String(r['sku']), nombre: s('nombre'),
      u1: s('u1'), u2: s('u2'), f2: n('f2'), u3: s('u3'), f3: n('f3'),
      base: [s('b1'), s('b2'), s('b3')], dos: [s('d1'), s('d2'), s('d3')], tres: [s('t1')],
    };
  }

  /** Productos de la sucursal que traen ese código en alguna casilla, o cuya caja es C+clave. */
  private async kdiiPorCodigo(trx: Knex.Transaction, sucursal: string, code: string): Promise<KdiiFila[]> {
    const { rows } = await trx.raw(
      `SELECT DISTINCT ON (btrim(c1)) ${ChecadoService.KDII_COLS}
         FROM kepler_ods.kdii
        WHERE btrim(sucursal) = ?
          AND (upper(?) IN (upper(btrim(c7)), upper(btrim(c93)), upper(btrim(c102)), upper(btrim(c82)),
                            upper(btrim(c95)), upper(btrim(c96)), upper(btrim(c85)))
               OR upper(?) = 'C' || upper(btrim(c1)))
        ${ChecadoService.KDII_ORDEN}`,
      [sucursal, code, code],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => this.aFila(r));
  }

  private async kdiiPorSku(trx: Knex.Transaction, sucursal: string, skus: string[]): Promise<KdiiFila[]> {
    if (!skus.length) return [];
    const { rows } = await trx.raw(
      `SELECT DISTINCT ON (btrim(c1)) ${ChecadoService.KDII_COLS}
         FROM kepler_ods.kdii
        WHERE btrim(sucursal) = ? AND btrim(c1) = ANY(?::text[])
        ${ChecadoService.KDII_ORDEN}`,
      [sucursal, skus],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => this.aFila(r));
  }

  /** El checado como lo ve la pantalla. */
  private async cargar(trx: Knex.Transaction, checkId: string): Promise<ChecadoPedido> {
    const chk = await trx('commercial.order_checks as oc')
      .join('commercial.warehouses as w', 'w.id', 'oc.warehouse_id')
      .where('oc.id', checkId)
      .first('oc.id', 'oc.order_code', 'oc.destino_nombre', 'oc.warehouse_id', 'oc.started_at', trx.raw('btrim(w.code) AS sucursal'));
    if (!chk) throw new NotFoundException('Checado no encontrado.');

    const { rows: ls } = await trx.raw(
      `SELECT l.id, l.sku, l.product_name, l.qty_unit, l.qty_expected, l.qty_checked, l.unidad_mayor, l.factor_mayor, l.se_pesa,
              coalesce(sum(s.qty_units) FILTER (WHERE s.kind = 'mayor'), 0) AS cajas,
              coalesce(sum(s.qty_base) FILTER (WHERE s.kind = 'menor'), 0) AS sueltas
         FROM commercial.order_check_lines l
         LEFT JOIN commercial.check_scans s ON s.check_id = l.check_id AND s.line_id = l.id AND s.undone_at IS NULL
        WHERE l.check_id = ?
        GROUP BY l.id
        ORDER BY l.product_name, l.sku`,
      [checkId],
    );
    const renglones: ChecadoRenglon[] = (ls as Array<Linea & { cajas: string; sueltas: string }>).map((l) => {
      const esperado = Number(l.qty_expected);
      const checado = Number(l.qty_checked);
      const f = l.factor_mayor == null ? null : Number(l.factor_mayor);
      const cajasEsp = f && f > 0 ? esperado / f : null;
      return {
        id: l.id,
        sku: l.sku,
        producto: l.product_name,
        unidad: l.qty_unit,
        esperado,
        checado,
        unidad_mayor: l.unidad_mayor,
        factor_mayor: f,
        esperado_mayor: cajasEsp !== null && Math.abs(cajasEsp - Math.round(cajasEsp)) <= TOL ? Math.round(cajasEsp) : null,
        checado_mayor: Number(l.cajas) || 0,
        checado_sueltas: r3(Number(l.sueltas) || 0),
        se_pesa: !!l.se_pesa,
        estado: estadoRenglon(esperado, checado, !!l.se_pesa),
      };
    });

    const { rows: cajas } = await trx.raw(
      `SELECT c.id, c.numero, c.status, s.sku, l.product_name, s.unidad, sum(s.qty_units) AS cantidad
         FROM commercial.check_packages c
         LEFT JOIN commercial.check_scans s ON s.package_id = c.id AND s.undone_at IS NULL
         LEFT JOIN commercial.order_check_lines l ON l.id = s.line_id
        WHERE c.check_id = ?
        GROUP BY c.id, c.numero, c.status, s.sku, l.product_name, s.unidad
        ORDER BY c.numero, l.product_name`,
      [checkId],
    );
    const porCaja = new Map<string, ChecadoCajaP>();
    for (const r of cajas as Array<{ id: string; numero: number; status: 'abierta' | 'cerrada'; sku: string | null; product_name: string | null; unidad: string | null; cantidad: string | null }>) {
      const c = porCaja.get(r.id) ?? { id: r.id, numero: Number(r.numero), status: r.status, contenido: [] };
      if (r.cantidad != null && Number(r.cantidad) > 0) c.contenido.push({ sku: r.sku, producto: r.product_name, unidad: r.unidad, cantidad: r3(Number(r.cantidad)) });
      porCaja.set(r.id, c);
    }

    const ultimo = await trx('commercial.check_scans as s')
      .leftJoin('commercial.order_check_lines as l', 'l.id', 's.line_id')
      .where('s.check_id', checkId)
      .whereNull('s.undone_at')
      .orderBy('s.scanned_at', 'desc')
      .first('s.id', 's.unidad', 's.qty_units', 's.kind', 's.sku', 'l.product_name');

    return {
      id: chk.id,
      order_code: chk.order_code,
      destino: chk.destino_nombre,
      sucursal: chk.sucursal,
      warehouse_id: chk.warehouse_id,
      started_at: new Date(chk.started_at).toISOString(),
      renglones,
      cajas_p: [...porCaja.values()],
      ultimo_escaneo: ultimo ? { id: ultimo.id, producto: ultimo.product_name ?? ultimo.sku, unidad: ultimo.unidad, cantidad: Number(ultimo.qty_units), kind: ultimo.kind } : null,
    };
  }
}
