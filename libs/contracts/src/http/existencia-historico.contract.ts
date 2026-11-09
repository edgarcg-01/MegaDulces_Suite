/**
 * `[EX.H1]` «Consulta históricos» de Existencia: **cuánto valía el inventario de cada sucursal al
 * cierre de cada día**, valuado a costo estándar de Kepler (decisión D1 de Francisco, 2026-11-06).
 * Reemplaza la hoja de Google de Compras (filas = sucursal, columnas = días).
 *
 * La fuente es la foto diaria de las 23:50 (`analytics.stock_snapshots` + `_coverage`, AB.0b):
 *  · desde `[EX.H0]` la foto guarda su propio costo estándar del día → `costo_reconstruido = false`;
 *  · antes, el estándar se reconstruye con `analytics.product_cost_history` (historia desde el
 *    2026-10-17; para días anteriores se usa el primer estándar conocido y se CUENTA cuántos
 *    productos se valuaron así) → `costo_reconstruido = true`. ⚠️ El testigo de unidad de esa
 *    reconstrucción es el costo del ERP del día en que se CONSULTA: un día reconstruido puede moverse
 *    un poco con el tiempo (medido: hasta 2.2 % en un almacén×día entre el 4 y el 6 de noviembre).
 *
 * Lo que se DECLARA y nunca se dibuja como cero (ADR-056):
 *  · un día sin foto de un almacén → `sin_foto`; el de hoy, antes de las 23:50 → `pendiente`;
 *  · el CEDIS antes de EX.H0: la foto leía `commercial.stock` y repetía el mismo saldo todos los días
 *    (205 pares contra los 304 reales, medido 2026-11-06). `[EX.H4]` Desde que el CEDIS opera en
 *    Kepler (corte del 2026-09-30) su existencia de cada día se RECONSTRUYE con el kardex
 *    (`existencia_reconstruida = true`); antes operaba en Wincaja, cuya existencia no casa con la de
 *    Kepler (unidad y productos distintos), y esos días siguen `no_confiable`;
 *  · los productos sin estándar o con unidad dudosa no se suman: se cuentan en `productos_sin_valuar`,
 *    por celda y en el total;
 *  · el total del día suma SÓLO celdas `medido` y dice qué almacenes quedaron fuera;
 *  · si el rango pedido se ajustó (fechas inválidas, al revés, futuras o de más de 400 días), `rango`
 *    lo dice.
 *
 * Esto es la forma de lo que viaja y las reglas puras, compartidas por el servidor y la pantalla.
 */

/** Un almacén (columna de la hoja de Compras), por nombre y en el orden de la red. */
export interface HistoricoAlmacen {
  code: string;
  name: string;
  /** El rótulo corto de la pantalla Existencia (PH, MA, 8ES…). */
  label: string;
}

export type HistoricoCeldaEstado = 'medido' | 'sin_foto' | 'pendiente' | 'no_confiable';

/** Un almacén en un día. */
export interface HistoricoCelda {
  warehouse_code: string;
  estado: HistoricoCeldaEstado;
  /**
   * Por qué no es `medido`, en palabras para la pantalla. Si es `medido`, `null` — salvo cuando la
   * existencia no salió de la foto (`existencia_reconstruida`): entonces dice de dónde salió.
   */
  motivo: string | null;
  /** Pesos SIN impuesto: suma de lo que SÍ se pudo valuar. `null` = sin foto (no medido, no cero). */
  valor_estandar: number | null;
  /** Productos con existencia ≠ 0 ese día. */
  productos_con_existencia: number | null;
  /** Productos con existencia que NO suman: sin estándar o con unidad dudosa. */
  productos_sin_valuar: number | null;
  /** `true` = día anterior a EX.H0: el estándar se reconstruyó con su historia. */
  costo_reconstruido: boolean;
  /**
   * `[EX.H4]` `true` = la EXISTENCIA no es la de la foto: se reconstruyó con el kardex de Kepler (hoy la
   * existencia del ERP menos los movimientos posteriores a ese día). Sólo el CEDIS, en los días en que
   * su foto estaba congelada y ya operaba en Kepler.
   */
  existencia_reconstruida: boolean;
  /**
   * Productos valuados con un estándar POSTERIOR al día (antes del 2026-10-17 no hay historia y se
   * usa el primero conocido). 0 cuando no aplica; `null` sin foto.
   */
  productos_costo_posterior: number | null;
}

/** El total de un día: sólo lo `medido`, y lo que quedó fuera con nombre. */
export interface HistoricoTotal {
  /** `null` si ningún almacén se pudo sumar ese día (no 0). */
  valor_estandar: number | null;
  almacenes_sumados: number;
  /** Códigos que NO entraron al total (sin foto, pendiente, no confiable o sin valor). */
  almacenes_fuera: string[];
  /**
   * `true` sólo si entraron TODOS los almacenes de la respuesta. ⚠️ No dice que la suma esté
   * completa: dentro de cada almacén puede haber productos sin valuar (`productos_sin_valuar`).
   */
  todos_los_almacenes: boolean;
  /** Productos con existencia que no se sumaron, dentro de los almacenes sumados. */
  productos_sin_valuar: number;
  /** Productos sumados con un estándar posterior al día, dentro de los almacenes sumados. */
  productos_costo_posterior: number;
  /** `true` si algún almacén sumado lleva el costo reconstruido. */
  costo_reconstruido: boolean;
}

export interface HistoricoDia {
  /** `YYYY-MM-DD`, el día del cierre (la foto de las 23:50 de ese día). */
  fecha: string;
  cierre_semana: boolean;
  cierre_mes: boolean;
  cierre_trimestre: boolean;
  cierre_anio: boolean;
  /** Una por almacén, en el MISMO orden que `ExistenciaHistorico.almacenes`. */
  celdas: HistoricoCelda[];
  total: HistoricoTotal;
}

/** La respuesta de `GET /commercial/inventory/stock-snapshot/historico`. */
export interface ExistenciaHistorico {
  desde: string;
  hasta: string;
  /** Lo pedido y si se ajustó: la pantalla no debe mostrar otro rango sin decirlo. */
  rango: {
    pedido_desde: string | null;
    pedido_hasta: string | null;
    ajustado: boolean;
    /** En palabras: por qué el rango no es el pedido. `null` si no se ajustó. */
    motivo: string | null;
  };
  almacenes: HistoricoAlmacen[];
  /** Todos los días del rango, el más reciente primero; un día sin foto viene con celdas `sin_foto`. */
  dias: HistoricoDia[];
  metodo: {
    costo: 'estandar_kepler_sin_impuesto';
    /** Desde cuándo hay historia del estándar (antes se usa el primero conocido). */
    historia_estandar_desde: string | null;
    /** El primer día con foto. Antes de esa fecha no hay nada que mostrar. */
    foto_desde: string | null;
    /**
     * `[EX.H4]` Desde qué día la existencia congelada del CEDIS se reconstruye con el kardex de Kepler
     * (su corte de Wincaja a Kepler). Antes, `no_confiable`. `null` = el CEDIS no opera en Kepler.
     */
    cedis_kardex_desde: string | null;
  };
  /** La última foto tomada y su latido, para la frescura de la pantalla. */
  ultima_foto: {
    fecha: string | null;
    /** Cuándo terminó DE VERDAD la última corrida de la foto (su latido), no una hora supuesta. */
    hecha_en: string | null;
    estado: string | null;
    nota: string | null;
  };
}

/** Por qué un producto con existencia no entró al valor. */
export type HistoricoSinValor = 'sin_estandar' | 'unidad_dudosa';

/** Un producto de un almacén en un día (el desglose de una celda). */
export interface HistoricoDetalleProducto {
  product_id: string;
  sku: string;
  nombre: string;
  /** La existencia de ese cierre, en la unidad del ERP de ese almacén (pieza, paquete o caja según el SKU). */
  unidades: number;
  /**
   * El rótulo de esa unidad (PZA, PAQ, CJA, KG…), cuando se conoce: en los días reconstruidos es el
   * peldaño del estándar que casa con el costo del ERP. `null` = no se guardó (días con la foto de EX.H0).
   */
  unidad: string | null;
  /** Costo estándar sin impuesto, en la MISMA unidad que `unidades`. `null` si no se pudo valuar. */
  costo_estandar: number | null;
  /** `unidades × costo_estandar`; `null` si no se pudo valuar (nunca 0). */
  valor: number | null;
  /** Por qué no suma. `null` si suma. */
  sin_valor: HistoricoSinValor | null;
  /** `true` = el estándar es POSTERIOR a ese día (antes del 2026-10-17 se usa el primero conocido). */
  costo_posterior: boolean;
}

/** La respuesta de `GET /commercial/inventory/stock-snapshot/historico/detalle`. */
export interface ExistenciaHistoricoDetalle {
  fecha: string;
  almacen: HistoricoAlmacen;
  estado: HistoricoCeldaEstado;
  motivo: string | null;
  costo_reconstruido: boolean;
  /** `[EX.H4]` La existencia salió del kardex de Kepler, no de la foto (ver `HistoricoCelda`). */
  existencia_reconstruida: boolean;
  /** Todos los productos con existencia ese día, del mayor valor al menor; los que no suman, al final. */
  productos: HistoricoDetalleProducto[];
  /** Lo que suman los productos: debe coincidir con la celda de la tabla. */
  valor_estandar: number | null;
  productos_sin_valuar: number;
}

/** Días por defecto y tope del rango: un año y un mes cubre «este año contra el anterior» por cierre. */
export const HISTORICO_DIAS_DEFECTO = 30;
export const HISTORICO_DIAS_MAX = 400;

/** El código del CEDIS: el único almacén cuya foto anterior a EX.H0 no es confiable. */
export const HISTORICO_CEDIS = '00';
/** Lo que la cobertura anterior a EX.H0 declara como fuente. */
export const HISTORICO_FUENTE_VIEJA = 'commercial.stock';

const FECHA_RX = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` ± n días, en UTC (fechas de calendario, sin hora: no hay zona que mover). */
export function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function esFechaValida(f: string | null | undefined): f is string {
  if (!f || !FECHA_RX.test(f)) return false;
  return sumarDias(f, 0) === f; // descarta 2026-02-31 y similares
}

/**
 * Pura. El rango que se consulta, y si se ajustó lo pedido:
 *  · por defecto, los 30 días que terminan AYER: el cierre de hoy se fotografía a las 23:50, así que
 *    una columna de hoy saldría «pendiente» casi todo el día;
 *  · fechas inválidas se ignoran; al revés se ordenan; nada pasa de hoy (no hay fotos del futuro);
 *  · máximo 400 días contando desde `hasta`.
 * Todo ajuste a lo PEDIDO se declara en `ajustado`/`motivo` (los valores por defecto no son ajuste).
 */
export function rangoHistorico(
  q: { desde?: string | null; hasta?: string | null },
  hoy: string,
): { desde: string; hasta: string; ajustado: boolean; motivo: string | null } {
  const motivos: string[] = [];
  const pd = esFechaValida(q.desde) ? q.desde : null;
  const ph = esFechaValida(q.hasta) ? q.hasta : null;
  if (q.desde && !pd) motivos.push(`la fecha inicial «${q.desde}» no es válida`);
  if (q.hasta && !ph) motivos.push(`la fecha final «${q.hasta}» no es válida`);

  let hasta = ph ?? sumarDias(hoy, -1);
  let desde = pd;
  if (desde && desde > hasta) {
    [desde, hasta] = [hasta, desde];
    motivos.push('las fechas venían al revés');
  }
  if (hasta > hoy) {
    hasta = hoy;
    motivos.push('no hay fotos del futuro: el rango termina hoy');
  }
  if (!desde) desde = sumarDias(hasta, -(HISTORICO_DIAS_DEFECTO - 1));
  if (desde > hasta) desde = hasta;
  const minimo = sumarDias(hasta, -(HISTORICO_DIAS_MAX - 1));
  if (desde < minimo) {
    desde = minimo;
    motivos.push(`el máximo es ${HISTORICO_DIAS_MAX} días`);
  }
  return { desde, hasta, ajustado: motivos.length > 0, motivo: motivos.length ? motivos.join(' · ') : null };
}

/**
 * Pura. Las banderas de cierre de un día, con la MISMA definición que la foto (`stock-snapshot.service.ts`):
 * semana = domingo · mes = último día del mes · trimestre = último de mar/jun/sep/dic · año = 31-dic.
 * Hace falta para los días SIN foto, que no traen sus banderas de la base.
 */
export function banderasDeCierre(fecha: string): {
  cierre_semana: boolean; cierre_mes: boolean; cierre_trimestre: boolean; cierre_anio: boolean;
} {
  const d = new Date(`${fecha}T00:00:00Z`);
  const mesSig = sumarDias(fecha, 1).slice(5, 7);
  const finMes = mesSig !== fecha.slice(5, 7);
  const mes = d.getUTCMonth() + 1;
  return {
    cierre_semana: d.getUTCDay() === 0,
    cierre_mes: finMes,
    cierre_trimestre: finMes && mes % 3 === 0,
    cierre_anio: finMes && mes === 12,
  };
}

/** Cómo se agrupan las columnas en pantalla: cada día, los cierres de semana o los de mes. */
export type HistoricoVista = 'dias' | 'semanas' | 'meses';

/** El rango que abre cada vista, en días contados hacia atrás desde `hasta` (la hoja de Compras va por semana). */
export const HISTORICO_DIAS_POR_VISTA: Readonly<Record<HistoricoVista, number>> = {
  dias: 7,
  semanas: 7 * 12,
  meses: 7 * 57, // 399 días: el último año y su mes espejo, dentro del tope de 400
};

/**
 * Pura. Los días que se muestran como columnas, del más VIEJO al más nuevo (como la hoja): en
 * `dias` todos; en `semanas` los domingos; en `meses` el último día de cada mes. Siempre entran,
 * aunque no sean cierre, el día más reciente del rango y el más reciente CON VALOR: si el último día
 * quedó sin foto o pendiente, el último cierre real no puede desaparecer de la vista.
 */
export function cierresDeVista<T extends {
  fecha: string; cierre_semana: boolean; cierre_mes: boolean; total?: { valor_estandar: number | null };
}>(
  dias: T[],
  vista: HistoricoVista,
): T[] {
  if (!dias.length) return [];
  const masReciente = dias.reduce((a, b) => (b.fecha > a.fecha ? b : a));
  const conValor = dias.filter((d) => d.total?.valor_estandar != null);
  const masRecienteConValor = conValor.length ? conValor.reduce((a, b) => (b.fecha > a.fecha ? b : a)) : null;
  const elegidos = dias.filter((d) =>
    vista === 'dias' || d === masReciente || d === masRecienteConValor
    || (vista === 'semanas' ? d.cierre_semana : d.cierre_mes));
  return [...elegidos].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Pura. Todos los días de `desde` a `hasta`, el más reciente primero. */
export function diasDelRango(desde: string, hasta: string): string[] {
  const out: string[] = [];
  for (let f = hasta; f >= desde; f = sumarDias(f, -1)) out.push(f);
  return out;
}

/**
 * Pura. `[EX.H4]` El tramo que abarca un conjunto de fechas (`AAAA-MM-DD`, en cualquier orden):
 * primera, última, cuántos cierres trae y cuántos días del tramo NO están (huecos). Sirve para que
 * un aviso no afirme «del X al Y» sobre días que no le corresponden (p. ej. un día sin foto).
 */
export function tramoDeFechas(fechas: string[]): { primera: string; ultima: string; cierres: number; huecos: number } | null {
  const unicas = [...new Set(fechas)].sort();
  if (!unicas.length) return null;
  const primera = unicas[0];
  const ultima = unicas[unicas.length - 1];
  return { primera, ultima, cierres: unicas.length, huecos: diasDelRango(primera, ultima).length - unicas.length };
}

/**
 * Pura. El estado de un almacén en un día:
 *  · sin cobertura y el día es hoy (o después) → `pendiente`: la foto se toma a las 23:50;
 *  · sin cobertura antes del primer día con foto → `sin_foto`, diciendo desde cuándo hay;
 *  · sin cobertura → `sin_foto` (ese día no se fotografió ese almacén);
 *  · CEDIS con la fuente vieja (la foto repetía un saldo congelado):
 *      - desde `kardex_desde` (ya opera en Kepler) → `medido`, con la existencia del kardex
 *        (`existencia_reconstruida`) y el motivo que lo dice;
 *      - antes, o sin `kardex_desde` → `no_confiable`;
 *  · si no → `medido`.
 */
export function estadoCelda(i: {
  cubierto: boolean;
  warehouse_code: string;
  stock_source: string | null;
  fecha: string;
  hoy: string;
  foto_desde: string | null;
  /** `[EX.H4]` El corte del CEDIS a Kepler: desde ahí su existencia sale del kardex. */
  kardex_desde?: string | null;
}): { estado: HistoricoCeldaEstado; motivo: string | null; existencia_reconstruida: boolean } {
  const no = false;
  if (!i.cubierto) {
    if (i.fecha >= i.hoy) return { estado: 'pendiente', motivo: 'La foto de este día se toma a las 23:50.', existencia_reconstruida: no };
    if (i.foto_desde && i.fecha < i.foto_desde) {
      return { estado: 'sin_foto', motivo: `La foto diaria empezó el ${i.foto_desde}; antes no hay foto.`, existencia_reconstruida: no };
    }
    return { estado: 'sin_foto', motivo: 'Ese día no se tomó la foto de este almacén.', existencia_reconstruida: no };
  }
  if (i.warehouse_code === HISTORICO_CEDIS && (i.stock_source ?? HISTORICO_FUENTE_VIEJA) === HISTORICO_FUENTE_VIEJA) {
    const desde = i.kardex_desde && FECHA_RX.test(i.kardex_desde) ? i.kardex_desde : null;
    if (desde && i.fecha >= desde) {
      return {
        estado: 'medido',
        motivo: 'La foto de ese día repetía un saldo congelado: la existencia se reconstruyó con el kardex de Kepler (la de hoy menos los movimientos posteriores a ese día).',
        existencia_reconstruida: true,
      };
    }
    return {
      estado: 'no_confiable',
      motivo: desde
        ? `Hasta el ${sumarDias(desde, -1)} el CEDIS operaba en Wincaja y la foto repetía un saldo congelado; la existencia de Wincaja no casa con la de Kepler (unidad y productos distintos), así que esos días no se reconstruyen.`
        : 'Antes de que la foto leyera la existencia del ERP, la del CEDIS repetía un saldo congelado: no es su existencia de ese día.',
      existencia_reconstruida: no,
    };
  }
  return { estado: 'medido', motivo: null, existencia_reconstruida: no };
}

/**
 * Pura. El total de un día: suma SÓLO las celdas `medido` con valor, nombra las que quedaron fuera y
 * arrastra lo que dentro de ellas no se sumó. Si ninguna se pudo sumar, el total es `null` — nunca 0.
 */
export function totalDelDia(celdas: HistoricoCelda[]): HistoricoTotal {
  let suma = 0;
  let sumados = 0;
  let sinValuar = 0;
  let posterior = 0;
  let reconstruido = false;
  const fuera: string[] = [];
  for (const c of celdas) {
    if (c.estado === 'medido' && c.valor_estandar != null && Number.isFinite(c.valor_estandar)) {
      suma += c.valor_estandar;
      sumados++;
      sinValuar += c.productos_sin_valuar ?? 0;
      posterior += c.productos_costo_posterior ?? 0;
      reconstruido = reconstruido || c.costo_reconstruido;
    } else {
      fuera.push(c.warehouse_code);
    }
  }
  return {
    valor_estandar: sumados ? Math.round(suma * 100) / 100 : null,
    almacenes_sumados: sumados,
    almacenes_fuera: fuera,
    todos_los_almacenes: celdas.length > 0 && fuera.length === 0,
    productos_sin_valuar: sinValuar,
    productos_costo_posterior: posterior,
    costo_reconstruido: reconstruido,
  };
}
