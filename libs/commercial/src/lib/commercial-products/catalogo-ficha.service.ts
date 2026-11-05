import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { Permission, TenantKnexService, isPlatformAdminRole, todayMx } from '@megadulces/platform-core';
import { aplicarBusquedaCatalogo, ordenListaCatalogo, razonDeCoincidencia } from './catalogo-busqueda';
import {
  armarConteos,
  armarSucursales,
  armarUltimoCosto,
  armarUnidades,
  costoSinImpuestos,
  descripcionDistinta,
  mostrarValido,
  num,
  ordenarCodigos,
  periodoFicha,
  precioDeRed,
  sucursalValida,
  type CatalogoFila,
  type CatalogoLista,
  type EntradaCruda,
  type EscaleraCruda,
  type FichaProducto,
  type MostrarCatalogo,
  type PrecioCrudo,
  type SucursalCruda,
} from './catalogo-ficha';
import {
  CODIGOS_SQL,
  ESCALERA_SQL,
  LABEL_POR_SUCURSAL_SQL,
  N_CODIGOS_LATERAL_SQL,
  PRECIOS_RED_SQL,
  PRECIOS_SUCURSAL_SQL,
  PRODUCTO_SQL,
  SIN_PRECIO_LATERAL_SQL,
  SUCURSALES_SQL,
  ULTIMAS_ENTRADAS_SQL,
  VENTA_PERIODO_SQL,
} from './catalogo-ficha.sql';
import { EXISTENCIA_KEPLER_SQL } from './new-products.sql';
import type { FilaUniverso } from './catalogo-detallado';
import { SIN_PROVEEDOR_EXPR } from './catalogo-detallado.sql';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Escalera = EscaleraCruda & { sku: string };
type Precio = PrecioCrudo & { product_id: string };
type Entrada = EntradaCruda & { sku: string };

/**
 * `[PF.12.3]` Tope de la lectura del último costo en la lista. La lista entera tiene que salir en < 1 s; medido en
 * local (2026-10-30, página 1, sucursales 01 y 02) lo demás tarda 330–670 ms y esta lectura 6–17 ms. Más de esto
 * = «Sin dato» en la columna, y la lista a tiempo.
 */
const COSTO_TOPE_MS = 300;

/** Lo que `RolesGuard` deja en `req.user` (el mapa de permisos fresco de la base). */
export interface UsuarioConPermisos {
  permissions?: Record<string, boolean>;
  role_name?: string;
}

/**
 * `[PF.12.3]` QUIÉN VE EL ÚLTIMO COSTO DE COMPRA EN EL CATÁLOGO: las listas Sencillo y Detallado, la «Última
 * entrada» de la ficha Sencillo y el «Costo de la última» de la ficha Detallado. Una sola regla para las cuatro:
 * si una lo muestra y otra no, la pantalla se contradice.
 *
 * Decisión de David (dueño del pedido), 2026-10-30, extendida a Detallado el 2026-11-03: **todo el que ve el
 * catálogo** (`COMMERCIAL_PRODUCTS_VER`), no sólo quien tiene `COMPRAS_COSTO_ESTANDAR_VER`. Se le advirtió que
 * es dato sensible y lo confirmó. ⚠️ Cambiar quién lo ve es ESTA línea. Lo demás que muestra costo (el MARGEN de
 * Detallado, Costos, Productos nuevos, Flujo) sigue con `COMPRAS_COSTO_ESTANDAR_VER` y no pasa por aquí.
 *
 * ⛔ `[PF.20]` El CLIENTE EXTERNO nunca: `COMMERCIAL_PRODUCTS_VER` también lo tiene `customer_b2b` (medido en prod
 * el 2026-10-16, ver `precios-catalogo.service.ts` › `sinMargenParaCliente`). La decisión de David fue para la gente
 * de la empresa que ve el catálogo; darle a un cliente lo que pagamos por el producto nadie lo decidió.
 */
export function puedeVerCostoCatalogo(user: UsuarioConPermisos | null | undefined): boolean {
  // Sin distinguir mayúsculas: `users.role_name` puede venir con otra capitalización (datos heredados, ver login-core).
  if (String(user?.role_name ?? '').trim().toLowerCase() === 'customer_b2b') return false;
  return user?.permissions?.[Permission.COMMERCIAL_PRODUCTS_VER] === true || isPlatformAdminRole(user?.role_name);
}

/**
 * Compras › Catálogo: la lista (búsqueda + unidades con precio de una sucursal) y la ficha de un producto
 * (precios, red, existencia y venta del mes por sucursal, última entrada). Sólo lectura, todo del ODS.
 */
@Injectable()
export class CatalogoFichaService {
  private readonly logger = new Logger(CatalogoFichaService.name);
  /** Se pregunta una vez por proceso: la columna llega con `[NORM.3]` y no se va. */
  private labelPorSucursal: boolean | null = null;

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Sin grano por sucursal (base sin `[NORM.3]`), la tabla trae UNA fila por producto que es la moda de
   * las plazas: no es el precio de ninguna sucursal en particular. Se declara «sin precio», no se presta.
   */
  private async conPrecioPorSucursal(trx: Knex.Transaction): Promise<boolean> {
    if (this.labelPorSucursal === null) {
      const { rows } = await trx.raw(LABEL_POR_SUCURSAL_SQL);
      this.labelPorSucursal = rows[0]?.por_sucursal === true;
      if (!this.labelPorSucursal) {
        this.logger.warn('commercial.product_label_prices sin columna sucursal: los precios del catálogo viajan como null');
      }
    }
    return this.labelPorSucursal;
  }

  /**
   * La lista. Mostrar (todos | varios_codigos | sin_codigo | sin_precio) se filtra AQUÍ, no en el navegador:
   * la lista es paginada. Los conteos son de la búsqueda entera, sin importar qué se muestra.
   *
   * `[PF.12.1]` Orden: lo vendible primero (`ordenListaCatalogo`). Sólo toca la consulta de los renglones;
   * los conteos y el total salen de `buscado` sin orden, así que no cambian.
   *
   * `[PF.12.3]` Con `verCosto` (lo decide `puedeVerCostoCatalogo`), cada renglón trae su último costo de compra:
   * UNA consulta más, sólo para los SKUs de la página. Sin él, ni se consulta.
   */
  async lista(
    q: { search?: string; sucursal?: string; page?: number; pageSize?: number; mostrar?: string },
    opts: { verCosto?: boolean; nuevos?: string[] | null } = {},
  ): Promise<CatalogoLista> {
    const verCosto = opts.verCosto === true;
    // [NP.22] Los ids en seguimiento de Productos nuevos, sólo para CONTARLOS (la lista la sirve Detallado).
    const nuevos = Array.isArray(opts.nuevos) ? opts.nuevos : null;
    const sucursal = sucursalValida(q.sucursal);
    const pageSize = Math.min(Math.max(Math.trunc(Number(q.pageSize)) || 50, 1), 200);
    const page = Math.max(Math.trunc(Number(q.page)) || 1, 1);
    const texto = (q.search ?? '').trim();

    return this.tk.run(async (trx) => {
      const conPrecio = await this.conPrecioPorSucursal(trx);
      const mostrar: MostrarCatalogo = mostrarValido(q.mostrar, conPrecio);
      const buscado = this.buscado(trx, texto, sucursal, conPrecio);
      // Con precio por sucursal se une el lateral `sp`, y con él se sabe barato quién tiene unidades.
      const orden = ordenListaCatalogo(texto, conPrecio);

      const base = buscado.clone();
      if (mostrar === 'varios_codigos') base.where('cc.n_codigos', '>=', 2);
      else if (mostrar === 'sin_codigo') base.where('cc.n_codigos', 0);
      else if (mostrar === 'sin_precio') base.whereRaw('sp.sin_precio');

      const [crudos, conteo, filas] = await Promise.all([
        buscado
          .clone()
          .clearSelect()
          .clearOrder()
          .select(
            trx.raw('count(*) AS todos'),
            trx.raw('count(*) FILTER (WHERE cc.n_codigos >= 2) AS varios'),
            trx.raw('count(*) FILTER (WHERE cc.n_codigos = 0) AS sin_codigo'),
            trx.raw(conPrecio ? 'count(*) FILTER (WHERE sp.sin_precio) AS sin_precio' : 'NULL::int AS sin_precio'),
            nuevos ? trx.raw('count(*) FILTER (WHERE p.id = ANY(?::uuid[])) AS nuevos', [nuevos]) : trx.raw('NULL::int AS nuevos'),
          )
          .first() as Promise<{ todos: string; varios: string; sin_codigo: string; sin_precio: string | null; nuevos: string | null } | undefined>,
        // Con «todos» el total ES el conteo de la búsqueda: no se paga otra pasada.
        mostrar === 'todos'
          ? Promise.resolve(undefined)
          : (base.clone().clearSelect().clearOrder().count({ n: '*' }).first() as Promise<{ n: string | number } | undefined>),
        base
          .clone()
          .select(
            trx.raw('p.id::text AS id'),
            'p.sku',
            'p.nombre',
            'p.description',
            'p.barcode',
            trx.raw('s.id::text AS proveedor_id'),
            's.name as proveedor',
            'cc.n_codigos',
          )
          .orderByRaw(orden.sql, orden.bindings)
          .limit(pageSize)
          .offset((page - 1) * pageSize) as Promise<Array<{
            id: string; sku: string | null; nombre: string; description: string | null; barcode: string | null;
            proveedor_id: string | null; proveedor: string | null; n_codigos: number | string | null;
          }>>,
      ]);
      const conteos = { ...armarConteos(crudos, conPrecio), nuevos: nuevos ? Number(crudos?.nuevos ?? 0) : null };
      const out = await this.armarFilas(trx, filas, texto, sucursal, conPrecio);
      // `[PF.12.3]` Al final y en serie: su tope de tiempo no debe caerle a ninguna otra consulta.
      const costo = verCosto ? await this.ultimosCostos(trx, out) : null;

      return {
        sucursal,
        total: mostrar === 'todos' ? conteos.todos : Number(conteo?.n ?? 0),
        filas: costo?.filas ?? out,
        calculado_al: new Date().toISOString(),
        conteos,
        mostrar,
        costo_visible: verCosto,
        costo_medido: costo ? costo.medido : null,
      };
    });
  }

  /**
   * La búsqueda de la lista sobre los productos activos, con el proveedor (`s`), el número de códigos (`cc`) y,
   * si la base tiene precio por sucursal, «sin precio» (`sp`). Una sola definición para Sencillo y Detallado.
   */
  private buscado(trx: Knex.Transaction, texto: string, sucursal: string, conPrecio: boolean): Knex.QueryBuilder {
    const q = aplicarBusquedaCatalogo(
      trx
        .from('catalog.products as p')
        .leftJoin('catalog.suppliers as s', function () {
          this.on('s.id', '=', 'p.supplier_id').andOn('s.tenant_id', '=', 'p.tenant_id');
        })
        .whereRaw('p.tenant_id = public.current_tenant_id()')
        .whereNull('p.deleted_at')
        .where('p.activo', true),
      texto,
      { conProveedor: true },
    ).joinRaw(N_CODIGOS_LATERAL_SQL);
    // Sin precio por sucursal no se puede medir «sin precio»: ni se une ni se cuenta.
    if (conPrecio) q.joinRaw(SIN_PRECIO_LATERAL_SQL, [sucursal, sucursal]);
    return q;
  }

  /**
   * Detallado: TODOS los productos de la búsqueda (sin paginar) con lo que hace falta para contar, filtrar,
   * ordenar y pintar en el servidor. Mismo buscador y mismos laterales que la lista de Sencillo.
   */
  async universo(q: { search?: string; sucursal?: string }): Promise<{ sucursal: string; texto: string; conPrecio: boolean; filas: FilaUniverso[] }> {
    const sucursal = sucursalValida(q.sucursal);
    const texto = (q.search ?? '').trim();
    return this.tk.run(async (trx) => {
      const conPrecio = await this.conPrecioPorSucursal(trx);
      const filas = (await this.buscado(trx, texto, sucursal, conPrecio).select(
        trx.raw('p.id::text AS id'),
        'p.sku',
        'p.nombre',
        'p.description',
        'p.barcode',
        trx.raw('s.id::text AS proveedor_id'),
        's.name as proveedor',
        'cc.n_codigos',
        trx.raw(conPrecio ? 'sp.sin_precio' : 'NULL::boolean AS sin_precio'),
        trx.raw(`${SIN_PROVEEDOR_EXPR} AS sin_proveedor`),
      )) as FilaUniverso[];
      return { sucursal, texto, conPrecio, filas };
    });
  }

  /** Detallado: los renglones de una página (unidades con su precio y «Coincide por…»), igual que Sencillo. */
  async filasDe(filas: FilaUniverso[], texto: string, sucursal: string): Promise<CatalogoFila[]> {
    if (!filas.length) return [];
    return this.tk.run(async (trx) => this.armarFilas(trx, filas, texto, sucursal, await this.conPrecioPorSucursal(trx)));
  }

  /**
   * `[PF.12.3]` Detallado con el último costo: los MISMOS renglones de `filasDe` + `ultimosCostos`, la misma
   * consulta por lote, el mismo savepoint y el mismo tope que la lista Sencillo, en una sola transacción. Así un
   * producto dice el mismo costo, en la misma unidad, en las dos vistas.
   */
  async filasDeConCosto(filas: FilaUniverso[], texto: string, sucursal: string): Promise<{ filas: CatalogoFila[]; medido: boolean }> {
    if (!filas.length) return { filas: [], medido: true };
    return this.tk.run(async (trx) => {
      const base = await this.armarFilas(trx, filas, texto, sucursal, await this.conPrecioPorSucursal(trx));
      return this.ultimosCostos(trx, base);
    });
  }

  /**
   * `[PF.12.3]` El último costo de los renglones de UNA página: `ULTIMAS_ENTRADAS_SQL` una sola vez con todos sus
   * SKUs (recortados y sin repetir, como los compara `btrim(c8)`), y la conversión a cada unidad del renglón.
   * Sin SKU no hay entrada que buscar: `null`, igual que un SKU sin entradas («Sin compras»).
   * Si la lectura no se pudo hacer, `medido: false` y los renglones van SIN `ultimoCosto` (se declara, no se
   * pinta como «Sin compras»).
   */
  private async ultimosCostos(trx: Knex.Transaction, filas: CatalogoFila[]): Promise<{ filas: CatalogoFila[]; medido: boolean }> {
    const skus = [...new Set(filas.map((f) => (f.sku ?? '').trim()).filter(Boolean))];
    const entradas = skus.length ? await this.leerUltimasEntradas(trx, skus) : [];
    if (entradas === null) return { filas, medido: false };
    const entradaDe = new Map(entradas.map((e) => [e.sku, e]));
    return {
      filas: filas.map((f) => ({ ...f, ultimoCosto: armarUltimoCosto(f.unidades, entradaDe.get((f.sku ?? '').trim())) })),
      medido: true,
    };
  }

  /**
   * `[PF.12.3]` Lectura OPCIONAL de la lista: en SAVEPOINT y con tope de `COSTO_TOPE_MS`. Si falla o tarda más,
   * devuelve `null` y la lista sale igual, a tiempo (>1 s = «no funciona»). Motivo medido: en producción los
   * renglones de compra por SKU se buscan con `ix_kdm2_compra_sku` (`[RA-NEG.5]`); sin él la misma búsqueda
   * barre ~514 mil renglones X/A y tardó 300–1,680 ms (2026-10-22). El tope se pone con `set_config(..., true)`
   * DESPUÉS del savepoint y se devuelve al valor anterior antes de soltarlo: si la consulta truena, el ROLLBACK
   * al savepoint también lo deshace. Va en serie (nunca en un Promise.all): el tope es de la conexión.
   */
  private async leerUltimasEntradas(trx: Knex.Transaction, skus: string[]): Promise<Entrada[] | null> {
    try {
      return await trx.transaction(async (sp) => {
        const antes = ((await sp.raw(`SELECT current_setting('statement_timeout') AS t`)).rows[0] as { t?: string } | undefined)?.t ?? '0';
        await sp.raw(`SELECT set_config('statement_timeout', ?, true)`, [`${COSTO_TOPE_MS}ms`]);
        const filas = (await sp.raw(ULTIMAS_ENTRADAS_SQL, [skus])).rows as Entrada[];
        await sp.raw(`SELECT set_config('statement_timeout', ?, true)`, [antes]);
        return filas;
      });
    } catch (e) {
      this.logger.warn(`Último costo del catálogo no leído (${skus.length} SKUs): ${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  /** Unidades con el precio de la sucursal y la razón de la coincidencia, para los renglones dados. */
  private async armarFilas(
    trx: Knex.Transaction,
    filas: Array<{
      id: string; sku: string | null; nombre: string; description: string | null; barcode: string | null;
      proveedor_id: string | null; proveedor: string | null; n_codigos: number | string | null;
    }>,
    texto: string,
    sucursal: string,
    conPrecio: boolean,
  ): Promise<CatalogoFila[]> {
    const ids = filas.map((f) => f.id);
    const skus = [...new Set(filas.map((f) => f.sku).filter((s): s is string => !!s))];
    const [precios, escaleras, codigos] = await Promise.all([
      conPrecio && ids.length ? trx.raw(PRECIOS_SUCURSAL_SQL, [ids, sucursal]).then((r) => r.rows as Precio[]) : Promise.resolve([] as Precio[]),
      skus.length ? trx.raw(ESCALERA_SQL, [skus, sucursal]).then((r) => r.rows as Escalera[]) : Promise.resolve([] as Escalera[]),
      texto && skus.length
        ? trx.raw(CODIGOS_SQL, [skus]).then((r) => r.rows as { sku: string; barcode: string }[])
        : Promise.resolve([] as { sku: string; barcode: string }[]),
    ]);
    const precioDe = new Map(precios.map((p) => [p.product_id, p]));
    const escaleraDe = new Map(escaleras.map((e) => [e.sku, e]));
    const codigosDe = new Map<string, string[]>();
    for (const c of codigos) codigosDe.set(c.sku, [...(codigosDe.get(c.sku) ?? []), c.barcode]);

    const out: CatalogoFila[] = filas.map((f) => {
      const unidades = armarUnidades((f.sku && escaleraDe.get(f.sku)) || null, precioDe.get(f.id) ?? null);
      return {
        id: f.id,
        sku: f.sku,
        nombre: f.nombre,
        proveedor: f.proveedor_id ? { id: f.proveedor_id, nombre: f.proveedor ?? '' } : null,
        unidades,
        nCodigos: num(f.n_codigos) ?? 0,
        razon: texto
          ? razonDeCoincidencia(
              {
                nombre: f.nombre,
                sku: f.sku,
                descripcion: f.description,
                codigos: ordenarCodigos(f.barcode, (f.sku && codigosDe.get(f.sku)) || []),
                codigoPrincipal: f.barcode,
                proveedor: f.proveedor,
                // La búsqueda compara contra u1/u2/u3 crudos de la escalera: se le pasan los mismos.
                unidades: [escaleraDe.get(f.sku ?? '')?.u1_label, escaleraDe.get(f.sku ?? '')?.u2_label, escaleraDe.get(f.sku ?? '')?.u3_label]
                  .filter((x): x is string => !!x),
              },
              texto,
            )
          : null,
      };
    });
    return out;
  }

  async ficha(id: string, q: { sucursal?: string; puedeVerCosto: boolean; desde?: string; hasta?: string }): Promise<FichaProducto> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id de producto inválido');
    const sucursal = sucursalValida(q.sucursal);
    // `[PF.23]` El periodo de la venta por sucursal; sin fechas, el mes en curso (lo de siempre).
    const periodo = periodoFicha(q.desde, q.hasta, todayMx());
    if (!periodo) throw new BadRequestException('Periodo inválido: desde y hasta en YYYY-MM-DD, desde <= hasta, a lo más dos años.');

    return this.tk.run(async (trx) => {
      const prod = (await trx.raw(PRODUCTO_SQL, [id])).rows[0] as
        | {
            id: string; sku: string | null; nombre: string; description: string | null; barcode: string | null;
            activo: boolean; proveedor_id: string | null; proveedor: string | null;
          }
        | undefined;
      if (!prod) throw new NotFoundException('Producto no encontrado');
      const sku = prod.sku?.trim() || null;
      const conPrecio = await this.conPrecioPorSucursal(trx);

      const [precio, red, escalera, codigos, sucs, venta, existencia, entrada] = await Promise.all([
        conPrecio ? trx.raw(PRECIOS_SUCURSAL_SQL, [[id], sucursal]).then((r) => (r.rows[0] as Precio | undefined) ?? null) : Promise.resolve(null),
        conPrecio ? trx.raw(PRECIOS_RED_SQL, [id]).then((r) => r.rows as { piece_price: string | null }[]) : Promise.resolve([]),
        sku ? trx.raw(ESCALERA_SQL, [[sku], sucursal]).then((r) => (r.rows[0] as Escalera | undefined) ?? null) : Promise.resolve(null),
        sku ? trx.raw(CODIGOS_SQL, [[sku]]).then((r) => (r.rows as { barcode: string }[]).map((x) => x.barcode)) : Promise.resolve([]),
        trx.raw(SUCURSALES_SQL, [periodo.desde]).then((r) => r.rows as SucursalCruda[]),
        trx
          .raw(VENTA_PERIODO_SQL, [id, periodo.desde, periodo.hasta])
          .then((r) => r.rows as { sucursal: string; monto: string; unidades: string; ultima: string | null }[]),
        sku
          ? trx.raw(EXISTENCIA_KEPLER_SQL, [[sku], [id]]).then((r) => r.rows as { sucursal: string; cantidad: string }[])
          : Promise.resolve([]),
        // `[PF.12.3]` La MISMA consulta que la lista (con un SKU): la ficha y el renglón eligen la misma entrada.
        sku
          ? trx.raw(ULTIMAS_ENTRADAS_SQL, [[sku]]).then((r) => (r.rows[0] as Entrada | undefined) ?? null)
          : Promise.resolve(null),
      ]);

      const sucursales = armarSucursales(
        sucs,
        new Map(venta.map((v) => [v.sucursal, { monto: v.monto, unidades: v.unidades }])),
        new Map(existencia.map((e) => [e.sucursal, e.cantidad])),
      );
      const ultimas = venta.map((v) => v.ultima).filter((x): x is string => !!x).sort();
      const unidades = armarUnidades(escalera, precio);
      const nombreDe = new Map(sucs.map((s) => [s.codigo, s.nombre]));
      // `[PF.12.3]` Sin IVA ni IEPS, con la misma regla que la lista.
      const sinImp = entrada ? costoSinImpuestos(entrada.costo, entrada.iva, entrada.ieps) : null;
      let nombreEntrada: string | null = null;
      if (entrada) {
        nombreEntrada = nombreDe.get(entrada.sucursal) ?? null;
        if (nombreEntrada === null) {
          const w = (await trx.raw(
            `SELECT min(name) AS name FROM commercial.warehouses
              WHERE tenant_id = public.current_tenant_id() AND deleted_at IS NULL AND kepler_code = ?`,
            [entrada.sucursal],
          )).rows[0] as { name: string | null } | undefined;
          nombreEntrada = w?.name ?? null;
        }
      }

      return {
        id: prod.id,
        sku: prod.sku,
        nombre: prod.nombre,
        descripcion: descripcionDistinta(prod.nombre, prod.description),
        activo: prod.activo === true,
        proveedor: prod.proveedor_id ? { id: prod.proveedor_id, nombre: prod.proveedor ?? '' } : null,
        codigos: ordenarCodigos(prod.barcode, codigos),
        unidadBase: unidades[0]?.unidad ?? null,
        unidades,
        precioRed: precioDeRed(red.map((r) => r.piece_price)),
        sucursales,
        corteVenta: ultimas.length ? ultimas[ultimas.length - 1] : null,
        periodo,
        ultimaEntrada: entrada && sinImp
          ? {
              sucursal: entrada.sucursal,
              nombreSucursal: nombreEntrada,
              fecha: entrada.fecha,
              cantidad: num(entrada.cantidad) ?? 0,
              unidad: entrada.unidad,
              costo: q.puedeVerCosto ? sinImp.costo : null,
              impuesto: sinImp.impuesto,
              // `[PF.22]` El costo en cada unidad (paquete, caja…): `armarUltimoCosto`, la MISMA función del renglón.
              porUnidad: q.puedeVerCosto ? (armarUltimoCosto(unidades, entrada)?.porUnidad ?? []) : [],
            }
          : null,
        costo_visible: q.puedeVerCosto,
        calculado_al: new Date().toISOString(),
      };
    });
  }
}
