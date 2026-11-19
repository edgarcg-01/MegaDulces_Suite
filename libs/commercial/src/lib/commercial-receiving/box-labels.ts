import {
  avisosDelRenglon,
  estadoDeOrden,
  totalEtiquetas,
  type BoxLabelAvisoTipo,
  type BoxLabelCatalogDefect,
  type BoxLabelLine,
  type BoxLabelLineRow,
  type BoxLabelOrder,
} from '@megadulces/contracts';

/**
 * `[RE.ETQ.2.1]` Armado de la cola de etiquetas de caja: renglones de `analytics.v_box_label_lines` + lo que la
 * bitácora (`commercial.box_label_prints`) sabe de cada uno. Puro: el servicio consulta, esto decide.
 */

/** Un renglón de la vista con las columnas de la orden (las que no se imprimen, D6). */
export interface FilaVista extends BoxLabelLineRow {
  capturada_el: string | null;
  capturada_hora: string | null;
  fecha_documento: string | null;
  vale_folio: string | null;
  vale_capturado_el: string | null;
}

/** Un registro de la bitácora, en lo que la cola necesita. */
export interface FilaBitacora {
  sucursal: string;
  serie: number;
  folio: string;
  linea: number;
  motivo: 'primera' | 'reimpresion';
  consecutivos: number[];
  fecha_etiqueta: string;
  enviada_at: string;
  enviada_por: string | null;
}

const llaveOrden = (r: { sucursal: string; serie: number; folio: string }) => `${r.sucursal}|${r.serie}|${r.folio}`;
const llaveRenglon = (r: { sucursal: string; serie: number; folio: string; linea: number }) => `${llaveOrden(r)}|${r.linea}`;

/** Agrupa los renglones por orden (más reciente primero) y les pega su estado de la bitácora. */
export function armarOrdenes(filas: readonly FilaVista[], bitacora: readonly FilaBitacora[]): BoxLabelOrder[] {
  const porRenglon = new Map<string, FilaBitacora[]>();
  for (const b of bitacora) {
    const k = llaveRenglon(b);
    const arr = porRenglon.get(k);
    if (arr) arr.push(b);
    else porRenglon.set(k, [b]);
  }

  const ordenes = new Map<string, BoxLabelOrder>();
  for (const f of filas) {
    const total = totalEtiquetas(f);
    const registros = porRenglon.get(llaveRenglon(f)) ?? [];
    const enviadas = new Set<number>();
    for (const r of registros) for (const n of r.consecutivos) if (n >= 1 && n <= total) enviadas.add(n);
    const primera = registros.find((r) => r.motivo === 'primera') ?? null;
    const renglon: BoxLabelLine = {
      sucursal: f.sucursal,
      sucursal_nombre: f.sucursal_nombre,
      serie: f.serie,
      folio: f.folio,
      linea: f.linea,
      sku: f.sku,
      nombre: f.nombre,
      unidad: f.unidad,
      unidad_base: f.unidad_base,
      uxc: f.uxc,
      cajas: f.cajas,
      cajas_completas: f.cajas_completas,
      piezas_sueltas: f.piezas_sueltas,
      codigo: f.codigo,
      kepler_unidad_caja: f.kepler_unidad_caja,
      kepler_factor_caja: f.kepler_factor_caja,
      kepler_codigo_caja: f.kepler_codigo_caja,
      sin_catalogo: f.sin_catalogo,
      total_etiquetas: total,
      avisos: avisosDelRenglon(f),
      enviadas: enviadas.size,
      pendientes: Array.from({ length: total }, (_, i) => i + 1).filter((n) => !enviadas.has(n)),
      primera: primera ? { fecha_etiqueta: primera.fecha_etiqueta, enviada_at: primera.enviada_at, usuario: primera.enviada_por } : null,
      reimpresiones: registros.filter((r) => r.motivo === 'reimpresion').length,
    };
    const k = llaveOrden(f);
    let o = ordenes.get(k);
    if (!o) {
      o = {
        sucursal: f.sucursal,
        sucursal_nombre: f.sucursal_nombre,
        serie: f.serie,
        folio: f.folio,
        capturada_el: f.capturada_el,
        capturada_hora: f.capturada_hora,
        fecha_documento: f.fecha_documento,
        vale_folio: f.vale_folio,
        vale_capturado_el: f.vale_capturado_el,
        renglones: [],
        etiquetas_total: 0,
        etiquetas_enviadas: 0,
        estado: 'por_etiquetar',
      };
      ordenes.set(k, o);
    }
    o.renglones.push(renglon);
    o.etiquetas_total += total;
    o.etiquetas_enviadas += enviadas.size;
  }

  const out = [...ordenes.values()];
  for (const o of out) {
    o.renglones.sort((a, b) => a.linea - b.linea);
    o.estado = estadoDeOrden(o.etiquetas_total, o.etiquetas_enviadas);
  }
  // Más reciente primero: la orden que se acaba de capturar es la que está en el andén.
  return out.sort(
    (a, b) =>
      `${b.capturada_el ?? ''} ${b.capturada_hora ?? ''}`.localeCompare(`${a.capturada_el ?? ''} ${a.capturada_hora ?? ''}`) ||
      a.sucursal.localeCompare(b.sucursal) ||
      b.folio.localeCompare(a.folio),
  );
}

/** Los defectos del catálogo de Kepler en lo recibido, por sucursal y producto (lista para Compras). */
export function armarDefectos(filas: readonly FilaVista[]): BoxLabelCatalogDefect[] {
  const TIPOS: BoxLabelAvisoTipo[] = ['kepler_no_lee_codigo', 'catalogo_factor_0', 'catalogo_factor_distinto', 'kepler_caja_otra_unidad', 'sin_catalogo'];
  const m = new Map<string, BoxLabelCatalogDefect>();
  for (const f of filas) {
    const defectos = avisosDelRenglon(f).map((a) => a.tipo).filter((t) => TIPOS.includes(t));
    if (!defectos.length) continue;
    const k = `${f.sucursal}|${f.sku}`;
    const d = m.get(k);
    if (!d) {
      m.set(k, {
        sucursal: f.sucursal,
        sku: f.sku,
        nombre: f.nombre,
        unidad: f.unidad,
        uxc_recibida: f.uxc,
        kepler_factor_caja: f.kepler_factor_caja,
        kepler_codigo_caja: f.kepler_codigo_caja,
        kepler_unidad_caja: f.kepler_unidad_caja,
        defectos,
        renglones: 1,
        ultima_captura: f.capturada_el,
      });
    } else {
      d.renglones += 1;
      for (const t of defectos) if (!d.defectos.includes(t)) d.defectos.push(t);
      if ((f.capturada_el ?? '') > (d.ultima_captura ?? '')) {
        d.ultima_captura = f.capturada_el;
        d.uxc_recibida = f.uxc;
      }
    }
  }
  return [...m.values()].sort((a, b) => b.renglones - a.renglones || a.sucursal.localeCompare(b.sucursal) || a.sku.localeCompare(b.sku));
}
