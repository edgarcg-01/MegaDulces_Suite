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

  /**
   * `[CAT-COSTO.0]` Costos ya es su propio tab: su cascarón se titula «Costos», no
   * «Costos y precios», y no manda a la pantalla de Precios (que ahora es el tab vecino).
   */
  it('el apartado de costos se titula Costos y no enlaza a Precios', () => {
    const el = montar('costos');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Costos');
    expect(el.textContent).not.toContain('Costos y precios');
    expect(el.querySelector('a[href*="/compras/catalogo/precios"]')).toBeNull();
  });

  it('un discriminador desconocido cae al resumen en vez de reventar', () => {
    const el = montar('no-existe');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Centro de control del catálogo');
  });
});
