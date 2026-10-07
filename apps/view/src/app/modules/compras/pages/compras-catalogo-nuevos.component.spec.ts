import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ProductoNuevo, ProductosNuevosService, RespuestaNuevos } from '../productos-nuevos.service';
import {
  ComprasCatalogoNuevosComponent,
  fechaCorta,
  hitoVisible,
  pasaBusqueda,
  pasaVista,
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
    primera_recompra: '2026-09-17', dia_recompra: 25, plazas_venta: 2, plazas_con_existencia: 2,
    dias_con_venta_30: 28, ultima_venta: '2026-10-06', sin_venta_30: false,
    ...over,
  };
}

const FILAS: ProductoNuevo[] = [
  producto(),
  producto({
    product_id: 'p-2', sku: 'NP09', nombre: 'PALOMITAS CARAMELO', inversion_total: null, venta_por_peso: null,
    hitos: {
      30: { cerrado: true, inversion: null, venta: null },
      60: { cerrado: false, inversion: null, venta: null },
      90: { cerrado: false, inversion: null, venta: null },
    },
    venta_total: null, sin_venta_30: true, entradas: 0, dia_recompra: null, primera_recompra: null,
  }),
  producto({ product_id: 'p-3', sku: 'DESC1', nombre: 'DESC VOLUMEN', estado: 'excluido', motivo: 'Código de descuento' }),
];

const RESPUESTA: RespuestaNuevos = {
  calculado: true,
  calculado_at: '2026-10-07T12:20:00.000Z',
  historia_desde: '2026-01-20',
  costo_visible: true,
  resumen: {
    total: 3, seguimiento: 2, por_confirmar: 2, sin_movimiento: 0, no_medible: 0, excluido: 1,
    por_etapa: { mes_1: 0, mes_2: 2, mes_3: 0, graduado: 0 },
    inversion: 26000, venta: 34185, venta_por_peso: 1.31, recomprados: 1, con_30_dias: 2, sin_venta_30: 1,
  },
  cohortes: [{ mes: '2026-08', productos: 2, con_inversion: 1, inversion: 26000, venta: 34185,
    venta_por_peso: 1.31, recomprados: 1, con_30_dias: 2, sin_venta_30: 1 }],
  filas: FILAS,
};

const tick = async (fix: ComponentFixture<unknown>) => {
  fix.detectChanges();
  await fix.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fix.detectChanges();
};

describe('[NP.5] funciones puras de Productos nuevos', () => {
  it('el hito se ve si ya cerró o si es el tramo en curso; los de más adelante no', () => {
    expect(hitoVisible(45, 30)).toBe(true);
    expect(hitoVisible(45, 60)).toBe(true);   // en curso
    expect(hitoVisible(45, 90)).toBe(false);  // a 45 días el de 90 repetiría el de 60
    expect(hitoVisible(null, 30)).toBe(false);
  });

  it('⛔ la fecha NO se corre un día por la zona horaria', () => {
    // `new Date('2026-09-01')` pintado en hora de México da 31 de agosto: el bug de LC.16.
    expect(fechaCorta('2026-09-01')).toMatch(/^1 /);
    expect(fechaCorta(null)).toBe('—');
  });

  it('las vistas separan lo que se sigue de lo que no', () => {
    expect(FILAS.filter((f) => pasaVista(f, 'seguimiento')).length).toBe(2);
    expect(FILAS.filter((f) => pasaVista(f, 'sin_venta_30')).map((f) => f.sku)).toEqual(['NP09']);
    expect(FILAS.filter((f) => pasaVista(f, 'excluido')).map((f) => f.sku)).toEqual(['DESC1']);
    expect(FILAS.filter((f) => pasaVista(f, 'mes_2')).length).toBe(2);
  });

  it('la búsqueda mira SKU, nombre, marca y proveedor', () => {
    expect(pasaBusqueda(FILAS[0], 'mango')).toBe(true);
    expect(pasaBusqueda(FILAS[0], 'prov a')).toBe(true);
    expect(pasaBusqueda(FILAS[0], 'chicle')).toBe(false);
  });
});

describe('[NP.5] ComprasCatalogoNuevosComponent', () => {
  let fix: ComponentFixture<ComprasCatalogoNuevosComponent>;
  let api: { listar: ReturnType<typeof vi.fn>; clasificar: ReturnType<typeof vi.fn> };

  async function montar(respuesta: unknown, puedeGestionar = true) {
    api = { listar: vi.fn(() => respuesta), clasificar: vi.fn(() => of({})) };
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

  afterEach(() => TestBed.resetTestingModule());

  it('mientras la matvista no se calcula lo DICE, en vez de pintar ceros', async () => {
    const el = await montar(of({ ...RESPUESTA, calculado: false, resumen: null, cohortes: [], filas: [] }));
    expect(el.querySelector('.pn-aviso')?.textContent).toContain('todavía no se calculan');
    expect(el.querySelector('.pn-titular')).toBeNull();
  });

  it('el titular dice cuántos se siguen, cuánto se invirtió y cuánto vendieron', async () => {
    const el = await montar(of(RESPUESTA));
    const t = el.querySelector('.pn-titular')?.textContent ?? '';
    expect(t).toContain('2 productos nuevos');
    expect(t).toContain('26,000');
    expect(t).toContain('34,185');
  });

  it('⛔ inversión no medida se escribe como tal, nunca como $0', async () => {
    const el = await montar(of(RESPUESTA));
    const filas = Array.from(el.querySelectorAll('tbody tr'));
    const palomitas = filas.find((tr) => tr.textContent?.includes('PALOMITAS'));
    expect(palomitas?.textContent).toContain('inversión no medida');
    expect(palomitas?.textContent).not.toContain('$0');
  });

  it('⛔ sin permiso de costo no aparece la inversión en ningún lado', async () => {
    const sinCosto = {
      ...RESPUESTA, costo_visible: false,
      resumen: { ...RESPUESTA.resumen!, inversion: null, venta_por_peso: null },
    };
    const el = await montar(of(sinCosto));
    expect(el.textContent).toContain('No tienes permiso para ver costos');
    expect(el.textContent).not.toContain('invertido');
    expect(Array.from(el.querySelectorAll('.pn-k')).map((k) => k.textContent?.trim())).not.toContain('Inversión');
  });

  it('el chip "Sin venta en 30 días" deja sólo esos productos', async () => {
    const el = await montar(of(RESPUESTA));
    const chip = Array.from(el.querySelectorAll<HTMLButtonElement>('.pn-chip')).find((b) => b.textContent?.includes('Sin venta en 30'));
    expect(chip?.querySelector('.pn-chip-n')?.textContent?.trim()).toBe('1');
    chip?.click();
    await tick(fix);
    const nombres = Array.from(el.querySelectorAll('.pn-prod')).map((x) => x.textContent?.trim());
    expect(nombres).toEqual(['PALOMITAS CARAMELO']);
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

  it('[negativa] si el servidor falla no hay titular y sí un aviso', async () => {
    const el = await montar(throwError(() => new Error('500')));
    expect(el.querySelector('.pn-titular')).toBeNull();
    expect(el.querySelector('.pn-error')?.textContent).toContain('No se pudieron cargar');
  });
});
