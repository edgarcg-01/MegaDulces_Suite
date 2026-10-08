import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { PermissionsService } from '../../../core/services/permissions.service';
import {
  DetalleNuevo,
  ProductoNuevo,
  ProductosNuevosService,
  RespuestaNuevos,
} from '../productos-nuevos.service';
import {
  ComprasCatalogoNuevosComponent,
  existenciaTexto,
  fechaCorta,
  hitoVisible,
  pasaBusqueda,
  pasaFiltro,
  semanasCerradas,
  tendenciaTexto,
} from './compras-catalogo-nuevos.component';

function producto(over: Partial<ProductoNuevo> = {}): ProductoNuevo {
  return {
    product_id: 'p-1', sku: 'NP01', nombre: 'PALETA MANGO', marca: 'DULCERA', proveedor: 'PROV A',
    alta_suite: '2026-08-20', alta_en_lote: false, primera_recepcion: '2026-08-23', primera_venta: '2026-08-24',
    lanzamiento: '2026-08-23', dia: 45, fuentes: ['entradas', 'kepler'], etapa: 'mes_2', estado: 'seguimiento',
    motivo: null, posible_recodificacion: false, clasificacion: null, nota: null, clasificado_por: null,
    hitos: {
      30: { cerrado: true, inversion: 26000, venta: 22260 },
      60: { cerrado: false, inversion: 26000, venta: 34185 },
      90: { cerrado: false, inversion: 26000, venta: 34185 },
    },
    inversion_total: 26000, venta_total: 34185, venta_por_peso: 1.31, entradas: 3, plazas_recibido: 2,
    primera_recompra: '2026-09-17', dia_recompra: 25, plazas_venta: 2, plazas_con_existencia: 1, agotado_en: 1,
    dias_con_venta_30: 28, dias_con_venta_28: 27, venta_28: 20000, tendencia: 1.1, ultima_venta: '2026-10-06',
    sin_venta_30: false, semanas: [1000, 2000, 3000, 2500, 2800, 3100, 900], venta_hoy: 530,
    recomendacion: { veredicto: 'recomprar', motivos: ['Se vendió 27 de los últimos 28 días', 'Se agotó en 1 plaza que lo vende'] },
    ...over,
  };
}

const FILAS: ProductoNuevo[] = [
  producto(),
  producto({
    product_id: 'p-2', sku: 'NP09', nombre: 'PALOMITAS CARAMELO', inversion_total: null, venta_por_peso: null,
    hitos: {
      30: { cerrado: true, inversion: null, venta: 1320 },
      60: { cerrado: false, inversion: null, venta: 1496 },
      90: { cerrado: false, inversion: null, venta: 1496 },
    },
    sin_venta_30: true, entradas: 0, dia_recompra: null, primera_recompra: null, venta_hoy: 0,
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
      existencia_cajas: null, ultima_venta: '2026-10-06', semanas: [100, 200, 300], venta_hoy: 0,
      recomendacion: { veredicto: 'recomprar', motivos: ['Se agotó en 1 plaza que lo vende'] } },
    { plaza: '04', nombre: 'Yurécuaro', dia: 44, primera_actividad: '2026-08-24', venta_total: 14185, venta_28: 8000,
      dias_con_venta_28: 22, inversion_total: 7000, entradas: 1, primera_recompra: null, existencia: 36,
      existencia_cajas: 3, ultima_venta: '2026-10-07', semanas: [100, 150, 120], venta_hoy: 530,
      recomendacion: { veredicto: 'esperar', motivos: ['Se vende bien, pero todavía hay existencia'] } },
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

  it('⛔ la existencia no inventa cajas: sólo si la plaza declara divisor', () => {
    expect(existenciaTexto({ existencia: 36, existencia_cajas: 3 })).toBe('Hay 3 cajas');
    expect(existenciaTexto({ existencia: 36, existencia_cajas: null })).toBe('Hay 36 unidades');
    expect(existenciaTexto({ existencia: 0, existencia_cajas: null })).toBe('Agotado');
    expect(existenciaTexto({ existencia: null, existencia_cajas: null })).toBe('Sin existencia registrada');
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
  });
});

describe('[NP.5] ComprasCatalogoNuevosComponent', () => {
  let fix: ComponentFixture<ComprasCatalogoNuevosComponent>;
  let api: { listar: ReturnType<typeof vi.fn>; detalle: ReturnType<typeof vi.fn>; clasificar: ReturnType<typeof vi.fn> };

  async function montar(respuesta: unknown, puedeGestionar = true) {
    api = { listar: vi.fn(() => respuesta), detalle: vi.fn(() => of(DETALLE)), clasificar: vi.fn(() => of({})) };
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoNuevosComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ProductosNuevosService, useValue: api },
        { provide: PermissionsService, useValue: { has: () => puedeGestionar, hasAny: () => puedeGestionar, isAdmin: () => false } },
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
    expect(el.querySelector('.pn-aviso')?.textContent).toContain('todavía no se calculan');
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
  });

  it('⭐ en vivo: se vuelve a pedir sola cada minuto', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await montar(of(RESPUESTA));
    expect(api.listar).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await tick(fix);
    expect(api.listar).toHaveBeenCalledTimes(2);
  });

  it('guardar la clasificación la manda al servidor y recarga', async () => {
    await montar(of(RESPUESTA));
    const cmp = fix.componentInstance;
    cmp.editar(FILAS[0], 'clasificacion', 'nuevo');
    cmp.editar(FILAS[0], 'nota', '  Lanzamiento con proveedor A  ');
    cmp.guardar(FILAS[0]);
    expect(api.clasificar).toHaveBeenCalledWith('p-1', 'nuevo', 'Lanzamiento con proveedor A');
    await tick(fix);
    expect(api.listar).toHaveBeenCalledTimes(2);
  });

  it('[negativa] sin permiso de gestionar, guardar no llama al servidor', async () => {
    await montar(of(RESPUESTA), false);
    fix.componentInstance.guardar(FILAS[0]);
    expect(api.clasificar).not.toHaveBeenCalled();
  });

  it('[negativa] si el servidor falla de entrada no hay titular y sí un aviso', async () => {
    const el = await montar(throwError(() => new Error('500')));
    expect(el.querySelector('.pn-titular')).toBeNull();
    expect(el.querySelector('.pn-error')?.textContent).toContain('No se pudieron cargar');
  });
});
