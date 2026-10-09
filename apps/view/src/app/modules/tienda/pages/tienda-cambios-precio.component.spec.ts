import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { EtiquetasService, PriceChange, PriceChangesResult } from '../etiquetas.service';
import { AuthService } from '../../../core/services/auth.service';
import { TiendaCambiosPrecioComponent } from './tienda-cambios-precio.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
}

const fila = (sku: string, unidad: string, antes: number | null, ahora: number | null): PriceChange => ({
  sku, name: `PROD ${sku}`, unidad, precio_anterior: antes, precio_nuevo: ahora,
  delta: antes == null || ahora == null ? null : Math.round((ahora - antes) * 100) / 100,
  es_baja: ahora === 0, hora: '2026-10-08T10:00:00Z',
});

/** El caso del reporte: el 91059 llegaba TRES veces, una por presentación. */
const ITEMS: PriceChange[] = [
  fila('91059', 'CJA', 0, 6378.26),
  fila('91059', '500', 6523.34, 203.85),
  fila('91059', '500', 5602.87, 6523.34),
  fila('95459', '500', 2882.83, 240.23),
  fila('77777', 'PAQ', 10, 0),
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
    expect(filas[0].querySelectorAll('.cpr-linea')).toHaveLength(3);
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

  it('el selector de precio está en la barra, antes de imprimir', () => {
    expect(root().textContent).toContain('Precio en la etiqueta');
    const opciones = Array.from(root().querySelectorAll('.seg-btn')).map((b) => b.textContent?.trim());
    expect(opciones).toEqual(['Todos los precios', 'Pieza', 'Paquete', 'Caja']);
  });
});
