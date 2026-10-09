import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { EtiquetasService, PriceChange, PriceChangesResult } from '../etiquetas.service';
import { AuthService } from '../../../core/services/auth.service';
import { TiendaCambiosPrecioComponent } from './tienda-cambios-precio.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void { /* jsdom */ } unobserve(): void { /* jsdom */ } disconnect(): void { /* jsdom */ } };
}

const fila = (sku: string, unidad: string, antes: number | null, ahora: number | null, h = '10:00'): PriceChange => ({
  sku, name: `PROD ${sku}`, unidad, precio_anterior: antes, precio_nuevo: ahora,
  delta: antes == null || ahora == null ? null : Math.round((ahora - antes) * 100) / 100,
  es_baja: ahora === 0, hora: `2026-10-08T${h}:00Z`,
});

/** El caso del reporte: el 91059 llegaba TRES veces, una por presentación. */
const ITEMS: PriceChange[] = [
  fila('91059', 'CJA', 0, 6378.26, '08:00'),
  fila('91059', '500', 6523.34, 203.85, '10:00'), // el precio de la unidad 500 se movió DOS veces el mismo día
  fila('91059', '500', 5602.87, 6523.34, '09:00'),
  fila('95459', '500', 2882.83, 240.23, '10:00'),
  fila('77777', 'PAQ', 10, 0),
  fila('88888', 'PAQ', 10, 12, '09:00'), // oscila y termina donde empezó: no se lista
  fila('88888', 'PAQ', 12, 10, '10:00'),
];

class EtiquetasStub {
  priceChanges(): ReturnType<EtiquetasService['priceChanges']> {
    const r: PriceChangesResult = {
      items: ITEMS, fecha: '2026-10-08', truncado: false, fuente_al: '2026-10-08',
      ocultos_centavo: 0, productos_del_dia: 3, tope_productos: 300, freshness: null,
    };
    return of(r);
  }
  priceChangeBranches() { return of([]); }
}

describe('TiendaCambiosPrecioComponent · un código, una fila', () => {
  let fix: ComponentFixture<TiendaCambiosPrecioComponent>;
  let cmp: TiendaCambiosPrecioComponent;
  let navegar: ReturnType<typeof vi.fn>;
  const root = (): HTMLElement => fix.nativeElement as HTMLElement;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TiendaCambiosPrecioComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: EtiquetasService, useValue: new EtiquetasStub() },
        { provide: AuthService, useValue: { user: () => ({ warehouse_code: '01', username: 'qa' }), token: () => null } },
      ],
    }).compileComponents();
    navegar = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;
    fix = TestBed.createComponent(TiendaCambiosPrecioComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  });

  it('⭐ el mismo código aparece UNA sola vez, con sus tres presentaciones adentro', () => {
    const filas = Array.from(root().querySelectorAll('tbody tr'));
    expect(filas).toHaveLength(3); // 91059, 95459, 77777 — no 5
    const codigos = filas.map((tr) => tr.querySelector('td.cpr-num')?.textContent?.trim());
    expect(codigos).toEqual(['91059', '95459', '77777']);
    // 3 renglones de la bitácora = 2 líneas: la unidad 500 se movió dos veces y se resume en una
    expect(filas[0].querySelectorAll('.cpr-linea')).toHaveLength(2);
  });

  it('⭐ una unidad que se movió varias veces el mismo día muestra el primer «antes» y el último «ahora»', () => {
    const p = cmp.productos().find((x) => x.sku === '91059')!;
    const u500 = p.filas.find((r) => r.unidad === '500')!;
    expect(u500.precio_anterior).toBe(5602.87); // lo que hay en el anaquel
    expect(u500.precio_nuevo).toBe(203.85);     // lo que dice Kepler ahora
    expect(u500.delta).toBe(-5399.02);
  });

  it('un producto que terminó el día en su mismo precio no se lista, pero se declara cuántos fueron', () => {
    expect(cmp.productos().map((p) => p.sku)).not.toContain('88888');
    expect(cmp.volvieron()).toBe(1);
    expect(root().textContent).toContain('volvió al de antes');
  });

  it('el resumen cuenta PRODUCTOS y cuadra: suben + bajan + sin precio = total', () => {
    const r = cmp.resumen();
    const v = (label: string) => Number(r.find((x) => x.label === label)?.value);
    expect(v('Para reimprimir')).toBe(3);
    expect(v('Subieron') + v('Bajaron') + v('Sin precio')).toBe(3);
    expect(v('Sin precio')).toBe(1); // el 77777: el ERP le quitó el precio
  });

  it('marcar UN producto marca esa fila y manda UN código', async () => {
    cmp.alternar(cmp.productos()[0]);
    await tick();
    expect(cmp.marcados().map((p) => p.sku)).toEqual(['91059']);
    expect(root().textContent).toContain('1 de 3 marcados');
    expect(root().textContent).toContain('Imprimir 1 etiqueta');
  });

  it('⭐ por defecto se manda «todos los precios», y la elección viaja con los códigos', async () => {
    cmp.imprimir(cmp.productos());
    expect(navegar).toHaveBeenCalledWith(['/tienda/etiquetas'], { state: { codes: ['91059', '95459', '77777'], modo: 'todos' } });

    cmp.modo.set('caja');
    cmp.alternar(cmp.productos()[1]);
    cmp.imprimir(cmp.marcados());
    expect(navegar).toHaveBeenLastCalledWith(['/tienda/etiquetas'], { state: { codes: ['95459'], modo: 'caja' } });
  });

  describe('clic en la fila imprime ESA etiqueta', () => {
    const filaDe = (sku: string): HTMLTableRowElement =>
      Array.from(root().querySelectorAll('tbody tr')).find((tr) => tr.querySelector('td.cpr-num')?.textContent?.trim() === sku) as HTMLTableRowElement;

    it('⭐ un clic en la fila manda ESE producto a la etiquetera, con el precio elegido', async () => {
      cmp.modo.set('caja');
      filaDe('95459').click();
      expect(navegar).toHaveBeenCalledTimes(1);
      expect(navegar).toHaveBeenCalledWith(['/tienda/etiquetas'], { state: { codes: ['95459'], modo: 'caja' } });
    });

    it('⛔ marcar la casilla NO navega: es para armar un lote, no para imprimir', () => {
      (filaDe('91059').querySelector('input[type=checkbox]') as HTMLInputElement).click();
      expect(navegar).not.toHaveBeenCalled();
      expect(cmp.marcados().map((p) => p.sku)).toEqual(['91059']);
    });

    it('⭐ el botón «Imprimir» de la fila navega UNA sola vez (el clic no sube a la fila)', () => {
      (filaDe('91059').querySelector('button.cpr-btn-imprimir') as HTMLButtonElement).click();
      expect(navegar).toHaveBeenCalledTimes(1);
      expect(navegar).toHaveBeenCalledWith(['/tienda/etiquetas'], { state: { codes: ['91059'], modo: 'todos' } });
    });

    it('⭐ la FILA se alcanza con el teclado, y Enter o Espacio imprimen su etiqueta', () => {
      const fila = filaDe('91059');
      expect(fila.getAttribute('tabindex')).toBe('0');
      const tecla = (key: string) => fila.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      tecla('Enter');
      expect(navegar).toHaveBeenLastCalledWith(['/tienda/etiquetas'], { state: { codes: ['91059'], modo: 'todos' } });
      tecla(' ');
      expect(navegar).toHaveBeenCalledTimes(2);
      tecla('a'); // otra tecla no hace nada
      expect(navegar).toHaveBeenCalledTimes(2);
    });

    it('⛔ Enter sobre la CASILLA no imprime: marcar es marcar, aunque la tecla suba hasta la fila', () => {
      const casilla = filaDe('91059').querySelector('input[type=checkbox]') as HTMLInputElement;
      casilla.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(navegar).not.toHaveBeenCalled();
    });

    it('el botón es para el ratón y el dedo: sale del orden de tabulador (una parada por fila) y dice de qué producto es', () => {
      const b = filaDe('91059').querySelector('button.cpr-btn-imprimir') as HTMLButtonElement;
      expect(b.getAttribute('tabindex')).toBe('-1');
      expect(b.getAttribute('aria-label')).toBe('Imprimir la etiqueta de 91059');
    });

    it('⛔ si hay texto seleccionado no navega: copiar un código no debe costar la selección', () => {
      const sel = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '91059' } as unknown as Selection);
      filaDe('91059').click();
      expect(navegar).not.toHaveBeenCalled();
      sel.mockRestore();
    });
  });

  it('el selector de precio está en la barra, antes de imprimir', () => {
    expect(root().textContent).toContain('Precio en la etiqueta');
    const opciones = Array.from(root().querySelectorAll('.seg-btn')).map((b) => b.textContent?.trim());
    expect(opciones).toEqual(['Todos los precios', 'Pieza', 'Paquete', 'Caja']);
  });
});
