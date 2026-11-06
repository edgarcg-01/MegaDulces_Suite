/**
 * `[FCT.1.1]` `[FCT.1.2]` — El viaje de entrega de Telemarketing y lo que costó, con la verdad de
 * cada lado: la VENTA sale de Kepler (guía `c86` de embarques serie 1, `analytics.v_tlmk_trip_stops`)
 * y el COSTO sale de la captura del viaje en Logística (EMB: `shipments` + `delivery_guides` +
 * `shipment_expenses`, ligados por `kepler_sucursal` + `kepler_guia`).
 *
 * Reemplaza la hoja «RENTABILIDAD TLMKT 2026». Plan: `FASE_FC_ANEXO_RENTABILIDAD_TLMK_2026-11-04.md`.
 *
 * ── Reglas, y por qué ──────────────────────────────────────────────────────────────────────
 *  · Un viaje SIN captura no cuesta $0: sale `sin_captura` y su costo es `null`. La hoja de
 *    Hidalgo pintaba `FALSE` en el costo de la unidad y la suma lo leía como cero.
 *  · «Capturado» es la MISMA regla con que EMB da por buena una guía (`pendientesDeLaGuia`: chofer,
 *    salida y llegada): mientras falte algo, la comisión y los viáticos de la guía valen 0 por
 *    omisión (EMB.22). No se usa `shipments.status = 'cerrado'`: Pagos de viaje completa guías sin
 *    tocar ese status, y todos los viajes capturados ahí se habrían quedado «a medias» para siempre.
 *    Tampoco `v_trip_state`: cierra las paradas contra Kepler y cuesta ~2.5 s (medido 2026-11-04).
 *  · Un viaje con alguna guía incompleta (`a_medias`) no publica costo: una comisión sin sus
 *    viáticos es un costo menor que el real con apariencia de medido.
 *  · ⛔ El costo de la camioneta (desgaste, seguro, sueldo) NO entra todavía: sale de Costo por
 *    unidad (FCU), que no corre en prod. Se DECLARA `unidad: null` y el porcentaje se rotula
 *    «sin la camioneta», nunca como la rentabilidad completa.
 *  · Los viáticos se toman de la guía (`per_diem_total`, lo que se paga), no de
 *    `shipment_expenses.driver_per_diem` (el módulo de gastos viejo): sumar los dos los duplicaba.
 *  · `shipment_expenses.total_cost` NO se usa: le suma `fixed_cost_per_km` de
 *    `config_finance.costo_km_*`, la hoja congelada que FCU.0.6 retira.
 */

/** Una parada (embarque serie 1) tal como la publica `analytics.v_tlmk_trip_stops`. */
export interface ParadaTlmk {
  sucursal: string;
  sucursal_nombre: string | null;
  guia: string;
  fecha: string; // YYYY-MM-DD
  cliente_code: string | null;
  destino_ciudad: string | null;
  vendedor_code: string | null;
  vendedor_nombre: string | null;
  total: number;
}

/** Un embarque de la Suite (EMB, `logistics.shipments`) colgado de un viaje de Kepler. */
export interface CierreGuiaTlmk {
  sucursal: string;
  guia: string;
  shipment_id: string;
  /** El embarque de la Suite se canceló: no cuenta. */
  cancelado: boolean;
  /** Guías de reparto vivas (no borradas ni canceladas). */
  guias: number;
  /** De ésas, cuántas les falta chofer, salida o llegada (`pendientesDeLaGuia`). */
  guias_incompletas: number;
  km: number | null;
  comision_chofer: number;
  comision_auxiliares: number;
  viaticos: number;
  /** Σ de los gastos de ruta capturados; `null` = el viaje no tiene renglón de gastos. */
  gastos_ruta: number | null;
}

export type EstadoCostoViaje = 'sin_captura' | 'a_medias' | 'capturado';

export const ESTADO_COSTO_VIAJE_LABEL: Record<EstadoCostoViaje, string> = {
  sin_captura: 'Sin capturar en Logística',
  a_medias: 'Captura a medias',
  capturado: 'Capturado',
};

export interface CostoViajeTlmk {
  comision_chofer: number;
  comision_auxiliares: number;
  viaticos: number;
  /** `null` = la captura no trae renglón de gastos de ruta (combustible, casetas…): sin dato. */
  gastos_ruta: number | null;
  /** ⛔ Siempre `null` hasta que Costo por unidad (FCU) corra en prod. */
  unidad: null;
  /** Σ de lo registrado (sin la camioneta). */
  registrado: number;
}

export interface VendedorDelViaje { code: string | null; nombre: string | null; venta: number }

export interface ViajeTlmk {
  sucursal: string;
  sucursal_nombre: string | null;
  guia: string;
  fecha: string;
  /** La guía tiene paradas en más de un día (pasa: la guía 1661 de Hidalgo, 6 y 8-oct). */
  fecha_hasta: string;
  paradas: number;
  clientes: number;
  ciudades: string[];
  vendedores: VendedorDelViaje[];
  venta: number;
  estado_costo: EstadoCostoViaje;
  km: number | null;
  costo: CostoViajeTlmk | null;
  /** Costo registrado ÷ venta × 100, sólo con el viaje capturado. Sin la camioneta. */
  pct_registrado: number | null;
}

const centavos = (n: number) => Math.round(n * 100);
const pesos = (c: number) => c / 100;

/** `[FCT.1.1]` Agrupa las paradas por (sucursal, guía) y les pega su captura. */
export function armarViajesTlmk(paradas: ParadaTlmk[], cierres: CierreGuiaTlmk[]): ViajeTlmk[] {
  const llave = (s: string, g: string) => `${s}|${g}`;
  const porViaje = new Map<string, ParadaTlmk[]>();
  for (const p of paradas) {
    const k = llave(p.sucursal, p.guia);
    const lista = porViaje.get(k);
    if (lista) lista.push(p); else porViaje.set(k, [p]);
  }
  const cierresPorViaje = new Map<string, CierreGuiaTlmk[]>();
  for (const c of cierres) {
    // Un embarque cancelado no captura nada: el viaje sigue sin costo.
    if (c.cancelado) continue;
    const k = llave(c.sucursal, c.guia);
    const lista = cierresPorViaje.get(k);
    if (lista) lista.push(c); else cierresPorViaje.set(k, [c]);
  }

  const viajes: ViajeTlmk[] = [];
  for (const [k, ps] of porViaje) {
    const fechas = ps.map((p) => p.fecha).sort();
    const ventaC = ps.reduce((a, p) => a + centavos(p.total), 0);
    const vend = new Map<string, VendedorDelViaje & { c: number }>();
    for (const p of ps) {
      const kv = p.vendedor_code ?? '';
      const v = vend.get(kv) ?? { code: p.vendedor_code, nombre: p.vendedor_nombre, venta: 0, c: 0 };
      v.c += centavos(p.total);
      vend.set(kv, v);
    }
    const cs = cierresPorViaje.get(k) ?? [];
    // Un embarque dado de alta sin guía todavía no tiene a quién pagarle: es captura a medias.
    const estado: EstadoCostoViaje = !cs.length
      ? 'sin_captura'
      : cs.every((c) => c.guias > 0 && c.guias_incompletas === 0) ? 'capturado' : 'a_medias';

    let costo: CostoViajeTlmk | null = null;
    if (estado === 'capturado') {
      const sum = (f: (c: CierreGuiaTlmk) => number) => cs.reduce((a, c) => a + centavos(f(c)), 0);
      const ch = sum((c) => c.comision_chofer);
      const ax = sum((c) => c.comision_auxiliares);
      const vi = sum((c) => c.viaticos);
      const conGastos = cs.filter((c) => c.gastos_ruta != null);
      const ga = conGastos.length ? conGastos.reduce((a, c) => a + centavos(c.gastos_ruta as number), 0) : null;
      costo = {
        comision_chofer: pesos(ch),
        comision_auxiliares: pesos(ax),
        viaticos: pesos(vi),
        gastos_ruta: ga == null ? null : pesos(ga),
        unidad: null,
        registrado: pesos(ch + ax + vi + (ga ?? 0)),
      };
    }
    const kms = cs.map((c) => c.km).filter((x): x is number => x != null);
    const p0 = ps[0];
    viajes.push({
      sucursal: p0.sucursal,
      sucursal_nombre: p0.sucursal_nombre,
      guia: p0.guia,
      fecha: fechas[0],
      fecha_hasta: fechas[fechas.length - 1],
      paradas: ps.length,
      clientes: new Set(ps.map((p) => p.cliente_code).filter(Boolean)).size,
      ciudades: [...new Set(ps.map((p) => p.destino_ciudad?.trim()).filter((x): x is string => !!x))].sort(),
      vendedores: [...vend.values()]
        .sort((a, b) => b.c - a.c)
        .map(({ code, nombre, c }) => ({ code, nombre, venta: pesos(c) })),
      venta: pesos(ventaC),
      estado_costo: estado,
      // Km sólo de la captura: la unidad que Kepler pone en la guía TM no sirve (medido 2026-11-04).
      km: estado === 'capturado' && kms.length === cs.length ? kms.reduce((a, b) => a + b, 0) : null,
      costo,
      pct_registrado: costo && ventaC > 0 ? Math.round((centavos(costo.registrado) / ventaC) * 10000) / 100 : null,
    });
  }
  return viajes.sort((a, b) => (a.fecha === b.fecha ? b.venta - a.venta : a.fecha < b.fecha ? 1 : -1));
}

export interface ResumenEstado { viajes: number; venta: number }

export interface ResumenViajesTlmk {
  viajes: number;
  venta: number;
  por_estado: Record<EstadoCostoViaje, ResumenEstado>;
  /** Σ registrado y su % SOBRE LA VENTA DE LOS CAPTURADOS (no sobre toda la venta). */
  capturados_registrado: number;
  capturados_pct: number | null;
}

/** `[FCT.1.2]` El resumen de una selección. El % se calcula sólo sobre lo que tiene costo. */
export function resumirViajesTlmk(viajes: ViajeTlmk[]): ResumenViajesTlmk {
  const por_estado: Record<EstadoCostoViaje, ResumenEstado> = {
    sin_captura: { viajes: 0, venta: 0 }, a_medias: { viajes: 0, venta: 0 }, capturado: { viajes: 0, venta: 0 },
  };
  const ventaPorEstado: Record<EstadoCostoViaje, number> = { sin_captura: 0, a_medias: 0, capturado: 0 };
  let ventaC = 0;
  let regC = 0;
  for (const v of viajes) {
    por_estado[v.estado_costo].viajes++;
    ventaPorEstado[v.estado_costo] += centavos(v.venta);
    ventaC += centavos(v.venta);
    if (v.costo) regC += centavos(v.costo.registrado);
  }
  for (const e of Object.keys(por_estado) as EstadoCostoViaje[]) por_estado[e].venta = pesos(ventaPorEstado[e]);
  const ventaCapturados = ventaPorEstado.capturado;
  return {
    viajes: viajes.length,
    venta: pesos(ventaC),
    por_estado,
    capturados_registrado: pesos(regC),
    capturados_pct: ventaCapturados > 0 ? Math.round((regC / ventaCapturados) * 10000) / 100 : null,
  };
}

/** Respuesta de `GET /commercial/route-profit/tlmk`. */
export interface ViajesTlmkResponse {
  desde: string;
  hasta: string;
  sucursal: string | null;
  sucursales: { code: string; nombre: string | null }[];
  resumen: ResumenViajesTlmk;
  viajes: ViajeTlmk[];
  /** Hasta dónde llega el dato de Kepler por sucursal (el ODS no trae embarques antes). */
  cobertura: { sucursal: string; desde: string | null }[];
}
