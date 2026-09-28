import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AndenCongeladoComponent } from './anden-congelado.component';
import { WarehouseFreeze } from '../../bin-location.service';

/**
 * `[WMS-REC.16]` — **el panel que destraba el almacén.**
 *
 * Lo que se cuida acá no es que el botón se pinte, sino que SIRVA. En este repo ya
 * pasó lo contrario (CG.22): un botón visible, habilitado por un `computed()` sobre
 * un campo plano que nunca se recalculaba, o sea inhabilitado de por vida. Por eso
 * el candado central escribe el motivo de verdad y exige que el botón se habilite.
 */
function freeze(extra: Partial<WarehouseFreeze> = {}): WarehouseFreeze {
  return {
    warehouse_id: '11111111-1111-1111-1111-111111111111',
    frozen: true,
    folio: 'INV-2026-00009',
    count_id: '22222222-2222-2222-2222-222222222222',
    status: 'counting',
    opened_at: '2026-06-19T22:15:19.342Z',
    ...extra,
  };
}

describe('AndenCongeladoComponent', () => {
  let fixture: ComponentFixture<AndenCongeladoComponent>;
  let cmp: AndenCongeladoComponent;

  const texto = () => (fixture.nativeElement as HTMLElement).textContent || '';
  const botones = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
  const botonPorTexto = (t: string) =>
    botones().find((b) => (b.textContent || '').toLowerCase().includes(t.toLowerCase()));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AndenCongeladoComponent] }).compileComponents();
    fixture = TestBed.createComponent(AndenCongeladoComponent);
    cmp = fixture.componentInstance;
    fixture.componentRef.setInput('freeze', freeze());
  });

  describe('sin la llave para cancelar', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('puedeCancelar', false);
      fixture.detectChanges();
    });

    it('no ofrece cancelar', () => {
      expect(botonPorTexto('cancelar el conteo')).toBeUndefined();
    });

    /**
     * Un muro sin salida es lo que dejó el folio 100 días puesto. Si no se puede
     * destrabar desde acá, por lo menos tiene que decir a quién pedírselo.
     */
    it('dice a quién pedírselo, en vez de dejar al operario sin salida', () => {
      expect(texto().toLowerCase()).toContain('encargado');
    });

    it('siempre muestra el folio que lo frena', () => {
      expect(texto()).toContain('INV-2026-00009');
    });
  });

  describe('con la llave para cancelar', () => {
    beforeEach(() => {
      fixture.componentRef.setInput('puedeCancelar', true);
      fixture.detectChanges();
    });

    it('ofrece destrabar, pero el formulario arranca cerrado (no es un clic al pasar)', () => {
      expect(botonPorTexto('cancelar el conteo')).toBeDefined();
      expect(cmp.abierto()).toBe(false);
      expect(fixture.nativeElement.querySelector('#cg-motivo')).toBeNull();
    });

    it('al abrir pide el motivo', () => {
      cmp.abrir();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('#cg-motivo')).not.toBeNull();
    });

    /**
     * ⭐ El candado de CG.22. Con `motivo` como campo plano, `motivoValido` quedaba
     * congelado en false y este botón NO se habilitaba nunca — se veía, y no servía.
     */
    it('el botón de confirmar se habilita al ESCRIBIR el motivo', () => {
      cmp.abrir();
      fixture.detectChanges();
      const confirmar = botonPorTexto('sí, cancelar');
      expect(confirmar).toBeDefined();
      expect(confirmar!.disabled).toBe(true);

      cmp.motivo.set('se abandonó en junio y hay que recibir');
      fixture.detectChanges();
      expect(botonPorTexto('sí, cancelar')!.disabled).toBe(false);
    });

    it('un motivo en blanco no emite nada', () => {
      const emitidos: string[] = [];
      cmp.cancelar.subscribe((m) => emitidos.push(m));
      cmp.abrir();
      cmp.motivo.set('   ');
      cmp.confirmar();
      expect(emitidos).toEqual([]);
    });

    it('emite el motivo recortado', () => {
      const emitidos: string[] = [];
      cmp.cancelar.subscribe((m) => emitidos.push(m));
      cmp.abrir();
      cmp.motivo.set('  conteo abandonado desde junio  ');
      cmp.confirmar();
      expect(emitidos).toEqual(['conteo abandonado desde junio']);
    });
  });

  describe('hace cuánto está congelado', () => {
    /**
     * Es el dato con el que se decide si tirar el conteo. Un folio de hoy es trabajo
     * vivo; uno de meses, basura olvidada.
     */
    it('lo dice en días', () => {
      const hace30 = new Date(Date.now() - 30 * 86400000).toISOString();
      fixture.componentRef.setInput('freeze', freeze({ opened_at: hace30 }));
      fixture.detectChanges();
      expect(cmp.desde()).toBe('hace 30 días');
    });

    /**
     * ⭐ Sin fecha se DECLARA. Un "hoy" por un dato ausente diría justo lo contrario
     * de lo que hay que saber, y empujaría a no cancelar un folio viejísimo.
     */
    it('sin fecha lo declara, no lo dibuja como hoy', () => {
      fixture.componentRef.setInput('freeze', freeze({ opened_at: null }));
      fixture.detectChanges();
      expect(cmp.desde()).toBe('sin fecha registrada');
      expect(texto()).toContain('sin fecha registrada');
    });

    it('una fecha ilegible tampoco se dibuja como hoy', () => {
      fixture.componentRef.setInput('freeze', freeze({ opened_at: 'ayer por la tarde' }));
      fixture.detectChanges();
      expect(cmp.desde()).toBe('sin fecha registrada');
    });
  });

  it('salir sigue disponible: cancelar es una opción, no una obligación', () => {
    fixture.componentRef.setInput('puedeCancelar', true);
    fixture.detectChanges();
    const salidas: unknown[] = [];
    cmp.salir.subscribe(() => salidas.push(1));
    botonPorTexto('salir')!.click();
    expect(salidas.length).toBe(1);
  });
});
