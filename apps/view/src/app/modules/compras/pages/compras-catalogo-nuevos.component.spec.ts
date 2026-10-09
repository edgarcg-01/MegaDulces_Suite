import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import {
  DetalleNuevo,
  MargenesNuevo,
  PlazaNueva,
  ProductoNuevo,
  ProductosNuevosService,
  RespuestaNuevos,
} from '../productos-nuevos.service';
import {
  ComprasCatalogoNuevosComponent,
  cantidadTexto,
  cantidadPartes,
  existenciaPartes,
  existenciaTexto,
  leLlego,
  listaUnidades,
  fechaCorta,
  hitoVisible,
  margenTexto,
  ordenMovimiento,
  ordenReparto,
  sucursalesTexto,
  tresMargenes,
  pasaBusqueda,
  pasaFiltro,
  semanasCerradas,
  tendenciaTexto,
  textoUnidades,
} from './compras-catalogo-nuevos.component';
import { escaleraUnidades, type UnidadEscalera } from '@megadulces/contracts';

/** `[NP.15]` Lista y real medidos; el de lo pagado, sin compras con qué medirlo. */
const MARGENES: MargenesNuevo = {
  venta_neta: 30000,
  lista: { pct: 17, utilidad: 5100, cobertura: 1, nota: null },
  real: { pct: 10.1, utilidad: 2424, cobertura: 0.8, nota: 'Kepler no registró el costo en el 20% de la venta (suele ser venta de mayoreo)' },
  pagado: { pct: null, utilidad: null, cobertura: 0, nota: 'Sin compras en Kepler dentro de su historia: llegó por traspaso o antes de los 180 días' },
  costo_pagado: null,
};

/** `[NP.16]` Ficha de caja de 12 piezas, como la arma `escaleraUnidades`. */
const CAJA_12: UnidadEscalera[] = [
  { abr: 'pz', nombre: 'Pieza', factor: 1, rotulo: 'PZA' },
  { abr: 'cj', nombre: 'Caja', factor: 12, rotulo: 'CJA' },
];

function producto(over: Partial<ProductoNuevo> = {}): ProductoNuevo {
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
    recomendacion: { veredicto: 'recomprar', motivos: ['Se vendió 27 de los últimos 28 días', 'Se agotó en 1 plaza que lo vende'] },
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

const FILAS: ProductoNuevo[] = [
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
    recomendacion: { veredicto: 'esperar', motivos: ['Se vende bien, pero todavía hay existencia'] },
  }),
  producto({ product_id: 'p-3', sku: 'DESC1', nombre: 'DESC VOLUMEN', estado: 'excluido', motivo: 'Código de descuento', recomendacion: null }),
];

const RESPUESTA: RespuestaNuevos = {
  calculado: true,
  frescura: { historia_al: '2026-10-07T12:20:00.000Z', corte: '2026-10-07', en_vivo_al: '2026-10-07T18:30:05.000Z', hoy: '2026-10-07' },
  costo_visible: true,
  criterio: { diasMinimos: 21, ventana: 28, diasConVentaSano: 8, caidaMaxima: 0.6, recuperadoAlto: 0.8, sinVentaDias: 21 },
  resumen: {
    total: 3, seguimiento: 2, por_confirmar: 2, sin_movimiento: 0, no_medible: 0, excluido: 1,
    por_etapa: { mes_1: 0, mes_2: 2, mes_3: 0, graduado: 0 },
    por_veredicto: { recomprar: 1, esperar: 1, revisar: 0, no_recomprar: 0, pronto: 0 },
    inversion: 26000, venta: 35681, venta_hoy: 530, venta_por_peso: 1.31, recomprados: 1, con_30_dias: 2, sin_venta_30: 1,
  },
  cohortes: [{ mes: '2026-08', productos: 2, con_inversion: 1, inversion: 26000, venta: 35681,
    venta_por_peso: 1.31, recomprados: 1, con_30_dias: 2, sin_venta_30: 1 }],
  filas: FILAS,
};

const DETALLE: DetalleNuevo = {
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
      recomendacion: { veredicto: 'recomprar', motivos: ['Se agotó en 1 plaza que lo vende'] },
      margenes: MARGENES, movimiento: { venta_neta_dia: 400, dias: 45, desplazado: 1, lugar: 1 } },
    { plaza: '04', nombre: 'Yurécuaro', dia: 44, primera_actividad: '2026-08-24', venta_total: 14185, venta_28: 8000,
      dias_con_venta_28: 22, inversion_total: 7000, entradas: 1, primera_recompra: null, existencia: 36,
      existencia_unidad: 'PZA', existencia_fuente: 'kepler', escalera: CAJA_12, existencia_duda: null,
      unidades_vendidas: { PZA: 40 }, venta_sin_unidad: 0, unidades_recibidas: { CJA: 35 }, unidades_hoy: { PZA: 2 },
      recibido_traspaso: { CJA: 10 }, enviado_sucursales: {}, enviado_rutas: {},
      ultima_venta: '2026-10-07', semanas: [100, 150, 120], venta_hoy: 530,
      recomendacion: { veredicto: 'esperar', motivos: ['Se vende bien, pero todavía hay existencia'] },
      margenes: null, movimiento: { venta_neta_dia: 290.5, dias: 44, desplazado: 0.9, lugar: 2 } },
  ],
};

const tick = async (fix: ComponentFixture<unknown>) => {
  fix.detectChanges();
  await fix.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fix.detectChanges();
};

describe('[NP.5] funciones puras de Productos nuevos', () => {
  it('el filtro por recomendación sólo toma productos en seguimiento', () => {
    expect(FILAS.filter((f) => pasaFiltro(f, 'recomprar')).map((f) => f.sku)).toEqual(['NP01']);
    expect(FILAS.filter((f) => pasaFiltro(f, 'seguimiento')).length).toBe(2);
    expect(FILAS.filter((f) => pasaFiltro(f, 'excluido')).map((f) => f.sku)).toEqual(['DESC1']);
    expect(FILAS.filter((f) => pasaFiltro(f, 'sin_venta_30')).map((f) => f.sku)).toEqual(['NP09']);
  });

  it('el hito se ve si ya cerró o es el tramo en curso', () => {
    expect([hitoVisible(45, 30), hitoVisible(45, 60), hitoVisible(45, 90), hitoVisible(null, 30)])
      .toEqual([true, true, false, false]);
  });

  it('⛔ la fecha NO se corre un día por la zona horaria', () => {
    expect(fechaCorta('2026-09-01')).toMatch(/^1 /);
  });

  it('⛔ la existencia va en cajas completas y lo demás en la base, y la caja sólo si la ficha la declara', () => {
    const k = { existencia_fuente: 'kepler' as const, existencia_duda: null };
    expect(existenciaTexto({ ...k, existencia: 36, existencia_unidad: 'PZA', escalera: CAJA_12 })).toBe('Hay 3 cajas');
    expect(existenciaTexto({ ...k, existencia: 13, existencia_unidad: 'PZA', escalera: CAJA_12 })).toBe('Hay 1 caja y 1 pieza');
    expect(existenciaTexto({ ...k, existencia: 36, existencia_unidad: 'PZA', escalera: null })).toBe('Hay 36 piezas');
    expect(existenciaTexto({ ...k, existencia: 36, existencia_unidad: null, escalera: CAJA_12 }))
      .toBe('Hay 36 (unidad sin declarar en Kepler)');
    expect(existenciaTexto({ ...k, existencia: 50, existencia_unidad: null, existencia_fuente: 'wincaja', escalera: null }))
      .toBe('Hay 50 unidades de Wincaja');
    expect(existenciaTexto({ ...k, existencia: 0, existencia_unidad: 'PZA', escalera: CAJA_12 })).toBe('Agotado');
    expect(existenciaTexto({ ...k, existencia: null, existencia_unidad: null, escalera: null })).toBe('Sin existencia registrada');
  });

  it('⭐ existencia en duda: lo que dice Kepler y, aparte, lo que debería haber según el kardex', () => {
    const p = { existencia_fuente: 'kepler' as const, existencia: 0, existencia_unidad: 'PZA', escalera: CAJA_12,
      existencia_duda: { kepler: -3, estimada: 1500, base: 'PZA', otros: ['PAQ'] } };
    expect(existenciaTexto(p)).toBe('En duda: Kepler dice agotado; según el kardex hay 125 cajas');
    const e = existenciaPartes(p);
    expect(e.estado).toBe('en_duda');
    expect(e.kepler).toBe('Agotado');
    expect(e.motivo).toContain('Kepler sumó paquetes como si fueran piezas');
    // Sin estimada (un rótulo que no se pudo convertir): se dice que no alcanza, no se inventa.
    expect(existenciaTexto({ ...p, existencia: 13, existencia_duda: { kepler: 13, estimada: null, base: 'PZA', otros: ['500'] } }))
      .toBe('En duda: Kepler dice 1 caja y 1 pieza; el kardex no alcanza para estimarla');
  });

  it('⭐ las unidades se dicen como Kepler las registró, de lo grande a lo chico, sin sumarse', () => {
    expect(textoUnidades({ PZA: 40, CJA: 3, PAQ: 1 })).toBe('3 cajas · 1 paquete · 40 piezas');
    expect(textoUnidades({ KG: 2.5 })).toBe('2.5 kg');
    expect(textoUnidades({ CJA: 1 })).toBe('1 caja');
    expect(textoUnidades({})).toBe('');
  });

  it('⛔ un gramaje no es una unidad, uno desconocido va crudo, y sin rótulo no es "pieza"', () => {
    expect(cantidadTexto(6, '500')).toBe('6 de 500 g');
    expect(cantidadTexto(2, 'SER')).toBe('2 SER');
    expect(cantidadTexto(4, '?')).toBe('4 sin unidad');
    expect(cantidadTexto(4, null)).toBe('4 sin unidad');
  });

  it('la tendencia se dice en palabras, y sin 8 semanas no se inventa', () => {
    expect(tendenciaTexto(1.1)).toContain('+10%');
    expect(tendenciaTexto(0.5)).toContain('-50%');
    expect(tendenciaTexto(null)).toContain('Sin 8 semanas');
  });

  it('⛔ la semana en curso NO se grafica: haría parecer que la venta se desploma', () => {
    // Día 45 = 46 días de serie = 6 semanas completas + 4 días de la séptima.
    expect(semanasCerradas([7, 7, 7, 7, 7, 7, 2], 45)).toEqual([7, 7, 7, 7, 7, 7]);
    // Día 13 = 14 días = 2 semanas exactas: nada que quitar.
    expect(semanasCerradas([7, 7], 13)).toEqual([7, 7]);
    expect(semanasCerradas([3], 2)).toEqual([]);
    expect(semanasCerradas([], null)).toEqual([]);
  });

  it('la búsqueda mira SKU, nombre, marca y proveedor', () => {
    expect(pasaBusqueda(FILAS[0], 'prov a')).toBe(true);
    expect(pasaBusqueda(FILAS[0], 'chicle')).toBe(false);
    // Varias palabras, en cualquier orden y de campos distintos (nombre + SKU).
    expect(pasaBusqueda(FILAS[0], 'mango np01')).toBe(true);
    expect(pasaBusqueda(FILAS[0], 'mango chicle')).toBe(false);
    // Sin importar acentos.
    expect(pasaBusqueda(producto({ nombre: 'PALETA PIÑA' }), 'pina')).toBe(true);
  });
});

describe('[NP.5] ComprasCatalogoNuevosComponent', () => {
  let fix: ComponentFixture<ComprasCatalogoNuevosComponent>;
  let api: { listar: ReturnType<typeof vi.fn>; detalle: ReturnType<typeof vi.fn> };

  async function montar(respuesta: unknown) {
    api = { listar: vi.fn(() => respuesta), detalle: vi.fn(() => of(DETALLE)) };
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoNuevosComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ProductosNuevosService, useValue: api },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCatalogoNuevosComponent);
    await tick(fix);
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('mientras la historia no se calcula lo DICE, en vez de pintar ceros', async () => {
    const el = await montar(of({ ...RESPUESTA, calculado: false, resumen: null, cohortes: [], filas: [] }));
    expect(el.querySelector('.pn-aviso')?.textContent).toContain('se están calculando por primera vez');
    // [NP.13] Se refresca cada 30 min: ya no se manda a nadie a volver mañana.
    expect(el.querySelector('.pn-aviso')?.textContent).not.toContain('mañana');
    expect(el.querySelector('.pn-titular')).toBeNull();
  });

  it('la respuesta dice cuántos conviene recomprar, y la franja dice que es en vivo', async () => {
    const el = await montar(of(RESPUESTA));
    expect(el.querySelector('.pn-titular')?.textContent).toContain('conviene volver a comprar 1');
    expect(el.querySelector('.pn-vivo')?.textContent).toContain('En vivo');
    expect(el.querySelector('.pn-sub')?.textContent).toContain('Hoy van');
  });

  it('el chip de una recomendación filtra la lista, y volver a tocarlo la limpia', async () => {
    const el = await montar(of(RESPUESTA));
    const esperar = Array.from(el.querySelectorAll<HTMLButtonElement>('.pn-ver')).find((b) => b.textContent?.includes('Esperar'));
    esperar?.click();
    await tick(fix);
    expect(Array.from(el.querySelectorAll('.pn-prod')).map((x) => x.textContent?.trim())).toEqual(['PALOMITAS CARAMELO']);
    esperar?.click();
    await tick(fix);
    expect(el.querySelectorAll('.pn-prod').length).toBe(2);
  });

  it('⛔ inversión no medida se escribe como tal, nunca como $0', async () => {
    const el = await montar(of(RESPUESTA));
    const fila = Array.from(el.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes('PALOMITAS'));
    expect(fila?.textContent).toContain('inversión no medida');
    expect(fila?.textContent).not.toContain('$0');
  });

  it('⛔ sin permiso de costo no aparece la inversión en ningún lado', async () => {
    const sinCosto = { ...RESPUESTA, costo_visible: false, resumen: { ...RESPUESTA.resumen!, inversion: null, venta_por_peso: null } };
    const el = await montar(of(sinCosto));
    // La regla de "Cómo se decide" sí menciona la inversión (es el criterio, no una cifra).
    // Lo que no puede aparecer es ninguna CIFRA de inversión: ni en la respuesta ni en las filas.
    expect(el.querySelector('.pn-respuesta')?.textContent).not.toContain('Se invirtieron');
    expect(el.querySelector('.pn-tabla')?.textContent).not.toContain('invertido');
    expect(el.querySelectorAll('.pn-barra').length).toBe(0);
  });

  it('⭐ clic en un producto abre su comportamiento por sucursal', async () => {
    const el = await montar(of(RESPUESTA));
    (el.querySelector('tr.pn-fila') as HTMLElement).click();
    await tick(fix);
    expect(api.detalle).toHaveBeenCalledWith('p-1');
    const plazas = Array.from(document.querySelectorAll('.pk-plaza'));
    expect(plazas.length).toBe(2);
    expect(plazas[0].textContent).toContain('Padre Hidalgo');
    expect(plazas[0].textContent).toContain('Agotado');
    expect(plazas[1].textContent).toContain('Hay 3 cajas');
    // Lo vendido y lo recibido, en cajas completas y lo demás en piezas, con la ficha de cada plaza.
    expect(plazas[0].textContent).toContain('22 cajas');
    expect(plazas[1].textContent).toContain('3 cajas y 4 piezas');
    expect(plazas[1].textContent).toContain('35 cajas');
  });

  it('⭐ la fila dice cuánto se vendió en las unidades de Kepler, y lo que no las trae va "sólo en pesos"', async () => {
    const el = await montar(of(RESPUESTA));
    const filas = Array.from(el.querySelectorAll('tbody tr'));
    const paleta = filas.find((tr) => tr.textContent?.includes('PALETA'));
    const palomitas = filas.find((tr) => tr.textContent?.includes('PALOMITAS'));
    expect(paleta?.querySelector('.pn-unid')?.textContent).toBe('25 cajas y 4 piezas');
    expect(paleta?.querySelector('.pn-hoy-u')?.textContent).toBe('1 caja');
    expect(palomitas?.textContent).toContain('sólo en pesos');
  });

  it('⭐ en vivo: se vuelve a pedir sola cada minuto', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await montar(of(RESPUESTA));
    expect(api.listar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await tick(fix);
    expect(api.listar).toHaveBeenCalledTimes(2);
  });

  it('la pantalla no pide clasificar: sin formulario en el panel ni filtro "Por confirmar"', async () => {
    const el = await montar(of(RESPUESTA));
    expect(el.textContent).not.toContain('Por confirmar');
    expect(el.textContent).not.toContain('esperan que Compras confirme');
    (el.querySelector('tr.pn-fila') as HTMLElement).click();
    await tick(fix);
    expect(document.querySelector('.pk-plaza')).not.toBeNull();
    expect(document.body.textContent).not.toContain('¿Qué es este código?');
    expect(document.querySelector('p-select, textarea')).toBeNull();
  });

  it('[negativa] si el servidor falla de entrada no hay titular y sí un aviso', async () => {
    const el = await montar(throwError(() => new Error('500')));
    expect(el.querySelector('.pn-titular')).toBeNull();
    expect(el.querySelector('.pn-error')?.textContent).toContain('No se pudieron cargar');
  });

  it('[NP.15] ⭐ la fila trae el margen real y, debajo, el de lista y el de lo pagado', async () => {
    const el = await montar(of(RESPUESTA));
    const paleta = Array.from(el.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes('PALETA'));
    const celda = paleta?.querySelector('.pn-c-margen');
    expect(celda?.textContent).toContain('10.1%');
    expect(celda?.textContent).toContain('lista 17.0%');
    // Sin compras para medirlo: guion, nunca 0%.
    expect(celda?.textContent).toContain('pagado —');
    expect(paleta?.textContent).toContain('Mejor: Padre Hidalgo');
  });

  it('[NP.15] ⭐ el detalle muestra los tres márgenes y dónde se mueve mejor', async () => {
    const el = await montar(of(RESPUESTA));
    (el.querySelector('tr.pn-fila') as HTMLElement).click();
    await tick(fix);
    const tarjetas = Array.from(document.querySelectorAll('.pk-margen'));
    expect(tarjetas.map((t) => t.querySelector('b')?.textContent?.trim())).toEqual(['17.0%', '10.1%', '—']);
    expect(tarjetas[1].textContent).toContain('no registró el costo en el 20%');
    expect(tarjetas[2].textContent).toContain('Sin compras en Kepler');
    expect(document.querySelector('#pk-margenes')?.parentElement?.textContent).toContain('sin IVA ni IEPS');
    const filas = Array.from(document.querySelectorAll('.pk-rank tbody tr'));
    expect(filas[0].textContent).toContain('Padre Hidalgo');
    expect(filas[0].classList.contains('is-mejor')).toBe(true);
    expect(filas[1].textContent).toContain('90%');
  });

  it('[NP.15] ⛔ sin permiso de costo no hay márgenes en ningún lado, pero sí dónde se mueve mejor', async () => {
    const sinCosto = { ...RESPUESTA, costo_visible: false, filas: FILAS.map((f) => ({ ...f, margenes: null })) };
    api = { listar: vi.fn(), detalle: vi.fn() };
    const el = await montar(of(sinCosto));
    expect(el.querySelectorAll('.pn-c-margen').length).toBe(0);
    api.detalle.mockReturnValue(of({ ...DETALLE, costo_visible: false,
      producto: { ...DETALLE.producto, margenes: null }, plazas: DETALLE.plazas.map((p) => ({ ...p, margenes: null })) }));
    (el.querySelector('tr.pn-fila') as HTMLElement).click();
    await tick(fix);
    expect(document.querySelectorAll('.pk-margen').length).toBe(0);
    expect(document.querySelector('.pk-rank')?.textContent).not.toContain('Margen');
    expect(document.querySelectorAll('.pk-rank tbody tr').length).toBe(2);
  });
});

describe('[NP.15] márgenes y sucursales: funciones puras', () => {
  it('⛔ un margen sin medir es guion, nunca 0%', () => {
    expect(margenTexto(null)).toBe('—');
    expect(margenTexto(undefined)).toBe('—');
    expect(margenTexto(17)).toBe('17.0%');
    expect(margenTexto(-3.25)).toMatch(/^-3\.[23]%$/);
    expect(tresMargenes(MARGENES)).toBe('17.0% · 10.1% · —');
    expect(tresMargenes(null)).toBe('—');
  });

  it('el orden: primero las que compiten por su lugar, luego las demás; sin venta no aparecen', () => {
    const p = (plaza: string, venta: number | null, lugar: number | null) =>
      ({ ...DETALLE.plazas[0], plaza, movimiento: { venta_neta_dia: venta, dias: 10, desplazado: null, lugar } }) as PlazaNueva;
    const orden = ordenMovimiento([p('A', 50, 2), p('B', 900, null), p('C', 80, 1), p('D', null, null)]);
    expect(orden.map((x) => x.plaza)).toEqual(['C', 'A', 'B']);
  });
});

describe('[NP.16] llegada, unidades por corte y reparto', () => {
  let fix: ComponentFixture<ComprasCatalogoNuevosComponent>;

  async function abrirDetalle() {
    const api = { listar: vi.fn(() => of(RESPUESTA)), detalle: vi.fn(() => of(DETALLE)) };
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoNuevosComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ProductosNuevosService, useValue: api },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCatalogoNuevosComponent);
    await tick(fix);
    (fix.nativeElement.querySelector('tr.pn-fila') as HTMLElement).click();
    await tick(fix);
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el global dice cuándo llegó a la empresa y a dónde, y avisa si entró antes por otro camino', async () => {
    await abrirDetalle();
    const global = document.querySelector('#pk-global')!.parentElement!.textContent!;
    expect(global).toContain('Llegó a la empresa');
    expect(global).toContain('a Padre Hidalgo y Canindo');
    expect(document.querySelector('.pk-aviso')?.textContent).toContain('ajuste de inventario');
    expect(document.querySelector('.pk-aviso')?.textContent).toContain('2026');
  });

  it('⭐ la tabla de 30 · 60 · 90 trae las unidades vendidas en cada corte', async () => {
    await abrirDetalle();
    const filas = Array.from(document.querySelectorAll('#pk-global ~ table tbody tr, .pk-hitos:not(.pk-rank):not(.pk-repartot) tbody tr'));
    // 10 cajas y 20 piezas = 11 cajas y 8 piezas con caja de 12.
    expect(filas[0].textContent).toContain('11 cajas y 8 piezas');
    expect(filas[1].textContent).toContain('25 cajas y 4 piezas');
  });

  it('⭐ ¿Dónde se mueve mejor? trae lo vendido en unidades de Kepler y la existencia de hoy', async () => {
    await abrirDetalle();
    const filas = Array.from(document.querySelectorAll('.pk-rank tbody tr'));
    const celda = (tr: Element, label: string) => tr.querySelector(`td[data-label="${label}"]`)!;
    const limpio = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();
    expect(Array.from(celda(filas[0], 'Le llegó').querySelectorAll('.pk-cant')).map(limpio)).toEqual(['100 cajas']);
    expect(limpio(celda(filas[0], 'Vendido').querySelector('.pk-cant'))).toBe('22 cajas');
    expect(celda(filas[0], 'Vendido').querySelector('.pk-cant b')?.textContent).toBe('22');
    expect(celda(filas[0], 'Existencia hoy').querySelector('.pk-tag-agotado')?.textContent).toBe('Agotado');
    expect(Array.from(celda(filas[1], 'Vendido').querySelectorAll('.pk-cant')).map(limpio)).toEqual(['3 cajas', '4 piezas']);
    expect(Array.from(celda(filas[1], 'Le llegó').querySelectorAll('.pk-cant')).map(limpio)).toEqual(['45 cajas']);
    expect(Array.from(celda(filas[1], 'Existencia hoy').querySelectorAll('.pk-cant')).map(limpio)).toEqual(['3 cajas']);
    expect(celda(filas[1], 'Existencia hoy').textContent).not.toContain('≈');
  });

  it('⭐ una sucursal con la existencia en duda: la etiqueta, lo que debería haber y lo que dice Kepler', async () => {
    const plazas = DETALLE.plazas.map((p, i) => (i === 0
      ? { ...p, existencia_duda: { kepler: -3, estimada: 60, base: 'PZA', otros: ['PAQ'] } } : p));
    const api = { listar: vi.fn(() => of(RESPUESTA)), detalle: vi.fn(() => of({ ...DETALLE, plazas })) };
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoNuevosComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: ProductosNuevosService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCatalogoNuevosComponent);
    await tick(fix);
    (fix.nativeElement.querySelector('tr.pn-fila') as HTMLElement).click();
    await tick(fix);
    const td = document.querySelector('.pk-rank tbody tr td[data-label="Existencia hoy"]')!;
    expect(td.querySelector('.pk-tag-duda')?.textContent).toBe('En duda');
    expect(td.querySelector('.pk-tag-agotado')).toBeNull();
    expect(td.querySelector('.pk-cant')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('5 cajas');
    expect(td.querySelector('.pk-cant-sub')?.textContent).toBe('Kepler dice: Agotado');
  });

  it('⭐ arriba de Por sucursal: lo que nos llegó en compras y cómo se repartió', async () => {
    await abrirDetalle();
    const bloque = document.querySelector('.pk-reparto')!;
    expect(bloque.textContent).toContain('Nos llegaron');
    expect(bloque.textContent).toContain('135 cajas');
    const filas = Array.from(bloque.querySelectorAll('tbody tr')).map((tr) => tr.textContent!.replace(/\s+/g, ' '));
    expect(filas[0]).toContain('Padre Hidalgo');
    expect(filas[0]).toContain('100 cajas');   // compró
    expect(filas[0]).toContain('4 paquetes');  // mandó a rutas
    expect(filas[1]).toContain('Yurécuaro');
    expect(filas[1]).toContain('10 cajas');    // le llegó de otra
  });
});

describe('[NP.16] funciones puras', () => {
  it('las sucursales se dicen como se leen', () => {
    expect(sucursalesTexto([])).toBe('');
    expect(sucursalesTexto([{ plaza: '01', nombre: 'Padre Hidalgo' }])).toBe('Padre Hidalgo');
    expect(sucursalesTexto([{ plaza: '01', nombre: 'A' }, { plaza: '06', nombre: null }, { plaza: '08', nombre: 'C' }]))
      .toBe('A, Sucursal 06 y C');
  });

  it('el reparto: primero las que compraron, luego las que recibieron de otra; sin nada que decir, no aparece', () => {
    const base = DETALLE.plazas[0];
    const p = (plaza: string, over: Partial<PlazaNueva>) => ({ ...base, plaza, unidades_recibidas: {}, recibido_traspaso: {},
      enviado_sucursales: {}, enviado_rutas: {}, existencia: null, ...over }) as PlazaNueva;
    const orden = ordenReparto([
      p('05', { recibido_traspaso: { CJA: 1 } }),
      p('07', {}),
      p('01', { unidades_recibidas: { CJA: 50 } }),
      p('03', { existencia: 12 }),
    ]);
    expect(orden.map((x) => x.plaza)).toEqual(['01', '05', '03']);
  });

  it('⭐ lo que le llegó: compras más lo de otra sucursal, cada rótulo por su lado', () => {
    expect(leLlego({ unidades_recibidas: { CJA: 50 }, recibido_traspaso: { CJA: 10, PAQ: 3 } })).toEqual({ CJA: 60, PAQ: 3 });
    expect(leLlego({ unidades_recibidas: {}, recibido_traspaso: { PZA: 0.1 } })).toEqual({ PZA: 0.1 });
    expect(leLlego({ unidades_recibidas: {}, recibido_traspaso: {} })).toEqual({});
  });

  it('⭐ cada unidad en su renglón, de lo grande a lo chico, con la cifra aparte del rótulo', () => {
    expect(listaUnidades({ PZA: 2, PAQ: 178 })).toEqual([
      { cifra: '178', rotulo: 'paquetes' }, { cifra: '2', rotulo: 'piezas' },
    ]);
    expect(listaUnidades({ CJA: 1, KG: 0.0001 })).toEqual([{ cifra: '1', rotulo: 'caja' }]);
    expect(listaUnidades(null)).toEqual([]);
    // La versión partida y la de una línea dicen lo mismo: una sola regla.
    expect(cantidadPartes(500, '250')).toEqual({ cifra: '500', rotulo: 'de 250 g' });
    expect(cantidadPartes(3, '?')).toEqual({ cifra: '3', rotulo: 'sin unidad' });
  });

  it('⭐ con la ficha: cajas completas y lo demás en paquetes o piezas, nunca "≈ 3.1 cajas"', () => {
    // 96087: paquete de 10, caja de 60.
    const kinder = escaleraUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: 10, f3: 60, uxc: 60 });
    expect(textoUnidades({ PAQ: 178, PZA: 2 }, kinder)).toBe('29 cajas, 4 paquetes y 2 piezas');
    expect(textoUnidades({ PZA: 334 }, kinder)).toBe('5 cajas, 3 paquetes y 4 piezas');
    expect(textoUnidades({ CJA: 60 }, kinder)).toBe('60 cajas');
    expect(listaUnidades({ PZA: 13 }, CAJA_12)).toEqual([{ cifra: '1', rotulo: 'caja' }, { cifra: '1', rotulo: 'pieza' }]);
    // Un rótulo fuera de la ficha va al final, tal cual, sin sumarse.
    expect(textoUnidades({ PZA: 13, PAQ: 4 }, CAJA_12)).toBe('1 caja, 1 pieza y 4 paquetes');
    // Sin ficha, como lo registró Kepler.
    expect(textoUnidades({ PAQ: 178, PZA: 2 }, null)).toBe('178 paquetes · 2 piezas');
  });

  it('⛔ la existencia partida: agotado y sin registro no traen cifra', () => {
    const k = { existencia_fuente: 'kepler' as const, existencia_duda: null };
    expect(existenciaPartes({ ...k, existencia: 13, existencia_unidad: 'PZA', escalera: CAJA_12 }))
      .toEqual({ estado: 'hay', partes: [{ cifra: '1', rotulo: 'caja' }, { cifra: '1', rotulo: 'pieza' }], kepler: null, motivo: null });
    expect(existenciaPartes({ ...k, existencia: 0, existencia_unidad: 'PZA', escalera: CAJA_12 }))
      .toEqual({ estado: 'agotado', partes: [], kepler: null, motivo: null });
    expect(existenciaPartes({ ...k, existencia: null, existencia_unidad: null, escalera: null }).estado).toBe('sin_registro');
  });
});
