import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  diaMxDeInstante,
  etiquetasDelRenglon,
  fechaKepler,
  totalEtiquetas,
  validarPedidoImpresion,
  type BoxLabelCatalogDefect,
  type BoxLabelMotivo,
  type BoxLabelOrdersResponse,
  type BoxLabelPrintRequest,
  type BoxLabelPrintResponse,
  type EtiquetaCaja,
} from '@megadulces/contracts';
import { armarDefectos, armarOrdenes, type FilaBitacora, type FilaVista } from './box-labels';

/** Para el aviso de deprecación de los alias de query param del alcance. */
const RUTA = 'commercial/receiving/box-labels';
/** Un mes de toda la red son ~4,800 renglones: el rango se acota para que la cola nunca se corte en silencio. */
const MAX_DIAS = 31;
const MAX_FILAS = 8000;

/** Columnas de `analytics.v_box_label_lines` en la forma del contrato. Fechas como texto: sin corrimiento de zona. */
const COLS = `sucursal, sucursal_nombre, serie, folio, linea, sku, nombre, unidad, unidad_base,
  uxc::float8 AS uxc, cajas::float8 AS cajas, cajas_completas, piezas_sueltas::float8 AS piezas_sueltas, codigo,
  kepler_unidad_caja, kepler_factor_caja::float8 AS kepler_factor_caja, kepler_codigo_caja, sin_catalogo,
  to_char(capturada_el, 'YYYY-MM-DD') AS capturada_el, capturada_hora, to_char(fecha_documento, 'YYYY-MM-DD') AS fecha_documento,
  vale_folio, to_char(vale_capturado_el, 'YYYY-MM-DD') AS vale_capturado_el`;

/** Un registro de la bitácora tal como sale de la tabla. */
interface RegistroBitacora {
  linea: number;
  sku: string;
  nombre: string | null;
  unidad: string;
  unidad_base: string | null;
  uxc: string | number | null;
  cajas_completas: number;
  piezas_sueltas: string | number;
  total_etiquetas: number;
  codigo: string;
  sucursal_nombre: string | null;
  fecha_etiqueta: string;
  dia_impresion: string;
  orden_capturada_el: string | null;
  vale_folio: string | null;
  vale_capturado_el: string | null;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const sumarDias = (dia: string, n: number): string => {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const diasEntre = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * `[RE.ETQ.2.1–2.3]` Etiquetas de caja de la orden de entrada (Fase RE, D1).
 *
 *  · La cola y los defectos se LEEN de `analytics.v_box_label_lines` (derive-no-copy sobre el ODS de Kepler).
 *  · Imprimir ESCRIBE la bitácora `commercial.box_label_prints` y devuelve las etiquetas: la primera vez las
 *    calcula con la fecha de HOY en la Ciudad de México y el reloj del SERVIDOR (D6); la reimpresión devuelve los
 *    datos congelados de la primera, para que la etiqueta de reemplazo sea igual a sus hermanas.
 *  · Alcance: cada quien ve y escribe sólo su sucursal (ScopeService, ADR-050).
 */
@Injectable()
export class BoxLabelsService {
  private readonly logger = new Logger(BoxLabelsService.name);

  constructor(
    private readonly tenantKnex: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** El rango pedido, o los últimos `dias` días de la Ciudad de México. */
  rango(query: Record<string, unknown> | undefined, dias: number): { desde: string; hasta: string } {
    const hoy = diaMxDeInstante(new Date()) as string;
    const hasta = typeof query?.['date_to'] === 'string' && query['date_to'] ? String(query['date_to']) : hoy;
    const desde = typeof query?.['date_from'] === 'string' && query['date_from'] ? String(query['date_from']) : sumarDias(hasta, -(dias - 1));
    if (!DIA.test(desde) || !DIA.test(hasta)) throw new BadRequestException('Las fechas van como AAAA-MM-DD.');
    if (desde > hasta) throw new BadRequestException('La fecha inicial es posterior a la final.');
    if (diasEntre(desde, hasta) >= MAX_DIAS) throw new BadRequestException(`El rango máximo es de ${MAX_DIAS} días.`);
    return { desde, hasta };
  }

  private async filasDeLaVista(trx: Knex, desde: string, hasta: string, sucursales: string[] | null): Promise<FilaVista[]> {
    const params: Knex.RawBinding[] = [desde, hasta];
    let filtro = '';
    if (sucursales) {
      filtro = 'AND sucursal = ANY(?)';
      params.push(sucursales);
    }
    params.push(MAX_FILAS + 1);
    const { rows } = await trx.raw(
      `/* re-etq:cola */ SELECT ${COLS} FROM analytics.v_box_label_lines
        WHERE capturada_el BETWEEN ?::date AND ?::date ${filtro}
        ORDER BY capturada_el DESC, folio, linea LIMIT ?`,
      params,
    );
    if (rows.length > MAX_FILAS) {
      // Nunca se corta en silencio (ADR-056): se pide acotar.
      throw new BadRequestException(`Hay más de ${MAX_FILAS} renglones en ese rango: acótalo por fecha o por sucursal.`);
    }
    return rows as FilaVista[];
  }

  /** `GET orders` — la cola de órdenes de entrada con su estado de etiquetado. */
  async ordenes(query: Record<string, unknown> | undefined): Promise<BoxLabelOrdersResponse> {
    const { desde, hasta } = this.rango(query, 7);
    const sucursales = await this.scope.readParam(query, 'warehouse', RUTA);
    const base = { date_from: desde, date_to: hasta, sucursales, generado_at: new Date().toISOString() };
    if (sucursales && !sucursales.length) return { ...base, ordenes: [], ods_ultima_captura: null };
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tenantKnex.run(async (trx) => {
      const filas = await this.filasDeLaVista(trx, desde, hasta, sucursales);
      let bitacora: FilaBitacora[] = [];
      if (filas.length) {
        const sucs = [...new Set(filas.map((f) => f.sucursal))];
        const folios = [...new Set(filas.map((f) => f.folio))];
        bitacora = (
          await trx.raw(
            `/* re-etq:bitacora */ SELECT sucursal, serie, folio, linea, motivo, consecutivos, fecha_etiqueta, enviada_por,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS enviada_at
               FROM commercial.box_label_prints
              WHERE tenant_id = ? AND sucursal = ANY(?) AND folio = ANY(?)
              ORDER BY created_at`,
            [tenantId, sucs, folios],
          )
        ).rows as FilaBitacora[];
      }
      // Frescura (ADR-056): la última orden de entrada que trajo el ODS, en la hora de Kepler (CDMX).
      const odsParams: Knex.RawBinding[] = [hasta];
      if (sucursales) odsParams.push(sucursales);
      const ods = (
        await trx.raw(
          `/* re-etq:frescura */ SELECT to_char(max(c68::date + CASE WHEN btrim(coalesce(c69, '')) ~ '^[0-9]{1,2}:[0-9]{2}$'
                    THEN btrim(c69)::time ELSE time '00:00' END), 'YYYY-MM-DD"T"HH24:MI') AS u
             FROM kepler_ods.kdm1
            WHERE c2 = 'X' AND c3 = 'A' AND c4 = 40 AND c68::date >= (?::date - 7) ${sucursales ? 'AND sucursal = ANY(?)' : ''}`,
          odsParams,
        )
      ).rows[0]?.u ?? null;
      return { ...base, ordenes: armarOrdenes(filas, bitacora), ods_ultima_captura: ods };
    });
  }

  /** `GET catalog-defects` — lo que el catálogo de Kepler tiene mal en lo recibido (lista para Compras). */
  async defectos(query: Record<string, unknown> | undefined): Promise<{ defectos: BoxLabelCatalogDefect[]; date_from: string; date_to: string }> {
    const { desde, hasta } = this.rango(query, 30);
    const sucursales = await this.scope.readParam(query, 'warehouse', RUTA);
    if (sucursales && !sucursales.length) return { defectos: [], date_from: desde, date_to: hasta };
    const filas = await this.tenantKnex.run((trx) => this.filasDeLaVista(trx, desde, hasta, sucursales));
    return { defectos: armarDefectos(filas), date_from: desde, date_to: hasta };
  }

  /**
   * `POST prints` — registra el envío a la impresora y devuelve las etiquetas a dibujar. ⚠️ «Enviada» no es
   * «impresa»: el navegador no distingue imprimir de cancelar, y la bitácora no lo afirma.
   */
  async imprimir(body: BoxLabelPrintRequest): Promise<BoxLabelPrintResponse> {
    const problema = validarPedidoImpresion(body);
    if (problema) throw new BadRequestException(problema);
    await this.scope.assertCanWrite('warehouse', body.sucursal);
    const tenantId = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const usuario = ctx?.username ?? null;
    const usuarioId = ctx?.userId ?? null;
    const ahora = new Date();
    const fechaHoy = fechaKepler(ahora);
    const diaHoy = diaMxDeInstante(ahora);
    if (!fechaHoy || !diaHoy) throw new Error('[RE.ETQ] no se pudo calcular la fecha de hoy en la Ciudad de México');
    const serie = Number(body.serie);
    const folio = String(body.folio).trim();
    const lineas = [...new Set(body.renglones.map((r) => Number(r.linea)))];

    return this.tenantKnex.run(async (trx) => {
      const filas = (
        await trx.raw(
          `/* re-etq:imprimir */ SELECT ${COLS} FROM analytics.v_box_label_lines
            WHERE sucursal = ? AND serie = ? AND folio = ? AND linea = ANY(?)`,
          [body.sucursal, serie, folio, lineas],
        )
      ).rows as FilaVista[];
      const porLinea = new Map(filas.map((f) => [Number(f.linea), f]));
      const faltan = lineas.filter((l) => !porLinea.has(l));
      if (faltan.length) {
        throw new NotFoundException(
          `La orden ${folio} de la sucursal ${body.sucursal} no tiene renglones con etiqueta en la línea ${faltan.join(', ')} (o la orden no está en Kepler).`,
        );
      }

      const etiquetas: EtiquetaCaja[] = [];
      const registros: BoxLabelPrintResponse['registros'] = [];
      for (const pedido of body.renglones) {
        const linea = Number(pedido.linea);
        const fila = porLinea.get(linea) as FilaVista;
        let primera = await this.primera(trx, tenantId, body.sucursal, serie, folio, linea);
        let motivo: BoxLabelMotivo = 'reimpresion';
        if (!primera) {
          const total = totalEtiquetas(fila);
          const consecutivos = elegir(pedido.consecutivos, total);
          const insertada = (
            await trx.raw(
              `INSERT INTO commercial.box_label_prints
                 (tenant_id, sucursal, serie, folio, linea, motivo, via, consecutivos, sku, nombre, unidad, unidad_base, uxc,
                  cajas_completas, piezas_sueltas, total_etiquetas, codigo, sucursal_nombre, fecha_etiqueta, dia_impresion,
                  orden_capturada_el, vale_folio, vale_capturado_el, enviada_por, created_by, updated_by)
               VALUES (?, ?, ?, ?, ?, 'primera', ?, ?::int[], ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?::date, ?, ?::date, ?, ?, ?)
               ON CONFLICT (tenant_id, sucursal, serie, folio, linea) WHERE motivo = 'primera' DO NOTHING
               RETURNING linea`,
              [
                tenantId, body.sucursal, serie, folio, linea, body.via, consecutivos, fila.sku, fila.nombre, fila.unidad, fila.unidad_base,
                fila.uxc, fila.cajas_completas, fila.piezas_sueltas, total, fila.codigo, fila.sucursal_nombre, fechaHoy, diaHoy,
                fila.capturada_el, fila.vale_folio, fila.vale_capturado_el, usuario, usuarioId, usuarioId,
              ],
            )
          ).rows;
          primera = await this.primera(trx, tenantId, body.sucursal, serie, folio, linea);
          if (insertada.length && primera) {
            motivo = 'primera';
            etiquetas.push(...etiquetasDelRenglon(aRenglon(primera, body.sucursal), primera.fecha_etiqueta, consecutivos));
            registros.push({ linea, motivo, fecha_etiqueta: primera.fecha_etiqueta, consecutivos });
            continue;
          }
          // Otra persona la registró en el mismo instante: ésta es una reimpresión de aquélla.
          this.logger.warn(`[RE.ETQ] ${body.sucursal}/${folio}/${linea}: la primera la registró otra solicitud simultánea`);
        }
        if (!primera) throw new Error(`[RE.ETQ] no se encontró la primera impresión de ${body.sucursal}/${folio}/${linea}`);
        const consecutivos = elegir(pedido.consecutivos, Number(primera.total_etiquetas));
        await trx.raw(
          `INSERT INTO commercial.box_label_prints
             (tenant_id, sucursal, serie, folio, linea, motivo, via, consecutivos, sku, nombre, unidad, unidad_base, uxc,
              cajas_completas, piezas_sueltas, total_etiquetas, codigo, sucursal_nombre, fecha_etiqueta, dia_impresion,
              orden_capturada_el, vale_folio, vale_capturado_el, enviada_por, created_by, updated_by)
           SELECT tenant_id, sucursal, serie, folio, linea, 'reimpresion', ?, ?::int[], sku, nombre, unidad, unidad_base, uxc,
                  cajas_completas, piezas_sueltas, total_etiquetas, codigo, sucursal_nombre, fecha_etiqueta, dia_impresion,
                  orden_capturada_el, vale_folio, vale_capturado_el, ?, ?, ?
             FROM commercial.box_label_prints
            WHERE tenant_id = ? AND sucursal = ? AND serie = ? AND folio = ? AND linea = ? AND motivo = 'primera'`,
          [body.via, consecutivos, usuario, usuarioId, usuarioId, tenantId, body.sucursal, serie, folio, linea],
        );
        etiquetas.push(...etiquetasDelRenglon(aRenglon(primera, body.sucursal), primera.fecha_etiqueta, consecutivos));
        registros.push({ linea, motivo, fecha_etiqueta: primera.fecha_etiqueta, consecutivos });
      }
      return { etiquetas, registros };
    });
  }

  private async primera(trx: Knex, tenantId: string, sucursal: string, serie: number, folio: string, linea: number): Promise<RegistroBitacora | null> {
    const { rows } = await trx.raw(
      `SELECT linea, sku, nombre, unidad, unidad_base, uxc, cajas_completas, piezas_sueltas, total_etiquetas, codigo, sucursal_nombre,
              fecha_etiqueta, to_char(dia_impresion, 'YYYY-MM-DD') AS dia_impresion, to_char(orden_capturada_el, 'YYYY-MM-DD') AS orden_capturada_el,
              vale_folio, to_char(vale_capturado_el, 'YYYY-MM-DD') AS vale_capturado_el
         FROM commercial.box_label_prints
        WHERE tenant_id = ? AND sucursal = ? AND serie = ? AND folio = ? AND linea = ? AND motivo = 'primera'`,
      [tenantId, sucursal, serie, folio, linea],
    );
    return (rows[0] as RegistroBitacora | undefined) ?? null;
  }
}

/** Los consecutivos pedidos dentro de 1..total; sin pedido, todos. Vacío = error de quien pide. */
export function elegir(pedidos: readonly number[] | undefined, total: number): number[] {
  if (total < 1) throw new BadRequestException('Ese renglón no tiene cajas que etiquetar.');
  if (!pedidos || !pedidos.length) return Array.from({ length: total }, (_, i) => i + 1);
  const ok = [...new Set(pedidos.map((n) => Math.trunc(Number(n))))].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  if (!ok.length) throw new BadRequestException(`Ningún consecutivo pedido está entre 1 y ${total}.`);
  return ok;
}

/** Los datos congelados de la primera impresión, en la forma que dibuja la etiqueta. */
function aRenglon(p: RegistroBitacora, sucursal: string) {
  return {
    sku: p.sku,
    codigo: p.codigo,
    nombre: p.nombre,
    sucursal,
    sucursal_nombre: p.sucursal_nombre,
    uxc: p.uxc == null ? null : Number(p.uxc),
    cajas_completas: Number(p.cajas_completas),
    piezas_sueltas: Number(p.piezas_sueltas),
    unidad_base: p.unidad_base,
  };
}
