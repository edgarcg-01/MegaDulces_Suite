import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  ChecadoCajaP,
  ChecadoCerrarCajaResponse,
  ChecadoEscaneoResponse,
  ChecadoEtiquetaCJ,
  ChecadoEtiquetaP,
  ChecadoPedido,
  ChecadoRenglon,
  ChecadoTerminarResponse,
  ChecadoTomarResponse,
  ConsolaSurtidoAlmacen,
} from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { PickingCapturaService } from './picking-captura.service';
import { PickingConsolaService } from './picking-consola.service';
import { resolverCodigo, unidadMayor, type KdiiFila } from './checado-codigo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana de surtidos que se ofrecen para checar (igual que la bandeja de Facturación). */
const DIAS = 30;
const TOL = 0.001;
/** En kilos la báscula y Kepler no coinciden al gramo: medio por ciento de holgura. */
const TOL_PESO = 0.005;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

interface LineaSql {
  id: string;
  sku: string | null;
  product_name: string | null;
  qty_unit: string | null;
  qty_expected: string;
  qty_checked: string;
  unidad_mayor: string | null;
  factor_mayor: string | null;
  se_pesa: boolean;
  cajas: string | null;
}

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

/**
 * Las etiquetas de unidad mayor, numeradas sobre TODO el pedido: "1/7 … 7/7" (decisión de
 * Francisco, 2026-10-08). Una por caja escaneada; una caja sin etiqueta tecleada como "3 cajas"
 * da tres.
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

/**
 * `[GP.4]` **El checado** (`FASE_GP` §9).
 *
 * El checador toca "Tomar siguiente" y recibe el pedido más urgente que:
 *  · ya se surtió en la Suite;
 *  · Facturación ya pasó a **SURTIDO en Kepler** y cuadra con lo surtido (GP.3d): se checa contra
 *    el pedido ya corregido, y Kepler no se queda atrás;
 *  · **él no surtió** (P4: el checador es siempre otra persona). Lo cuida el sistema por pedido.
 *
 * Luego **rastrilla**: cada escaneo se resuelve contra el catálogo de Kepler de la sucursal. La
 * caja (unidad mayor) cuenta como una caja y valida el surtido; la paquetería cae en la **caja P
 * abierta**, y así queda escrito qué va en cada caja. Al cerrar la caja P sale su etiqueta (por
 * triplicado, rollo de 3); al terminar salen las de unidad mayor "1/7…". Lo checado es lo que sale
 * (P7). Nada de esto escribe en Kepler (ADR-086).
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
      const mio = await trx('commercial.order_checks')
        .where({ assigned_to: userId, status: 'en_checado' })
        .orderBy('started_at')
        .first('id');
      return mio ? this.cargar(trx, mio.id) : null;
    });
  }

  async tomarSiguiente(dto: { warehouse_id: string; origen?: string }): Promise<ChecadoTomarResponse> {
    const userId = this.usuario();
    const alm = await this.almacenParaEscribir(dto?.warehouse_id);
    const origen = dto?.origen ? String(dto.origen).toUpperCase() : null;

    return this.tk.run(async (trx) => {
      // Un checador, un pedido: dos toques seguidos no le dan dos pedidos.
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`gp4-checador:${userId}`]);
      const mio = await trx('commercial.order_checks')
        .where({ assigned_to: userId, status: 'en_checado' })
        .orderBy('started_at')
        .first('id');
      if (mio) return { estado: 'asignado', ya_era_tuyo: true, pedido: await this.cargar(trx, mio.id) };

      // Candidatos en el MISMO orden que la fila del surtidor: urgente → salida más próxima → lo
      // que terminó antes. Quien pide no surtió nada de ese pedido (ni la ola, ni un renglón suyo).
      const { rows: candidatos } = await trx.raw(
        `SELECT wo.order_id, pw.id AS wave_id, wo.kepler_sucursal, wo.kepler_serie, wo.kepler_folio, wo.destino_nombre,
                (SELECT wol.order_code FROM commercial.wave_order_lines wol
                  WHERE wol.wave_id = pw.id AND wol.order_id = wo.order_id LIMIT 1) AS order_code
           FROM commercial.picking_waves pw
           JOIN commercial.wave_orders wo ON wo.wave_id = pw.id AND wo.source = 'kepler'
          WHERE pw.warehouse_id = ? AND pw.status = 'surtida'
            AND pw.finished_at >= now() - (? || ' days')::interval
            AND (?::text IS NULL OR pw.origen = ?::text)
            AND EXISTS (SELECT 1 FROM commercial.wave_order_lines wol WHERE wol.wave_id = pw.id AND wol.order_id = wo.order_id)
            AND NOT EXISTS (SELECT 1 FROM commercial.order_checks oc WHERE oc.order_id = wo.order_id AND oc.status <> 'cancelado')
            AND pw.picked_by IS DISTINCT FROM ?::uuid
            AND NOT EXISTS (
                  SELECT 1 FROM commercial.wave_lines wl
                    JOIN commercial.wave_allocations wa ON wa.wave_id = wl.wave_id AND wa.product_id = wl.product_id
                   WHERE wl.wave_id = pw.id AND wa.order_id = wo.order_id AND wl.picked_by = ?::uuid)
          ORDER BY pw.prioridad DESC,
                   (SELECT min(d.hora_salida) FROM commercial.picking_departures d
                     WHERE d.warehouse_id = pw.warehouse_id
                       AND d.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date
                       AND d.destino_code = wo.destino_code) ASC NULLS LAST,
                   pw.finished_at, wo.order_id
          LIMIT 60`,
        [alm.id, DIAS, origen, origen, userId, userId],
      );
      const lista = candidatos as Array<{ order_id: string; wave_id: string; kepler_sucursal: string; kepler_serie: number; kepler_folio: string; destino_nombre: string | null; order_code: string | null }>;
      const estados = await this.captura.estadosDe(trx, lista.map((c) => c.order_id));

      let esperando = 0;
      for (const c of lista) {
        const e = estados.get(c.order_id);
        if (!e) continue;
        if (e.estado !== 'capturado' || e.estatus !== 'SURTIDO') {
          if (e.estado === 'por_capturar' || e.estado === 'por_avanzar' || e.estado === 'con_diferencias') esperando += 1;
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

      return {
        estado: 'sin_trabajo',
        motivo: esperando
          ? `Hay ${esperando === 1 ? '1 pedido surtido esperando' : `${esperando} pedidos surtidos esperando`} a que Facturación ${esperando === 1 ? 'lo pase' : 'los pase'} a SURTIDO en Kepler.`
          : 'No hay pedidos surtidos por checar en esta sucursal.',
        esperando_facturacion: esperando,
      };
    });
  }

  async escanear(checkId: string, dto: { code?: string; cantidad?: number; peso_kg?: number }): Promise<ChecadoEscaneoResponse> {
    const code = String(dto?.code ?? '').trim();
    if (!code || code.length > 40) throw new BadRequestException('Escanea o escribe un código.');
    const cantidad = dto?.cantidad == null ? 1 : Number(dto.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) throw new BadRequestException('La cantidad va de 1 a 999.');
    const peso = dto?.peso_kg == null ? null : Number(dto.peso_kg);
    if (peso !== null && (!Number.isFinite(peso) || peso <= 0 || peso > 5000)) throw new BadRequestException('El peso no es válido.');
    const userId = this.usuario();

    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      const lineas = (await trx('commercial.order_check_lines').where({ check_id: chk.id })) as Array<{ id: string; sku: string | null; product_name: string | null; qty_unit: string | null; qty_expected: string; qty_checked: string; factor_mayor: string | null; se_pesa: boolean }>;
      const porSku = new Map(lineas.filter((l) => l.sku).map((l) => [String(l.sku), l]));

      const filas = await this.kdiiPorCodigo(trx, chk.sucursal, code);
      const res = resolverCodigo(code, filas, new Set(porSku.keys()));
      if (res.tipo === 'desconocido') {
        return { resultado: 'desconocido', mensaje: `El código ${code} no está en el catálogo de Kepler de esta sucursal.`, producto: null, pedido: await this.cargar(trx, chk.id) };
      }
      if (res.tipo === 'ambiguo') {
        return { resultado: 'ambiguo', mensaje: `El código ${code} lo tienen varios productos (${res.candidatos.join(', ')}). Escanea otra etiqueta del producto.`, producto: null, pedido: await this.cargar(trx, chk.id) };
      }
      const r = res.resuelto;
      const linea = porSku.get(r.sku);

      if (!linea) {
        await trx('commercial.check_scans').insert({
          check_id: chk.id, code, sku: r.sku, unidad: r.unidad, factor: r.factor,
          qty_units: cantidad, qty_base: r3(cantidad * r.factor), kind: 'ajeno', scanned_by: userId,
        });
        return { resultado: 'ajeno', mensaje: `${r.nombre ?? r.sku} no va en este pedido. Sepáralo.`, producto: r.nombre, pedido: await this.cargar(trx, chk.id) };
      }

      // Se vende por kilo y se escaneó suelto (unidad base): manda la báscula.
      let qtyBase = r3(cantidad * r.factor);
      if (linea.se_pesa && r.factor === 1) {
        if (peso === null) {
          return { resultado: 'pide_peso', mensaje: `Pesa ${linea.product_name ?? r.sku} y escribe los kilos.`, producto: linea.product_name, pedido: await this.cargar(trx, chk.id) };
        }
        qtyBase = r3(peso);
      }

      const factorMayor = linea.factor_mayor == null ? 0 : Number(linea.factor_mayor);
      const kind: 'mayor' | 'menor' = factorMayor > 1 && Math.abs(r.factor - factorMayor) <= TOL ? 'mayor' : 'menor';
      const paquete = kind === 'menor' ? await this.cajaAbierta(trx, chk.id, userId) : null;

      await trx('commercial.check_scans').insert({
        check_id: chk.id, line_id: linea.id, package_id: paquete, code, sku: r.sku, unidad: r.unidad, factor: r.factor,
        qty_units: cantidad, qty_base: qtyBase, kind, weight_kg: linea.se_pesa && r.factor === 1 ? qtyBase : null, scanned_by: userId,
      });
      const nuevo = r3(Number(linea.qty_checked) + qtyBase);
      await trx('commercial.order_check_lines').where({ id: linea.id }).update({ qty_checked: nuevo, updated_at: trx.fn.now() });

      const esperado = Number(linea.qty_expected);
      const sobra = nuevo > esperado && !cuadraChecado(esperado, nuevo, linea.se_pesa);
      const cuanto = linea.se_pesa && r.factor === 1 ? `${qtyBase} kg` : `${cantidad} ${r.unidad ?? ''}`.trim();
      return {
        resultado: sobra ? 'sobra' : 'ok',
        mensaje: sobra
          ? `Sobra ${linea.product_name ?? r.sku}: van ${nuevo} ${linea.qty_unit ?? ''} de ${esperado}. Regresa lo que sobra.`
          : `+${cuanto} · ${linea.product_name ?? r.sku}${kind === 'menor' ? ' (a la caja P abierta)' : ''}`,
        producto: linea.product_name,
        pedido: await this.cargar(trx, chk.id),
      };
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
        await trx.raw(
          `UPDATE commercial.order_check_lines SET qty_checked = GREATEST(0, qty_checked - ?), updated_at = now() WHERE id = ?`,
          [Number(scan.qty_base), scan.line_id],
        );
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

  async terminar(checkId: string, dto: { wait_location?: string | null }): Promise<ChecadoTerminarResponse> {
    const userId = this.usuario();
    const espera = dto?.wait_location ? String(dto.wait_location).trim().slice(0, 40) : null;
    return this.tk.run(async (trx) => {
      const chk = await this.checadoMio(trx, checkId, userId);
      const etiquetaP = await this.cerrarAbierta(trx, chk);
      // Una caja P abierta y vacía no se queda colgada.
      await trx('commercial.check_packages').where({ check_id: chk.id, status: 'abierta' }).del();

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
        etiquetas_cj: etiquetasCJ(pedido.renglones.map((l) => ({ sku: l.sku, producto: l.producto, unidad: l.unidad_mayor, cajas: l.checado_mayor }))),
        etiqueta_p: etiquetaP,
        cajas_p: cajasP,
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
  private async checadoMio(trx: Knex.Transaction, checkId: string, userId: string) {
    if (!UUID_RE.test(checkId || '')) throw new BadRequestException('Checado inválido.');
    const chk = await trx('commercial.order_checks as oc')
      .join('commercial.warehouses as w', 'w.id', 'oc.warehouse_id')
      .where('oc.id', checkId)
      .forUpdate('oc')
      .first('oc.id', 'oc.status', 'oc.assigned_to', 'oc.order_code', 'oc.destino_nombre', trx.raw('btrim(w.code) AS sucursal'));
    if (!chk) throw new NotFoundException('Checado no encontrado.');
    if (chk.assigned_to !== userId) throw new ConflictException('Este pedido lo está checando otra persona.');
    if (chk.status !== 'en_checado') throw new ConflictException(`Este checado ya está ${chk.status}.`);
    return chk as { id: string; status: string; assigned_to: string; order_code: string; destino_nombre: string | null; sucursal: string };
  }

  /** La caja P abierta del checado; si no hay, abre la siguiente (P1, P2…). */
  private async cajaAbierta(trx: Knex.Transaction, checkId: string, userId: string): Promise<string> {
    const abierta = await trx('commercial.check_packages').where({ check_id: checkId, status: 'abierta' }).first('id');
    if (abierta) return abierta.id;
    const { rows } = await trx.raw(`SELECT coalesce(max(numero), 0) + 1 AS n FROM commercial.check_packages WHERE check_id = ?`, [checkId]);
    const [nueva] = await trx('commercial.check_packages')
      .insert({ check_id: checkId, numero: Number(rows[0].n), created_by: userId })
      .returning('id');
    return (nueva as { id: string }).id;
  }

  /** Cierra la caja P abierta si lleva algo, y devuelve su etiqueta. null = no había o iba vacía. */
  private async cerrarAbierta(
    trx: Knex.Transaction,
    chk: { id: string; order_code: string; destino_nombre: string | null },
  ): Promise<ChecadoEtiquetaP | null> {
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
    return {
      id: caja.id,
      numero: Number(caja.numero),
      order_code: chk.order_code,
      destino: chk.destino_nombre,
      articulos: r3(Number(rows[0].articulos)),
      productos: Number(rows[0].productos),
    };
  }

  /** Los renglones del checado: lo surtido (ya en Kepler) + la caja del producto en Kepler. */
  private async crearRenglones(trx: Knex.Transaction, checkId: string, waveId: string, orderId: string, sucursal: string): Promise<void> {
    const { rows } = await trx.raw(
      `SELECT wol.product_id, p.sku, p.nombre, wol.qty_unit, coalesce(wa.qty_allocated, 0) AS esperado, wl.picked_by
         FROM commercial.wave_order_lines wol
         LEFT JOIN catalog.products p ON p.id = wol.product_id
         LEFT JOIN commercial.wave_allocations wa
                ON wa.wave_id = wol.wave_id AND wa.order_id = wol.order_id AND wa.product_id = wol.product_id
         LEFT JOIN commercial.wave_lines wl ON wl.wave_id = wol.wave_id AND wl.product_id = wol.product_id
        WHERE wol.wave_id = ? AND wol.order_id = ?`,
      [waveId, orderId],
    );
    const renglones = (rows as Array<{ product_id: string; sku: string | null; nombre: string | null; qty_unit: string | null; esperado: string; picked_by: string | null }>)
      .filter((r) => Number(r.esperado) > TOL);
    const skus = renglones.map((r) => r.sku).filter((s): s is string => !!s);
    const kdii = new Map((await this.kdiiPorSku(trx, sucursal, skus)).map((f) => [f.sku, f]));
    if (!renglones.length) return;
    await trx('commercial.order_check_lines').insert(
      renglones.map((r) => {
        const f = r.sku ? kdii.get(r.sku) : undefined;
        const mayor = f ? unidadMayor(f) : null;
        return {
          check_id: checkId,
          product_id: r.product_id,
          sku: r.sku,
          product_name: (r.nombre ?? f?.nombre ?? '').slice(0, 200) || null,
          qty_unit: r.qty_unit,
          qty_expected: Number(r.esperado),
          unidad_mayor: mayor?.unidad ?? null,
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
        ORDER BY btrim(c1)`,
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
        ORDER BY btrim(c1)`,
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
              (SELECT coalesce(sum(s.qty_units), 0) FROM commercial.check_scans s
                WHERE s.line_id = l.id AND s.kind = 'mayor' AND s.undone_at IS NULL) AS cajas
         FROM commercial.order_check_lines l
        WHERE l.check_id = ?
        ORDER BY l.product_name, l.sku`,
      [checkId],
    );
    const renglones: ChecadoRenglon[] = (ls as LineaSql[]).map((l) => {
      const esperado = Number(l.qty_expected);
      const checado = Number(l.qty_checked);
      const f = l.factor_mayor == null ? null : Number(l.factor_mayor);
      const cajasEsp = f && f > 1 ? esperado / f : null;
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
      if (r.cantidad != null && Number(r.cantidad) > 0) {
        c.contenido.push({ sku: r.sku, producto: r.product_name, unidad: r.unidad, cantidad: r3(Number(r.cantidad)) });
      }
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
      ultimo_escaneo: ultimo
        ? { id: ultimo.id, producto: ultimo.product_name ?? ultimo.sku, unidad: ultimo.unidad, cantidad: Number(ultimo.qty_units), kind: ultimo.kind }
        : null,
    };
  }
}
