import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { DataScopeService, ScopeOption } from '../../../core/services/data-scope.service';
import { SucursalPickerComponent, unCodigo } from './sucursal-picker.component';

/**
 * `[ZN.7]` — **Los cuatro estados del selector de sucursal.**
 *
 * Lo que se prueba acá no es «el desplegable se pinta»: es que **`null` y `[]` no se vean
 * igual**. Son las dos respuestas opuestas —«el alcance todavía no contestó» y «no te toca
 * ninguna»— y colapsarlas es el defecto que `[ZN.2]` encontró en compras, donde «no cargó»
 * terminaba leyéndose como «ves todo» y por las dudas se ofrecían las nueve sucursales.
 *
 * El caso de **una sola** también es suyo: un desplegable con una única opción invita a
 * cambiarla y no hay a qué. Es un hecho de la sesión, y se muestra como tal.
 */
const alcance = signal<ScopeOption[] | null>(null);

const montar = async (): Promise<ComponentFixture<SucursalPickerComponent>> => {
  await TestBed.configureTestingModule({
    imports: [SucursalPickerComponent],
    providers: [
      { provide: DataScopeService, useValue: { misSucursales: () => alcance.asReadonly() } },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(SucursalPickerComponent);
  fix.detectChanges();
  return fix;
};

const texto = (fix: ComponentFixture<SucursalPickerComponent>): string =>
  (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '';

const hayControl = (fix: ComponentFixture<SucursalPickerComponent>): boolean =>
  !!(fix.nativeElement as HTMLElement).querySelector('p-select, p-multiselect');

describe('[ZN.7] selector de sucursal — los cuatro estados', () => {
  beforeEach(() => { TestBed.resetTestingModule(); alcance.set(null); });

  it('⛔ mientras el alcance NO contestó no afirma nada: ni control ni «sin sucursal»', async () => {
    const fix = await montar();
    expect(hayControl(fix)).toBe(false);
    expect(texto(fix)).toBe('');
  });

  it('⛔ y cuando contesta que no te toca ninguna, lo DICE — es el contra-ejemplo del anterior', async () => {
    const fix = await montar();
    alcance.set([]);
    fix.detectChanges();
    expect(hayControl(fix)).toBe(false);
    expect(texto(fix)).toContain('Sin sucursal asignada');
  });

  it('con UNA sola no ofrece un desplegable: la nombra', async () => {
    const fix = await montar();
    alcance.set([{ value: '08', label: '08 · Morelia Abastos' }]);
    fix.detectChanges();
    expect(hayControl(fix)).toBe(false);
    expect(texto(fix)).toContain('Morelia Abastos');
  });

  it('con VARIAS sí ofrece el control, y sólo esas', async () => {
    const fix = await montar();
    alcance.set([
      { value: '07', label: '07 · Morelia Madero' },
      { value: '08', label: '08 · Morelia Abastos' },
    ]);
    fix.detectChanges();
    expect(hayControl(fix)).toBe(true);
    expect(fix.componentInstance.opciones()?.length).toBe(2);
  });

  it('nunca inventa opciones: lo que ofrece es exactamente lo que dio el alcance', async () => {
    const fix = await montar();
    const dadas: ScopeOption[] = [{ value: '01', label: 'PH' }, { value: '02', label: 'LPA' }];
    alcance.set(dadas);
    fix.detectChanges();
    expect(fix.componentInstance.opciones()).toEqual(dadas);
  });

  it('no auto-selecciona cuando hay una sola: el valor sigue siendo del padre', async () => {
    const fix = await montar();
    alcance.set([{ value: '08', label: 'Abastos' }]);
    fix.detectChanges();
    expect(fix.componentInstance.valor()).toBeNull();
  });
});

describe('[ZN.7] unCodigo — estrechar a un código', () => {
  it('deja pasar el código y el null', () => {
    expect(unCodigo('08')).toBe('08');
    expect(unCodigo(null)).toBeNull();
  });

  it('de un arreglo toma el primero, y de uno vacío devuelve null — NO undefined', () => {
    expect(unCodigo(['07', '08'])).toBe('07');
    expect(unCodigo([])).toBeNull();
  });
});
