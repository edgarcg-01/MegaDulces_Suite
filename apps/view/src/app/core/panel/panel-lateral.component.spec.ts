import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MultitareaService } from '../services/multitarea.service';
import { PanelLateralComponent } from './panel-lateral.component';

/**
 * `[MT.6]` **El divisor de la pantalla partida.**
 *
 * Pedido de Edgar el 2026-10-16: «que el tamaño de las interfaces sea dinámico».
 * El panel estaba clavado en `clamp(24rem, 46%, 60rem)` — una proporción que
 * decidimos nosotros y que no sirve igual para una tabla de 4 columnas que para
 * una de 12.
 *
 * ── Por qué se prueba renderizado y no sólo el servicio ─────────────────────
 * El servicio ya tiene lo suyo (guardar, recordar, sincronizar). Lo que falla
 * distinto es el GESTO: que el agarre exista, que siga al puntero, que respete
 * el piso y el techo, y que el teclado llegue al mismo lugar que el mouse.
 *
 * ⚠️ Sin esta prueba el panel se quedaba sin cobertura propia: al mudarlo fuera
 * del layout se llevó su lógica y dejó atrás los tests que la miraban.
 */
const CLAVE_ANCHO = 'mt.anchoPanel.v1';

describe('[MT.6] PanelLateralComponent · el divisor', () => {
  let fix: ComponentFixture<PanelLateralComponent>;
  let mt: MultitareaService;

  const raiz = (): HTMLElement => fix.nativeElement as HTMLElement;
  const grip = (): HTMLElement => {
    const g = raiz().querySelector('.mt-panel-grip');
    if (!g) throw new Error('no se renderizó el divisor');
    return g as HTMLElement;
  };

  /** El gesto real: pointer events, que es lo que emiten mouse, dedo y lápiz. */
  const arrastrarHasta = (clientX: number): void => {
    const g = grip();
    g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 900 }));
    g.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX }));
    g.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    fix.detectChanges();
  };

  const tecla = (key: string, shiftKey = false): void => {
    grip().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    fix.detectChanges();
  };

  beforeEach(async () => {
    localStorage.removeItem(CLAVE_ANCHO);
    // jsdom no trae `matchMedia`; el panel la usa para saber si hay ancho que partir.
    vi.stubGlobal('matchMedia', (q: string) => ({
      media: q, matches: false, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }));
    await TestBed.configureTestingModule({
      imports: [PanelLateralComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(PanelLateralComponent);
    mt = TestBed.inject(MultitareaService);
    fix.detectChanges();
  });

  afterEach(() => {
    fix?.destroy();
    vi.unstubAllGlobals();
    localStorage.removeItem(CLAVE_ANCHO);
    TestBed.resetTestingModule();
  });

  it('el divisor existe y se anuncia como separador, con su rango', () => {
    expect(grip().getAttribute('role')).toBe('separator');
    expect(grip().getAttribute('aria-orientation')).toBe('vertical');
    expect(grip().getAttribute('aria-valuemin')).toBe('384');
    expect(Number(grip().getAttribute('aria-valuemax'))).toBeGreaterThan(384);
  });

  it('nace sin ancho propio: manda el default del CSS', () => {
    expect(mt.anchoPanel()).toBeNull();
  });

  it('arrastrar hacia la izquierda ENSANCHA el panel', () => {
    arrastrarHasta(500); // el borde derecho queda a 0 en jsdom → el ancho es -clientX acotado
    expect(mt.anchoPanel()).not.toBeNull();
  });

  /**
   * El piso no es cosmético: debajo de 24rem la pantalla de la derecha deja de
   * poder mostrar una tabla, y el panel se vuelve una tira inútil que igual te
   * robó la mitad de la atención.
   */
  it('no baja del piso por más que arrastres', () => {
    arrastrarHasta(100000); // muy a la derecha = querer dejarlo en nada
    expect(mt.anchoPanel()).toBe(384);
  });

  /** El techo protege a la pantalla de la IZQUIERDA de quedar como una tira. */
  it('no pasa del techo por más que arrastres', () => {
    arrastrarHasta(-100000);
    const techo = Math.max(384, Math.round(window.innerWidth * 0.8));
    expect(mt.anchoPanel()).toBe(techo);
  });

  /**
   * ⭐ Un atajo que sólo existe con mouse no existe para quien navega con
   * teclado. El divisor es `tabindex=0` y las flechas hacen lo mismo que
   * arrastrar.
   */
  describe('el teclado llega al mismo lugar que el mouse', () => {
    it('la flecha izquierda ensancha y la derecha angosta', () => {
      mt.ponerAnchoPanel(600);
      fix.detectChanges();
      tecla('ArrowLeft');
      expect(mt.anchoPanel()).toBe(616);
      tecla('ArrowRight');
      expect(mt.anchoPanel()).toBe(600);
    });

    it('con Shift va de a saltos grandes', () => {
      mt.ponerAnchoPanel(600);
      fix.detectChanges();
      tecla('ArrowLeft', true);
      expect(mt.anchoPanel()).toBe(664);
    });

    it('Home devuelve el default', () => {
      mt.ponerAnchoPanel(900);
      fix.detectChanges();
      tecla('Home');
      expect(mt.anchoPanel()).toBeNull();
    });

    it('el teclado tampoco se salta el piso', () => {
      mt.ponerAnchoPanel(390);
      fix.detectChanges();
      tecla('ArrowRight');
      expect(mt.anchoPanel()).toBe(384);
    });

    /**
     * NEGATIVA. Sin el corte, cualquier tecla cancelaría su evento y el divisor
     * se comería el `Tab` — dejando a quien navega con teclado encerrado en él.
     */
    it('NEGATIVA: una tecla que no es suya no se cancela ni mueve nada', () => {
      mt.ponerAnchoPanel(600);
      fix.detectChanges();
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      grip().dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(mt.anchoPanel()).toBe(600);
    });
  });

  it('el doble clic devuelve el default', () => {
    mt.ponerAnchoPanel(900);
    fix.detectChanges();
    grip().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fix.detectChanges();
    expect(mt.anchoPanel()).toBeNull();
  });

  /**
   * ⚠️ La transición de ancho se apaga mientras durás el arrastre. Con ella
   * puesta el panel persigue al cursor 180 ms atrás y se siente pegajoso.
   */
  it('mientras arrastrás, el host se marca para no animar', () => {
    grip().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 900 }));
    fix.detectChanges();
    expect(raiz().classList.contains('is-arrastrando')).toBe(true);
    grip().dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    fix.detectChanges();
    expect(raiz().classList.contains('is-arrastrando')).toBe(false);
  });
});
