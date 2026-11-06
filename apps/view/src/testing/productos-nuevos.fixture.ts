import { of } from 'rxjs';
import type { UnidadEscalera } from '@megadulces/contracts';
import type { DetalleNuevo, MargenesNuevo, ProductoNuevo, RespuestaNuevos } from '../app/modules/compras/productos-nuevos.service';
import type { FlujoDetalle } from '../app/modules/compras/productos-flujo.service';

/**
 * `[NP.22]` Los datos de prueba de Productos nuevos: los MISMOS que usaba la pantalla vieja
 * (`compras-catalogo-nuevos.component.spec.ts`), compartidos por las pruebas de sus piezas, que ahora viven en
 * Productos (el resumen, la sección «Lanzamiento» de la ficha y las funciones de `productos-nuevos-vista.ts`).
 */

/**
 * `[NP.UI.3]` El panel pide el veredicto de compra a Productos. Sin este doble la petición quedaría colgada en
 * `HttpClientTesting` y la pantalla nunca se estabiliza. Las pruebas del bloque de compra traen el suyo.
 */
export const PF_MOCK = { detalle: () => of({ product_id: 'p-1', en_vivo_al: '2026-10-07T18:30:05.000Z',
  resumen: { compra: { veredicto: 'esperar', titulo: 'Esperar: alcanza para 34 días', motivos: [], impacto: [], traspasos: [] } } } as unknown as FlujoDetalle) };

/** `[NP.15]` Lista y real medidos; el de lo pagado, sin compras con qué medirlo. */
export const MARGENES: MargenesNuevo = {
  venta_neta: 30000,
  lista: { pct: 17, utilidad: 5100, cobertura: 1, nota: null },
  real: { pct: 10.1, utilidad: 2424, cobertura: 0.8, nota: 'Kepler no registró el costo en el 20% de la venta (suele ser venta de mayoreo)' },
  pagado: { pct: null, utilidad: null, cobertura: 0, nota: 'Sin compras en Kepler dentro de su historia: llegó por traspaso o antes de los 180 días' },
  costo_pagado: null,
};

/** `[NP.16]` Ficha de caja de 12 piezas, como la arma `escaleraUnidades`. */
export const CAJA_12: UnidadEscalera[] = [
  { abr: 'pz', nombre: 'Pieza', factor: 1, rotulo: 'PZA' },
  { abr: 'cj', nombre: 'Caja', factor: 12, rotulo: 'CJA' },
];

export function producto(over: Partial<ProductoNuevo> = {}): ProductoNuevo {
  return {
    product_id: 'p-1', sku: 'NP01', nombre: 'PALETA MANGO', marca: 'DULCERA', proveedor: 'PROV A',
    alta_suite: '2026-08-20', alta_en_lote: false, primera_recepcion: '2026-08-23', primera_venta: '2026-08-24',
    lanzamiento: '2026-08-23', dia: 45, fuentes: ['entradas', 'kepler'], etapa: 'mes_2', estado: 'seguimiento',
    motivo: null, posible_recodificacion: false, clasificacion: null, nota: null, clasificado_por: null,
    hitos: {
      30: { cerrado: true, inversion: 26000, venta: 22260, unidades: { CJA: 10, PZA: 20 } },
      60: { cerrado: false, inversion: 26000, venta: 34185, unidades: { CJA: 22, PZA: 40 } },
      90: { cerrado: false, inversion: 26000, venta: 34185, unidades: { CJA: 22, PZA: 40 } },
    },
    inversion_total: 26000, venta_total: 34185, venta_por_peso: 1.31, entradas: 3, plazas_recibido: 2,
    primera_recompra: '2026-09-17', dia_recompra: 25, plazas_venta: 2, plazas_con_existencia: 1, agotado_en: 1,
    dias_con_venta_30: 28, dias_con_venta_28: 27, venta_28: 20000, tendencia: 1.1, ultima_venta: '2026-10-06',
    sin_venta_30: false, semanas: [1000, 2000, 3000, 2500, 2800, 3100, 900], venta_hoy: 530,
    unidades_vendidas: { PZA: 40, CJA: 22 }, venta_sin_unidad: 0, unidades_recibidas: { CJA: 135 }, unidades_hoy: { CJA: 1 },
    recomendacion: { veredicto: 'se_queda', motivos: ['Se vendió 27 de los últimos 28 días', 'Se agotó en 1 sucursal que lo vende. Si hay que comprar lo dice Productos (por cobertura)'] },
    margenes: MARGENES,
    mejor_plaza: { plaza: '01', nombre: 'Padre Hidalgo', venta_neta_dia: 400, dias: 45 },
    llegada: {
      fecha: '2026-08-21', fuente: 'kardex',
      sucursales: [{ plaza: '01', nombre: 'Padre Hidalgo' }, { plaza: '06', nombre: 'Canindo' }],
      antes: { fecha: '2026-01-29', tipo: 'ajuste de inventario' },
    },
    escalera: CAJA_12, existencia_en_duda: 0,
    ...over,
  };
}

export const FILAS: ProductoNuevo[] = [
  producto(),
  producto({
    product_id: 'p-2', sku: 'NP09', nombre: 'PALOMITAS CARAMELO', inversion_total: null, venta_por_peso: null,
    hitos: {
      30: { cerrado: true, inversion: null, venta: 1320, unidades: {} },
      60: { cerrado: false, inversion: null, venta: 1496, unidades: {} },
      90: { cerrado: false, inversion: null, venta: 1496, unidades: {} },
    },
    sin_venta_30: true, entradas: 0, dia_recompra: null, primera_recompra: null, venta_hoy: 0,
    unidades_vendidas: {}, venta_sin_unidad: 1496, unidades_recibidas: {}, unidades_hoy: {},
    recomendacion: { veredicto: 'revisar', motivos: ['Se vende poco: 5 de los últimos 28 días'] },
  }),
  producto({ product_id: 'p-3', sku: 'DESC1', nombre: 'DESC VOLUMEN', estado: 'excluido', motivo: 'Código de descuento', recomendacion: null }),
];

export const RESPUESTA: RespuestaNuevos = {
  calculado: true,
  frescura: { historia_al: '2026-10-07T12:20:00.000Z', corte: '2026-10-07', en_vivo_al: '2026-10-07T18:30:05.000Z', hoy: '2026-10-07' },
  costo_visible: true,
  criterio: { diasMinimos: 21, ventana: 28, diasConVentaSano: 8, caidaMaxima: 0.6, sinVentaDias: 21 },
  resumen: {
    total: 3, seguimiento: 2, por_confirmar: 2, sin_movimiento: 0, no_medible: 0, excluido: 1,
    por_etapa: { mes_1: 0, mes_2: 2, mes_3: 0, graduado: 0 },
    por_veredicto: { se_queda: 1, revisar: 1, sacar: 0, agotado: 0, pronto: 0 },
    inversion: 26000, venta: 35681, venta_hoy: 530, venta_por_peso: 1.31, recomprados: 1, con_30_dias: 2, sin_venta_30: 1,
  },
  cohortes: [{ mes: '2026-08', productos: 2, con_inversion: 1, inversion: 26000, venta: 35681,
    venta_por_peso: 1.31, recomprados: 1, con_30_dias: 2, sin_venta_30: 1 }],
  filas: FILAS,
};

export const DETALLE: DetalleNuevo = {
  frescura: RESPUESTA.frescura!,
  costo_visible: true,
  producto: FILAS[0],
  plazas: [
    { plaza: '01', nombre: 'Padre Hidalgo', dia: 45, primera_actividad: '2026-08-23', venta_total: 20000, venta_28: 12000,
      dias_con_venta_28: 20, inversion_total: 19000, entradas: 2, primera_recompra: '2026-09-17', existencia: 0,
      existencia_unidad: 'PZA', existencia_fuente: 'kepler', escalera: CAJA_12, existencia_duda: null,
      unidades_vendidas: { CJA: 22 }, venta_sin_unidad: 0, unidades_recibidas: { CJA: 100 }, unidades_hoy: {},
      recibido_traspaso: {}, enviado_sucursales: { CJA: 10 }, enviado_rutas: { PAQ: 4 },
      ultima_venta: '2026-10-06', semanas: [100, 200, 300], venta_hoy: 0,
      recomendacion: { veredicto: 'se_queda', motivos: ['No hay existencia en esta sucursal. Si hay que comprar lo dice Productos (por cobertura)'] },
      margenes: MARGENES, movimiento: { venta_neta_dia: 400, dias: 45, desplazado: 1, lugar: 1 } },
    { plaza: '04', nombre: 'Yurécuaro', dia: 44, primera_actividad: '2026-08-24', venta_total: 14185, venta_28: 8000,
      dias_con_venta_28: 22, inversion_total: 7000, entradas: 1, primera_recompra: null, existencia: 36,
      existencia_unidad: 'PZA', existencia_fuente: 'kepler', escalera: CAJA_12, existencia_duda: null,
      unidades_vendidas: { PZA: 40 }, venta_sin_unidad: 0, unidades_recibidas: { CJA: 35 }, unidades_hoy: { PZA: 2 },
      recibido_traspaso: { CJA: 10 }, enviado_sucursales: {}, enviado_rutas: {},
      ultima_venta: '2026-10-07', semanas: [100, 150, 120], venta_hoy: 530,
      recomendacion: { veredicto: 'se_queda', motivos: ['Se vendió 22 de los últimos 28 días'] },
      margenes: null, movimiento: { venta_neta_dia: 290.5, dias: 44, desplazado: 0.9, lugar: 2 } },
  ],
};
