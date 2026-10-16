/**
 * `[CAT-PRECIO.2]`–`[CAT-PRECIO.5]` Compras › Catálogo: **Precios** (el catálogo de precios de una
 * sucursal, con su cambio automático y la historia de cada precio) y **Mantenimiento › Sin clasificar**.
 *
 * Decisiones de Compras (2026-10-16):
 *  · La sucursal es OBLIGATORIA. Quien tiene alcance de una sola sucursal (encargados, auxiliares,
 *    vendedores) sólo ve la suya; quien tiene varias, elige.
 *  · El margen se ve en pantalla (para que el vendedor lo entienda) y es el de Kepler: ganancia sobre
 *    el costo estándar, con el precio sin impuestos. El COSTO no viaja a la pantalla.
 *  · El PDF es para el cliente: sin margen ni costo.
 *  · Los precios llevan impuestos incluidos (en Kepler, una tasa negativa = el precio ya la incluye).
 *  · «Cambio automático» = el precio estándar por volumen (nivel 0) de cada unidad.
 */

export interface TramoVolumen {
  /** Desde cuántas unidades aplica. */
  desde: number;
  precio: number;
}

/** El último cambio de ese precio en el día consultado (sólo con `cambio_fecha`). */
export interface CambioPrecioDia {
  anterior: number;
  nuevo: number;
  /** % contra el anterior; `null` si el anterior era cero. */
  ajuste_pct: number | null;
  hora: string | null;
}

export interface PrecioUnidad {
  /** 1 = unidad base, 2 y 3 = las siguientes de la ficha. */
  n: 1 | 2 | 3;
  unidad: string;
  /** Cuántas unidades base trae (1 en la base). */
  factor: number;
  /**
   * La conversión, escrita para leerse: «1 PZA», «PAQ = 10 PZA», «CJA = 14 PAQ = 140 PZA». `null` cuando la
   * ficha no trae factor para esa unidad (no se inventa).
   */
  conversion: string | null;
  /** Precio con impuestos. `null` = la ficha no tiene precio en esa unidad. */
  precio: number | null;
  /** Margen Kepler en %: precio sin impuestos sobre costo estándar de esa unidad. `null` = sin costo o sin precio. */
  margen_pct: number | null;
  /** Cambio automático: precio estándar por volumen (nivel 0). Vacío = esa unidad no tiene. */
  volumen: TramoVolumen[];
  codigos: string[];
  cambio: CambioPrecioDia | null;
}

export interface FilaListaPrecios {
  sku: string;
  nombre: string;
  linea: { codigo: string | null; nombre: string | null };
  tipo: { codigo: string | null; nombre: string | null };
  grupo: { codigo: string | null; nombre: string | null };
  /** Tasas tal como las guarda Kepler (negativa = incluida en el precio). */
  iva: number;
  ieps: number;
  unidades: PrecioUnidad[];
}

export type OrdenListaPrecios = 'articulo' | 'linea' | 'tipo' | 'grupo';

/** En los filtros de línea, tipo y grupo, `_` quiere decir «sin asignar» (código vacío). */
export interface ConsultaListaPrecios {
  sucursal?: string;
  q?: string;
  linea?: string;
  tipo?: string;
  grupo?: string;
  /** `YYYY-MM-DD`: sólo los productos que cambiaron de precio ese día en esa sucursal. */
  cambio_fecha?: string;
  orden?: OrdenListaPrecios;
  limite?: number;
  desplazamiento?: number;
  /** `true` = toda la lista filtrada, sin paginar (para el PDF). */
  todo?: boolean;
}

export interface OpcionClasificacion {
  codigo: string;
  nombre: string;
  productos: number;
}

export interface RespuestaListaPrecios {
  /** La sucursal consultada. `null` = la persona tiene varias y todavía no eligió: no hay lista. */
  sucursal: { codigo: string; nombre: string } | null;
  /** Las sucursales que esta persona PUEDE ver (para el selector). */
  sucursales: { codigo: string; nombre: string }[];
  /** `true` = alcance de una sola sucursal: el selector no se ofrece. */
  sucursal_fija: boolean;
  /** Última pasada del espejo de la ficha (`_sync_status` de `kdii`). */
  ficha_al: string | null;
  /** Hasta qué día llegó la bitácora de precios de esa sucursal. */
  bitacora_hasta: string | null;
  /** Opciones de filtro con su conteo (sobre la sucursal, sin los demás filtros). */
  lineas: OpcionClasificacion[];
  tipos: OpcionClasificacion[];
  grupos: OpcionClasificacion[];
  /** Con `cambio_fecha`: cambios de exactamente un centavo que se ocultaron (no mueven la etiqueta). */
  cambios_centavo_ocultos: number;
  /** Con `cambio_fecha`: precios (producto × unidad) que subieron y que bajaron ese día. `null` sin fecha. */
  cambios_resumen: { suben: number; bajan: number } | null;
  total: number;
  filas: FilaListaPrecios[];
}

export interface CambioHistoriaPrecio {
  fecha: string;
  hora: string | null;
  anterior: number;
  nuevo: number;
  /** % contra el anterior; `null` si el anterior era cero. */
  ajuste_pct: number | null;
  /** El precio nuevo es cero: Kepler le quitó el precio, no es una rebaja. */
  es_baja: boolean;
}

export interface RespuestaHistoriaPrecio {
  sku: string;
  nombre: string | null;
  sucursal: { codigo: string; nombre: string };
  unidad: string;
  /** El precio de hoy en la ficha. */
  precio_actual: number | null;
  /** Del más nuevo al más viejo. */
  cambios: CambioHistoriaPrecio[];
  /** Desde cuándo hay bitácora en esa sucursal. */
  bitacora_desde: string | null;
  /** Meses SIN una sola fila en la bitácora de esa sucursal: ahí no se sabe si el precio cambió. */
  meses_sin_registro: string[];
}

export type CampoSinClasificar = 'linea' | 'tipo' | 'grupo';

export interface FilaSinClasificar {
  sku: string;
  nombre: string;
  plazas: number;
  linea: { codigo: string | null; nombre: string | null };
  falta: CampoSinClasificar[];
  venta_30d: number;
}

export interface ConsultaSinClasificar {
  q?: string;
  falta?: CampoSinClasificar;
  linea?: string;
  /** Sólo los que vendieron algo en 30 días. */
  con_venta?: boolean;
  limite?: number;
  desplazamiento?: number;
}

export interface RespuestaSinClasificar {
  ficha_al: string | null;
  /** Productos sin clasificar (búsqueda y venta aplicadas), por lo que les falta. */
  resumen: Record<CampoSinClasificar, number>;
  con_falta: number;
  lineas: OpcionClasificacion[];
  total: number;
  filas: FilaSinClasificar[];
}
