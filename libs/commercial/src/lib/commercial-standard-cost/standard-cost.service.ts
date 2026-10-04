import { Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, applySmartSearch } from '@megadulces/platform-core';
import {
  CeldaSucursal,
  ORDEN_VEREDICTO_SUCURSALES,
  ResultadoEntreSucursales,
  TOLERANCIA_ENTRE_SUCURSALES,
  VeredictoEntreSucursales,
  clasificarEntreSucursales,
} from './entre-sucursales';

import {
  CambioEstandar,
  EntradaCruda,
  EntradaTrazada,
  MuestraEstandar,
  cambiosEstandar,
  estandarEn,
  trazarEntradas,
} from './historial-costos';

interface EscaleraFila {
  sucursal: string;
  u1_label: string | null;
  u2_label: string | null;
  u3_label: string | null;
  f2_cap: string | number | null;
  f3_cap: string | number | null;
  costo1: string | number | null;
}

export interface RespuestaHistorial {
  sku: string;
  nombre: string | null;
  proveedor: string | null;
  desde: string;
  hasta: string;
  sucursales: { codigo: string; nombre: string | null }[];
  /** `kdii.c77` de hoy por plaza, con su unidad base. */
  estandar_hoy: { sucursal: string; costo: number; unidad: string | null }[];
  /** El estándar que tenía cada plaza al empezar el periodo (de la última venta previa). */
  estandar_al_inicio: Record<string, number | null>;
  cambios_estandar: CambioEstandar[];
  entradas: (EntradaTrazada & { plaza_sin_kepler: string | null })[];
}

const esFecha = (s?: string): boolean => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const restarDias = (iso: string, dias: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};

export interface FiltrosEntreSucursales {
  /** SKU o nombre. */
  q?: string;
  proveedor_id?: string;
  /** Sólo los productos donde ESTA sucursal se sale de la mayoría. */
  sucursal?: string;
  veredicto?: VeredictoEntreSucursales;
  /** Por defecto `true`: esconde los productos que ya están iguales en todas las plazas. */
  solo_diferencias?: boolean;
  /** Comparar sólo las plazas que vendieron en 30 días (la ficha existe en plazas que no lo manejan). */
  solo_con_venta?: boolean;
  limite?: number;
  desplazamiento?: number;
}

interface FilaCrudaEntreSucursales {
  sku: string;
  nombre: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  venta_30d: string | number;
  celdas: CeldaSucursal[] | string;
}

export interface FilaEntreSucursales extends ResultadoEntreSucursales {
  sku: string;
  nombre: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  /** Venta bruta 30 d en todas las plazas: sirve para ordenar lo que más pesa primero. */
  venta_30d: number;
}

export interface RespuestaEntreSucursales {
  /** Plazas operativas con su nombre (00 = Oficinas queda fuera). */
  sucursales: { codigo: string; nombre: string | null }[];
  /** Reparto del universo (texto + proveedor), sin veredicto ni sucursal: los chips lo usan. */
  resumen: Record<VeredictoEntreSucursales, number>;
  proveedores: { id: string; nombre: string; productos: number }[];
  tolerancia_pct: number;
  /** Hasta qué día llega la venta de 30 d. NULL = la matvista nunca se refrescó. */
  actividad_al: string | null;
  total: number;
  filas: FilaEntreSucursales[];
}

/**
 * `[CE.2]` — **El costo estándar de Kepler, producto por producto.**
 *
 * ── Qué publica y qué NO ─────────────────────────────────────────────────────────────────────
 *
 * El costo estándar es el que vive en la ficha del producto de Kepler (`kdii.c77`) y **es el que
 * fija el precio de venta**: `PV = costo × (1 + margen%) × (1 + impuesto%)` cuadra en el 97.75 %
 * del catálogo. No es un promedio: cambia por escalón cuando alguien edita la ficha.
 *
 * Esta pantalla lo pone al lado del **costo de reposición del ERP** (`kdik.c16`) para contestar
 * una sola pregunta: *¿con qué costo estamos poniendo precio, y se parece a lo que cuesta
 * reponer hoy?*
 *
 * ⛔ **No es la pantalla de margen.** El margen realizado se mide con el costo del hecho de venta
 * (ADR-051 enmendado) y vive en `/comercial/rentabilidad`. Acá se audita el **dato maestro**.
 * Mezclarlos produciría dos cifras de margen distintas con el mismo rótulo.
 *
 * ── Todo sale de una vista sobre el ODS ──────────────────────────────────────────────────────
 *
 * `analytics.v_kepler_standard_cost` (`[CE.1]`) — derive-no-copy sobre `kepler_ods`, sin tabla
 * ni importer. Este servicio **no recalcula nada**: filtra, ordena y cuenta. Si una regla del
 * costo cambia, cambia en la vista y acá no se toca nada.
 *
 * ── ⚠️ Lo que este servicio tiene que DECLARAR o miente ──────────────────────────────────────
 *
 *  1. **`impacto_cogs_30d` sólo existe cuando las dos magnitudes están en la unidad base.** En
 *     `no_comparable` (939 filas) la vista devuelve NULL a propósito: el testigo viene en otro
 *     peldaño y restarlo inventaría desviaciones de 10×. Los totales suman lo valorado y
 *     `filas_sin_valorar` dice cuántas quedaron fuera — leer la suma sin ese acompañante afirma
 *     algo distinto de lo que el dato sostiene.
 *  2. **`impuesto_pct` es NULL sin venta en la ventana**, nunca 0: un producto sin venta no es un
 *     producto exento. Por eso `precio_cuadra` también puede ser NULL, con su motivo.
 *  3. **La ventana de actividad la sostiene una vista materializada.** `actividad_al` viaja en la
 *     respuesta: sin refresco la ventana envejece y "30 días" deja de ser cierto (ADR-056).
 */

/** Los siete estados. Ninguno es "se ve bien": las tres ausencias se distinguen entre sí. */
export type VeredictoCostoEstandar =
  | 'al_dia'
  | 'estandar_bajo'
  | 'estandar_alto'
  | 'no_comparable'
  | 'testigo_inverosimil'
  | 'sin_testigo'
  | 'sin_operacion'
  | 'sin_estandar';

export interface FiltrosCostoEstandar {
  sucursal?: string;
  veredicto?: VeredictoCostoEstandar;
  /** Texto libre sobre SKU o nombre. */
  q?: string;
  /**
   * Por defecto `false`: se esconden las 52,606 filas `sin_operacion` (la ficha existe en las 9
   * plazas aunque el producto no se maneje ahí). No es un hueco, es el maestro replicado, y
   * dejarlas visibles vuelve ruido el 60 % de la tabla.
   */
  incluir_sin_operacion?: boolean;
  /**
   * `[CE.9]` Por defecto `false`: la plaza **00 es OFICINAS** y no vende (9,632 fichas, cero
   * venta). Igual que en existencia y en el sell-out, queda fuera salvo que se pida.
   */
  incluir_oficinas?: boolean;
  /** `[CE.9]` La lista que importa mañana: las que pierden dinero en cada venta HOY. */
  solo_bajo_costo?: boolean;
  limite?: number;
  desplazamiento?: number;
}

export interface FilaCostoEstandar {
  sucursal: string;
  sku: string;
  nombre: string | null;
  unidad_base: string | null;
  unidad_dos: string | null;
  unidad_tres: string | null;
  factor_dos: number | null;
  factor_tres: number | null;
  costo_estandar: number | null;
  costo_estandar_u2: number | null;
  costo_estandar_u3: number | null;
  margen_ficha_pct: number | null;
  precio_ficha: number | null;
  impuesto_pct: number | null;
  impuesto_renglones: number | null;
  impuesto_tasas_distintas: number | null;
  precio_reconstruido: number | null;
  precio_cuadra: boolean | null;
  precio_cuadra_motivo: string | null;
  costo_reposicion: number | null;
  peldano_reposicion: string | null;
  costo_reposicion_base: number | null;
  ultimo_costo: number | null;
  ultimo_costo_al: string | null;
  desviacion_pct: number | null;
  desviacion_por_unidad: number | null;
  veredicto: VeredictoCostoEstandar;
  unidades_base_30d: number | null;
  venta_bruta_30d: number | null;
  venta_neta_30d: number | null;
  impacto_cogs_30d: number | null;
  /** `[CE.9]` La 00 es OFICINAS: 9,632 fichas, cero venta. Se declara, no se esconde. */
  es_plaza_operativa: boolean;
  /**
   * Salida **A** de la decisión: capturar el costo nuevo MUEVE EL PRECIO. Medido sobre 6,501
   * cambios reales, Kepler conservó el margen y el precio siguió al costo en el **74.02 %**;
   * sólo en el 1.28 % se quedó quieto.
   */
  precio_si_conserva_margen: number | null;
  /** Salida **B**: el margen que de verdad se saca hoy, contra el costo real. */
  margen_real_pct: number | null;
  /** `margen_real_pct < 0`. 270 fichas pierden dinero en cada venta HOY. */
  vende_bajo_costo: boolean | null;

  /**
   * `[CE.11]` **Por qué el costo del ERP está donde está.** El último movimiento NO de venta
   * cuyo precio coincide con él dentro del 1 %.
   *
   * ⭐ Medido sobre 33,286 pares: se puede atribuir el **75.3 %**, y de ésos el **71.3 % es un
   * conteo de INVENTARIO FÍSICO, no una compra**. La suposición cómoda —«esa plaza compró más
   * caro»— es falsa en la mayoría de los casos.
   *
   * ⚠️ Todo el bloque llega **NULL** cuando no se pudo atribuir (24.7 %): es una ausencia, no un
   * cero, y la pantalla tiene que decirlo en vez de inventar una causa.
   */
  origen_familia: 'compra' | 'inventario_fisico' | 'traspaso_u_otro' | 'otro' | null;
  /**
   * Los CUATRO componentes del tipo de documento de Kepler: `N-A-30-1`.
   *
   * ⚠️ `[CE.12]`: con **tres** componentes, `N-D-5` parecía «ambiguo, cinco nombres» y en
   * realidad son cinco doctypes distintos (Salida de almacén / por ajuste / por destrucción /
   * por muestra / Carta porte). Medido: 27 claves ambiguas de 133 con tres componentes,
   * **1 de 176** con cuatro — y esa una es un punto final de más en el catálogo del ERP.
   */
  origen_doctype: string | null;
  /** El número de documento tal cual lo escribe Kepler en pantalla: `NA3001-0000001`. */
  origen_doc_id: string | null;
  /**
   * El almacén que dejó ese costo. Es **siempre** el principal de la plaza, porque `kdik.c16`
   * sólo existe ahí: un movimiento de otro almacén de la misma sucursal no pudo fijarlo.
   * Sin ese filtro, 12 de 25,079 atribuciones nombraban el papel equivocado.
   */
  origen_almacen: string | null;
  /** El rótulo del propio Kepler (`kdmm`), nunca una lista nuestra. */
  origen_nombre: string | null;
  /** Con los 4 componentes ya casi nunca pasa, pero si el catálogo repite nombre se DECLARA. */
  origen_nombre_ambiguo: boolean | null;
  origen_fecha_txt: string | null;
  origen_folio: string | null;
  origen_precio: number | null;
  origen_cantidad: number | null;
  origen_unidad: string | null;
  /**
   * El TAMAÑO del documento, para que el renglón no se lea como si fuera el movimiento entero.
   * El caso que lo motivó: «1 PAQ a $189.07» pertenece a un conteo físico de **897 partidas
   * por $4,246,558.27** — verificado contra la pantalla del propio Kepler.
   */
  origen_doc_renglones: number | null;
  origen_doc_total: number | null;
}

export interface ResumenCostoEstandar {
  /** Una entrada por veredicto, siempre las siete aunque valgan 0. */
  reparto: { veredicto: VeredictoCostoEstandar; filas: number; impacto_cogs_30d: number | null }[];
  cobertura: {
    filas_totales: number;
    filas_con_operacion: number;
    filas_comparables: number;
    /** Cuántas filas con operación NO pudieron valorarse. Acompaña obligatoriamente al total. */
    filas_sin_valorar: number;
    pct_comparable: number | null;
  };
  dinero: {
    cogs_subdeclarado_30d: number;
    cogs_sobredeclarado_30d: number;
    neto_30d: number;
  };
  /**
   * `[CE.9]` **Lo que de verdad importa mañana.** Al precio de hoy y contra el costo real, estas
   * fichas pierden dinero en cada venta. El catálogo no lo muestra porque calcula el margen
   * contra un costo que ya no se paga.
   */
  bajo_costo: {
    fichas: number;
    venta_30d: number;
    /**
     * El peor margen del conjunto. ⚠️ **No se publica la mediana**: no se deriva de un barrido
     * agrupado y pedirla costaría un segundo recorrido de la vista, que es justo lo que el
     * barrido único de `resumen()` acaba de eliminar (−55 %). Vive en `FASE_CE`.
     */
    peor_margen_pct: number | null;
  };
  /**
   * `[CE.9]` Lo que se dejó fuera, dicho en voz alta: la plaza 00 es OFICINAS y no vende.
   * Esconder sin declarar es la falla que esta fase persigue.
   */
  oficinas_excluidas: number;
  precio: {
    filas_evaluadas: number;
    cuadran: number;
    no_cuadran: number;
    no_medibles: number;
    pct_cuadra: number | null;
  };
  /** Hasta qué día llega la ventana de actividad. NULL = la matvista nunca se refrescó. */
  actividad_al: string | null;
}

const COLUMNAS = `
  sucursal, sku, nombre, unidad_base, unidad_dos, unidad_tres, factor_dos, factor_tres,
  costo_estandar, costo_estandar_u2, costo_estandar_u3, margen_ficha_pct, precio_ficha,
  impuesto_pct, impuesto_renglones, impuesto_tasas_distintas,
  precio_reconstruido, precio_cuadra, precio_cuadra_motivo,
  costo_reposicion, peldano_reposicion, costo_reposicion_base, ultimo_costo, ultimo_costo_al,
  desviacion_pct, desviacion_por_unidad, veredicto,
  unidades_base_30d, venta_bruta_30d, venta_neta_30d, impacto_cogs_30d,
  es_plaza_operativa, precio_si_conserva_margen, margen_real_pct, vende_bajo_costo,
  origen_familia, origen_doctype, origen_nombre, origen_nombre_ambiguo,
  origen_fecha_txt, origen_folio, origen_precio, origen_cantidad, origen_unidad,
  origen_almacen, origen_doc_id, origen_doc_renglones, origen_doc_total`;

const VEREDICTOS: VeredictoCostoEstandar[] = [
  'estandar_bajo',
  'estandar_alto',
  'no_comparable',
  'testigo_inverosimil',
  'sin_testigo',
  'al_dia',
  'sin_estandar',
  'sin_operacion',
];

@Injectable()
export class StandardCostService {
  private readonly logger = new Logger(StandardCostService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * El tablero. Se ordena por `estandar_bajo` primero y `al_dia` casi al final, para que un
   * tablero ordenado por estado no esconda justo lo que hay que arreglar (mismo criterio que
   * `ORDEN_KPI_ESTADO` de ADR-076).
   */
  /**
   * ⛔ `[CE.9]` **El tablero mira el MISMO universo que la tabla.** Antes esto sólo tomaba la
   * sucursal: con un texto en el buscador la tabla filtraba y los conteos no, así que un chip
   * podía decir «6,960» y devolver tres filas. Dos números de la misma pantalla contradiciéndose
   * es dibujar, no medir (ADR-056).
   *
   * El **`veredicto` NO entra a propósito**: los chips SON el selector de veredicto y tienen que
   * seguir mostrando el reparto completo del universo que particionan — si el filtro se aplicara,
   * al elegir uno los otros seis caerían a cero y no habría cómo volver. La pantalla lo declara.
   */
  async resumen(f: { sucursal?: string; q?: string } = {}): Promise<ResumenCostoEstandar> {
    return this.tk.run(async (trx) => {
      /**
       * ⚡ `[CE.9]` **UN barrido, no dos.** Acá había dos consultas contra la misma vista: una
       * agrupada por veredicto y otra de totales. La vista se recorría entera dos veces para
       * responder lo mismo, porque **todos los totales salen de sumar los grupos**: la segunda
       * consulta era redundante, no complementaria. Las sumas se hacen acá y no en SQL: son
       * siete filas.
       *
       * **Medido, mediana de 5 corridas: 1,219 ms → 548 ms (−55 %).** ⚠️ La primera muestra dio
       * 630 → 597 y parecía que el cambio no servía: con la vista caliente el segundo barrido
       * casi no cuesta. Una sola medición de una consulta con caché no decide nada — hay que
       * repetirla y quedarse con la mediana.
       *
       * ⚠️ `actividad_al` es un `max()` de `max()`, que da el mismo valor. Los demás son sumas de
       * sumas. No es una aproximación: es la misma cifra por otro camino.
       */
      const grupos = (await this.universo(trx, f)
        .select(
          'veredicto',
          // [CE.9] Agrupar tambien por esto deja contar la plaza 00 (OFICINAS, cero venta) SIN un
          // segundo barrido: los totales la excluyen en JS y su conteo viaja aparte, declarado.
          'es_plaza_operativa',
          trx.raw('count(*)::int AS filas'),
          // NULL cuando ese veredicto no tiene NI UNA fila valorable: un 0 diria "no cuesta
          // nada" donde lo cierto es "no se puede medir" (ADR-056).
          trx.raw('sum(impacto_cogs_30d) AS impacto'),
          trx.raw('count(*) FILTER (WHERE impacto_cogs_30d IS NULL)::int AS sin_valorar'),
          trx.raw('COALESCE(sum(impacto_cogs_30d) FILTER (WHERE impacto_cogs_30d > 0), 0)::numeric AS sub'),
          trx.raw('COALESCE(sum(impacto_cogs_30d) FILTER (WHERE impacto_cogs_30d < 0), 0)::numeric AS sobre'),
          trx.raw('count(*) FILTER (WHERE precio_cuadra IS TRUE)::int  AS precio_ok'),
          trx.raw('count(*) FILTER (WHERE precio_cuadra IS FALSE)::int AS precio_mal'),
          trx.raw('count(*) FILTER (WHERE precio_cuadra IS NULL)::int  AS precio_nulo'),
          trx.raw('max(actividad_al)::text AS actividad_al'),
          // [CE.9] Las que pierden dinero en cada venta HOY. Sumables, asi que entran al barrido.
          trx.raw('count(*) FILTER (WHERE vende_bajo_costo)::int AS bc_fichas'),
          trx.raw('COALESCE(sum(venta_bruta_30d) FILTER (WHERE vende_bajo_costo), 0)::numeric AS bc_venta'),
          trx.raw('min(margen_real_pct) FILTER (WHERE vende_bajo_costo) AS bc_peor'),
        )
        .groupBy('veredicto', 'es_plaza_operativa')) as unknown as {
        veredicto: VeredictoCostoEstandar;
        es_plaza_operativa: boolean;
        filas: number;
        impacto: string | null;
        sin_valorar: number;
        sub: string;
        sobre: string;
        precio_ok: number;
        precio_mal: number;
        precio_nulo: number;
        actividad_al: string | null;
        bc_fichas: number;
        bc_venta: string;
        bc_peor: string | null;
      }[];

      // Todo lo que se publica mira SOLO plazas operativas. La 00 se cuenta aparte, no se pierde.
      const oficinas = grupos
        .filter((g) => !g.es_plaza_operativa)
        .reduce((n, g) => n + (Number(g.filas) || 0), 0);
      const ops = grupos.filter((g) => g.es_plaza_operativa);

      const porVeredicto = new Map<VeredictoCostoEstandar, { filas: number; impacto: number | null }>();
      for (const g of ops) {
        const prev = porVeredicto.get(g.veredicto);
        const imp = g.impacto === null || g.impacto === undefined ? null : Number(g.impacto);
        porVeredicto.set(g.veredicto, {
          filas: (prev?.filas ?? 0) + (Number(g.filas) || 0),
          impacto: imp === null ? (prev?.impacto ?? null) : (prev?.impacto ?? 0) + imp,
        });
      }
      const reparto = VEREDICTOS.map((v) => {
        const g = porVeredicto.get(v);
        return {
          veredicto: v,
          filas: g ? g.filas : 0,
          // Un veredicto que por definición no puede valorarse devuelve NULL, no 0.
          impacto_cogs_30d: g ? g.impacto : null,
        };
      });

      const COMPARABLES: VeredictoCostoEstandar[] = ['al_dia', 'estandar_bajo', 'estandar_alto'];
      const suma = (sel: (g: (typeof grupos)[number]) => number, filtro?: (v: VeredictoCostoEstandar) => boolean) =>
        ops.reduce((s, g) => (filtro && !filtro(g.veredicto) ? s : s + (Number(sel(g)) || 0)), 0);

      const totales = suma((g) => g.filas);
      const conOperacion = suma((g) => g.filas, (v) => v !== 'sin_operacion');
      const comparables = suma((g) => g.filas, (v) => COMPARABLES.includes(v));
      // `sin_operacion` queda fuera: su impacto es NULL por construcción (no vendió), y contarlas
      // como "sin valorar" inflaría el acompañante del total con filas que no son un hueco.
      const sinValorar = suma((g) => g.sin_valorar, (v) => v !== 'sin_operacion');
      const sub = suma((g) => Number(g.sub));
      const sobre = suma((g) => Number(g.sobre));
      const precioOk = suma((g) => g.precio_ok);
      const precioMal = suma((g) => g.precio_mal);
      const evaluadas = precioOk + precioMal;
      const actividadAl = ops
        .map((g) => g.actividad_al)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;

      return {
        reparto,
        cobertura: {
          filas_totales: totales,
          filas_con_operacion: conOperacion,
          filas_comparables: comparables,
          filas_sin_valorar: sinValorar,
          pct_comparable: conOperacion > 0 ? (comparables / conOperacion) * 100 : null,
        },
        dinero: {
          cogs_subdeclarado_30d: sub,
          cogs_sobredeclarado_30d: sobre,
          neto_30d: sub + sobre,
        },
        precio: {
          filas_evaluadas: evaluadas,
          cuadran: precioOk,
          no_cuadran: precioMal,
          no_medibles: suma((g) => g.precio_nulo),
          pct_cuadra: evaluadas > 0 ? (precioOk / evaluadas) * 100 : null,
        },
        bajo_costo: {
          fichas: suma((g) => g.bc_fichas),
          venta_30d: suma((g) => Number(g.bc_venta)),
          // NULL, no 0: sin ninguna ficha bajo costo no hay un "peor margen" que reportar.
          peor_margen_pct: ops
            .map((g) => (g.bc_peor === null ? null : Number(g.bc_peor)))
            .filter((x): x is number => x !== null)
            .reduce<number | null>((m, x) => (m === null || x < m ? x : m), null),
        },
        oficinas_excluidas: oficinas,
        actividad_al: actividadAl,
      };
    });
  }

  /** La tabla. Ordena por el dinero en juego, y lo no valorado va después, no primero. */
  async listar(f: FiltrosCostoEstandar = {}): Promise<{ filas: FilaCostoEstandar[]; total: number }> {
    const limite = Math.min(Math.max(Number(f.limite) || 200, 1), 1000);
    const desplazamiento = Math.max(Number(f.desplazamiento) || 0, 0);

    return this.tk.run(async (trx) => {
      // Mismo `universo()` que el tablero (sucursal + texto) + lo que es propio de la tabla.
      const base = () => {
        const q = this.universo(trx, f);
        // [CE.9] la 00 es OFICINAS y no vende: fuera salvo que se pida explícitamente.
        if (!f.incluir_oficinas) q.where('es_plaza_operativa', true);
        if (f.solo_bajo_costo) q.where('vende_bajo_costo', true);
        if (f.veredicto) q.where('veredicto', f.veredicto);
        else if (!f.incluir_sin_operacion) q.whereNot('veredicto', 'sin_operacion');
        return q;
      };

      const [{ total }] = await base().count<{ total: string }[]>({ total: '*' });
      const filas = await base()
        .select(trx.raw(COLUMNAS))
        // NULLS LAST: `no_comparable` no tiene monto y no puede encabezar la tabla del dinero.
        .orderByRaw('abs(impacto_cogs_30d) DESC NULLS LAST')
        .orderByRaw('venta_bruta_30d DESC NULLS LAST')
        .orderBy('sku')
        .limit(limite)
        .offset(desplazamiento);

      return { filas: filas as unknown as FilaCostoEstandar[], total: Number(total) || 0 };
    });
  }

  /**
   * El detalle de un SKU en TODAS las plazas. Es el ángulo que la pantalla de Kepler no da y
   * donde se ve el hallazgo de fondo: **1,004 SKUs tienen costo estándar distinto entre plazas**,
   * y el peldaño del testigo puede cambiar de una sucursal a otra para el mismo producto.
   */
  async porSku(sku: string): Promise<FilaCostoEstandar[]> {
    return this.tk.run(async (trx) => {
      const filas = await trx
        .from('analytics.v_kepler_standard_cost')
        .where('sku', sku.trim())
        // La 00 tampoco se lista acá: salía «al día» sobre cero venta, que es un veredicto
        // inventado sobre un universo que no existe.
        .where('es_plaza_operativa', true)
        .select(trx.raw(COLUMNAS))
        .orderBy('sucursal');
      return filas as unknown as FilaCostoEstandar[];
    });
  }

  /**
   * `[CAT-COSTO.4]` **El mismo producto con costo estándar distinto según la sucursal.**
   *
   * ── Por qué lee la escalera y no `v_kepler_standard_cost` ────────────────────────────────────
   * El valor es el mismo (`costo_estandar` de esa vista ES `costo1` de la escalera, `kdii.c77`),
   * pero aquella arrastra el origen del costo, la actividad y el cuadre del precio para cada fila:
   * trabajo que esta pregunta no usa. Se lee la ficha pura y se le pega sólo la venta de 30 días.
   *
   * ── Qué se decide aquí y qué no ──────────────────────────────────────────────────────────────
   * La consulta sólo junta las fichas de cada SKU; **quién se sale lo decide
   * `clasificarEntreSucursales()`**, que se prueba sin base. El tablero (`resumen`) mira el mismo
   * universo que la tabla salvo el veredicto y la sucursal, igual que el tablero de `[CE.9]`: los
   * chips SON el selector y tienen que seguir mostrando el reparto completo.
   *
   * ⚠️ La plaza **00 es OFICINAS** y no entra: su ficha no pone precio a nadie.
   */
  async entreSucursales(f: FiltrosEntreSucursales = {}): Promise<RespuestaEntreSucursales> {
    const limite = Math.min(Math.max(Number(f.limite) || 100, 1), 500);
    const desplazamiento = Math.max(Number(f.desplazamiento) || 0, 0);
    const soloDiferencias = f.solo_diferencias ?? true;

    return this.tk.run(async (trx) => {
      const qb = trx
        .from(
          trx.raw(`(
            SELECT f.sku,
                   max(cp.nombre)                AS nombre,
                   max(cp.supplier_id::text)     AS proveedor_id,
                   max(sup.name)                 AS proveedor,
                   COALESCE(sum(a.venta_bruta), 0)::numeric AS venta_30d,
                   jsonb_agg(jsonb_build_object(
                     'sucursal', f.sucursal,
                     'costo',    f.costo,
                     'unidad',   f.unidad,
                     'vende',    COALESCE(a.unidades_base, 0) > 0
                   ) ORDER BY f.sucursal)        AS celdas
              FROM (
                SELECT DISTINCT ON (l.sucursal, l.sku)
                       l.sucursal, l.sku, l.u1_label AS unidad, NULLIF(l.costo1, 0) AS costo
                  FROM analytics.v_kepler_unit_ladder l
                 WHERE l.sucursal <> '00'
                 ORDER BY l.sucursal, l.sku
              ) f
              LEFT JOIN analytics.mv_kepler_standard_cost_activity a
                     ON btrim(a.sucursal::text) = f.sucursal AND a.sku = f.sku
              LEFT JOIN catalog.products cp
                     ON cp.sku = f.sku AND cp.deleted_at IS NULL AND cp.tenant_id = current_tenant_id()
              LEFT JOIN catalog.suppliers sup
                     ON sup.id = cp.supplier_id AND sup.tenant_id = cp.tenant_id
             WHERE f.costo IS NOT NULL
             GROUP BY f.sku
            HAVING count(*) >= 2
          ) AS x`),
        )
        .select('x.sku', 'x.nombre', 'x.proveedor_id', 'x.proveedor', 'x.venta_30d', 'x.celdas');
      applySmartSearch(qb, f.q, { columns: ['x.sku', 'x.nombre'] });
      if (f.proveedor_id) qb.where('x.proveedor_id', f.proveedor_id);

      const [crudo, actividad, sucs] = await Promise.all([
        qb as unknown as Promise<FilaCrudaEntreSucursales[]>,
        trx.from('analytics.mv_kepler_standard_cost_activity').max({ al: 'ventana_hasta' }).first(),
        trx
          .from('commercial.warehouses')
          .whereRaw('tenant_id = current_tenant_id()')
          .whereNotNull('kepler_code')
          .whereNot('kepler_code', '00')
          .whereNull('deleted_at')
          .select('kepler_code')
          .min({ nombre: 'name' })
          .groupBy('kepler_code')
          .orderBy('kepler_code'),
      ]);

      const filas: FilaEntreSucursales[] = crudo.map((r) => {
        const celdas = (typeof r.celdas === 'string' ? JSON.parse(r.celdas) : r.celdas) as CeldaSucursal[];
        const c = clasificarEntreSucursales(
          celdas.map((x) => ({ ...x, costo: Number(x.costo) })),
          { soloConVenta: f.solo_con_venta },
        );
        return {
          sku: r.sku,
          nombre: r.nombre,
          proveedor_id: r.proveedor_id,
          proveedor: r.proveedor,
          venta_30d: Number(r.venta_30d) || 0,
          ...c,
        };
      });

      // El tablero: mismo universo (texto + proveedor), sin veredicto ni sucursal.
      const resumen = Object.fromEntries(ORDEN_VEREDICTO_SUCURSALES.map((v) => [v, 0])) as Record<
        VeredictoEntreSucursales,
        number
      >;
      for (const x of filas) resumen[x.veredicto]++;

      const proveedores = new Map<string, { id: string; nombre: string; productos: number }>();
      for (const x of filas) {
        if (!x.proveedor_id) continue;
        const p = proveedores.get(x.proveedor_id) ?? { id: x.proveedor_id, nombre: x.proveedor ?? x.proveedor_id, productos: 0 };
        p.productos++;
        proveedores.set(x.proveedor_id, p);
      }

      const DIFERENCIAS: VeredictoEntreSucursales[] = ['distinto', 'sin_mayoria', 'unidad_distinta'];
      const visibles = filas
        .filter((x) => (f.veredicto ? x.veredicto === f.veredicto : !soloDiferencias || DIFERENCIAS.includes(x.veredicto)))
        .filter((x) => !f.sucursal || x.sucursales_fuera.includes(f.sucursal))
        .sort(
          (a, b) =>
            ORDEN_VEREDICTO_SUCURSALES.indexOf(a.veredicto) - ORDEN_VEREDICTO_SUCURSALES.indexOf(b.veredicto) ||
            b.venta_30d - a.venta_30d ||
            (b.diferencia_pct ?? 0) - (a.diferencia_pct ?? 0) ||
            a.sku.localeCompare(b.sku),
        );

      return {
        sucursales: (sucs as { kepler_code: string; nombre: string | null }[]).map((s) => ({
          codigo: s.kepler_code,
          nombre: s.nombre,
        })),
        resumen,
        proveedores: [...proveedores.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)),
        tolerancia_pct: TOLERANCIA_ENTRE_SUCURSALES * 100,
        actividad_al: (actividad as { al: string | null } | undefined)?.al ?? null,
        total: visibles.length,
        filas: visibles.slice(desplazamiento, desplazamiento + limite),
      };
    });
  }

  /**
   * `[CAT-COSTO.5]` **Trazabilidad de UN producto**: cambios de costo estándar y de costo de entrada,
   * sucursal por sucursal. Todo es de un solo SKU, así que va por el índice `kdm2 (btrim(c8))` y no
   * recorre el ODS.
   *
   * Los filtros de sucursal, proveedor y tipo los aplica la pantalla: son pocas filas y así filtrar
   * es instantáneo. El servidor sólo acota el periodo.
   *
   * ⚠️ Supuestos que verifica `verify-cat-costo-estandar.js` (B3b, C2) y que se DECLARAN aquí:
   *  · `f3_cap` es piezas por unidad 3 contadas desde la BASE (no desde la unidad 2).
   *  · el último `c62 / c58` de la venta coincide con el `c77` de hoy (si no, el método no sirve).
   */
  async historial(skuCrudo: string, f: { desde?: string; hasta?: string } = {}): Promise<RespuestaHistorial> {
    const sku = skuCrudo.trim();
    const hoy = new Date().toISOString().slice(0, 10);
    const hasta = f.hasta && esFecha(f.hasta) ? f.hasta : hoy;
    const desde = f.desde && esFecha(f.desde) ? f.desde : restarDias(hasta, 365);
    // Un año antes del periodo para saber qué estándar había al empezar.
    const desdeMuestras = restarDias(desde, 365);
    const NUM = (col: string) => `nullif(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric`;

    return this.tk.run(async (trx) => {
      const [escalera, muestrasCrudas, entradasCrudas, producto, sucs] = await Promise.all([
        trx
          .from('analytics.v_kepler_unit_ladder')
          .where('sku', sku)
          .whereNot('sucursal', '00')
          .select('sucursal', 'u1_label', 'u2_label', 'u3_label', 'f2_cap', 'f3_cap', 'costo1') as unknown as Promise<
          EscaleraFila[]
        >,
        trx.raw(
          `SELECT btrim(l.sucursal::text) AS sucursal,
                  l.c32::date::text       AS fecha,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${NUM('l.c62')} / ${NUM('l.c58')}) AS costo
             FROM kepler_ods.kdm2 l
            WHERE btrim(l.c8) = ?
              AND l.c2 = 'U' AND l.c3 = 'D' AND l.c4 IN (6, 10)
              AND l.c32::date BETWEEN ?::date AND ?::date
              AND btrim(l.sucursal::text) <> '00'
              -- el almacen del renglon es de esta sucursal (01, 01-006…): una fila replicada de otra
              -- plaza traeria el costo de SU ficha y contaminaria la historia de esta.
              AND split_part(btrim(l.c1::text), '-', 1) = btrim(l.sucursal::text)
              AND ${NUM('l.c62')} > 0 AND ${NUM('l.c58')} > 0
            GROUP BY 1, 2`,
          [sku, desdeMuestras, hasta],
        ),
        trx.raw(
          `SELECT btrim(ap.sucursal::text)               AS sucursal_registro,
                  btrim(ap.c6::text)                     AS folio,
                  ap.c68::date::text                     AS fecha,
                  NULLIF(btrim(ap.c32::text), '')        AS proveedor,
                  NULLIF(upper(btrim(l.c11::text)), '')  AS unidad,
                  ${NUM('l.c9')}                         AS cantidad,
                  ${NUM('l.c12')}                        AS costo,
                  og.origen_veredicto,
                  og.origen_warehouse_name               AS origen_nombre,
                  wo.kepler_code                         AS origen_kepler
             FROM kepler_ods.kdm2 l
             JOIN kepler_ods.kdm1 ap
               ON ap.sucursal = l.sucursal AND ap.c1 = l.c1 AND ap.c2 = l.c2 AND ap.c3 = l.c3
              AND ap.c4 = l.c4 AND ap.c6 = l.c6
             LEFT JOIN analytics.v_erp_goods_receipt_origin og
               ON og.sucursal = ap.sucursal AND og.folio = btrim(ap.c6::text)
             LEFT JOIN commercial.warehouses wo ON wo.id = og.origen_warehouse_id
            WHERE btrim(l.c8) = ?
              AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'
              AND btrim(ap.c1::text) = ap.sucursal::text
              AND btrim(coalesce(ap.c43::text, '')) <> 'C'
              AND ap.c68::date BETWEEN ?::date AND ?::date`,
          [sku, desde, hasta],
        ),
        trx
          .from('catalog.products as cp')
          .leftJoin('catalog.suppliers as sup', function () {
            this.on('sup.id', '=', 'cp.supplier_id').andOn('sup.tenant_id', '=', 'cp.tenant_id');
          })
          .whereRaw('cp.tenant_id = current_tenant_id()')
          .where('cp.sku', sku)
          .whereNull('cp.deleted_at')
          .first('cp.nombre', 'sup.name as proveedor'),
        trx
          .from('commercial.warehouses')
          .whereRaw('tenant_id = current_tenant_id()')
          .whereNotNull('kepler_code')
          .whereNot('kepler_code', '00')
          .whereNull('deleted_at')
          .select('kepler_code')
          .min({ nombre: 'name' })
          .groupBy('kepler_code')
          .orderBy('kepler_code'),
      ]);

      const porSucursal = new Map(escalera.map((x) => [String(x.sucursal), x]));
      const factor = (sucursal: string, unidad: string | null): number | null => {
        const lad = porSucursal.get(sucursal);
        if (!lad || !unidad) return null;
        if (unidad === lad.u1_label) return 1;
        if (unidad === lad.u2_label && Number(lad.f2_cap) > 0) return Number(lad.f2_cap);
        if (unidad === lad.u3_label && Number(lad.f3_cap) > 0) return Number(lad.f3_cap);
        return null;
      };

      const muestras: MuestraEstandar[] = (muestrasCrudas.rows as { sucursal: string; fecha: string; costo: string }[]).map(
        (r) => ({ sucursal: r.sucursal, fecha: r.fecha, costo: Number(r.costo) }),
      );

      type FilaEntrada = {
        sucursal_registro: string;
        folio: string;
        fecha: string;
        proveedor: string | null;
        unidad: string | null;
        cantidad: string | null;
        costo: string | null;
        origen_veredicto: string | null;
        origen_nombre: string | null;
        origen_kepler: string | null;
      };
      const nombrePlaza = new Map<string, string>();
      const entradas: EntradaCruda[] = (entradasCrudas.rows as FilaEntrada[]).map((r) => {
        // De qué plaza es: la que recibió, aunque se haya registrado en el CEDIS (DM.19).
        const plaza =
          r.origen_veredicto === 'otra_plaza'
            ? r.origen_kepler
            : r.sucursal_registro !== '00' || r.origen_veredicto === 'propio'
              ? r.sucursal_registro
              : null;
        if (!plaza && r.origen_nombre) nombrePlaza.set(r.folio, r.origen_nombre);
        return {
          fecha: r.fecha,
          sucursal_registro: r.sucursal_registro,
          plaza,
          folio: r.folio,
          proveedor: r.proveedor,
          unidad: r.unidad,
          cantidad: Number(r.cantidad) || 0,
          costo: Number(r.costo) || 0,
          // La unidad se busca en la escalera de la sucursal que REGISTRÓ: el rótulo es de su ficha.
          factor: factor(r.sucursal_registro, r.unidad),
        };
      });

      const sucursales = (sucs as { kepler_code: string; nombre: string | null }[]).map((s) => ({
        codigo: s.kepler_code,
        nombre: s.nombre,
      }));
      const trazadas = trazarEntradas(entradas, muestras).map((x) => ({
        ...x,
        // Plaza que no es de Kepler (era Wincaja): se nombra para que se vea POR QUÉ no se compara.
        plaza_sin_kepler: x.plaza ? null : (nombrePlaza.get(x.folio) ?? null),
      }));

      return {
        sku,
        nombre: (producto as { nombre?: string } | undefined)?.nombre ?? null,
        proveedor: (producto as { proveedor?: string } | undefined)?.proveedor ?? null,
        desde,
        hasta,
        sucursales,
        estandar_hoy: escalera
          .filter((x) => Number(x.costo1) > 0)
          .map((x) => ({ sucursal: String(x.sucursal), costo: Number(x.costo1), unidad: x.u1_label }))
          .sort((a, b) => a.sucursal.localeCompare(b.sucursal)),
        estandar_al_inicio: Object.fromEntries(sucursales.map((s) => [s.codigo, estandarEn(muestras, s.codigo, desde)])),
        cambios_estandar: cambiosEstandar(muestras).filter((c) => c.fecha >= desde && c.fecha <= hasta),
        entradas: trazadas,
      };
    });
  }

  /**
   * El universo que comparten el tablero y la tabla: sucursal + texto. **Una sola definición**,
   * porque la forma de llegar a dos cifras que se contradicen es escribir el filtro dos veces.
   *
   * ⚠️ La búsqueda usa `applySmartSearch` y no `LIKE`: el catálogo es de dulcería y está lleno de
   * acentos y eñes — con `lower(...) LIKE '%pina%'` **«PIÑA» no aparece**, y quien busca desde un
   * teléfono no va a escribir la eñe. Es el mismo motor que ya usan otros 15 servicios del repo.
   */
  private universo(trx: Knex.Transaction, f: { sucursal?: string; q?: string }) {
    const q = trx.from('analytics.v_kepler_standard_cost');
    if (f.sucursal) q.where('sucursal', f.sucursal);
    applySmartSearch(q, f.q, { columns: ['sku', 'nombre'] });
    return q;
  }
}
