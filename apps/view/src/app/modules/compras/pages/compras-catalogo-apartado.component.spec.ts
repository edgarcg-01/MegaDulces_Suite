import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { ComprasCatalogoApartadoComponent } from './compras-catalogo-apartado.component';

/** Monta el cascarón con el discriminador de ruta que le pasa `app.routes.ts`. */
function montar(apartado: string) {
  TestBed.configureTestingModule({
    imports: [ComprasCatalogoApartadoComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { catalogoApartado: apartado } } } },
    ],
  });
  const fixture = TestBed.createComponent(ComprasCatalogoApartadoComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ComprasCatalogoApartadoComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pinta el apartado que le pide la ruta', () => {
    const el = montar('listas-precios');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Listas de precios de proveedores');
  });

  /**
   * `[CAT-COSTO.4]` Costos ya NO es un cascarón: tiene pantalla propia. Si alguna ruta volviera
   * a mandar `costos` aquí, caería al resumen en vez de pintar un «contenido por desarrollar».
   */
  it('costos ya no es un apartado: el discriminador cae al resumen', () => {
    const el = montar('costos');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Centro de control del catálogo');
  });

  it('un discriminador desconocido cae al resumen en vez de reventar', () => {
    const el = montar('no-existe');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Centro de control del catálogo');
  });
});
