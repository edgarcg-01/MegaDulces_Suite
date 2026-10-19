import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ThemeService } from '../../../core/services/theme.service';
import { DataUpdateService } from '../../../core/services/data-update.service';
import { WebSocketService } from '../../../core/services/websocket.service';
import { HapticService } from '../../../core/services/haptic.service';
import { CountFocusService } from '../../../core/services/count-focus.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { FindingsService } from '../../finanzas/findings.service';
import { ActionsService } from '../../finanzas/actions.service';
import { ServiceDeskService } from '../../servicio/service-desk.service';
import { EtiquetasService } from '../../tienda/etiquetas.service';
import { AlertsSocketService } from '../command-center/alerts-socket.service';
import { LayoutComponent } from './layout.component';

/**
 * `[MT.3]` **Los dos botones del ratón sobre el botón de multitarea**, sobre el
 * layout REAL y RENDERIZADO.
 *
 * ── Por qué esto se prueba acá y no en `multitarea.service.spec.ts` ──────────
 * Aquél prueba la PREFERENCIA (que se guarde, que se recuerde, que llegue a las
 * otras ventanas). Éste prueba el GESTO: qué pasa cuando una persona aprieta un
 * botón del ratón encima del ícono. Son preguntas distintas y fallan distinto —
 * el servicio puede estar perfecto y el botón no llamarlo nunca.
 *
 * Por eso se monta `LayoutComponent` con su plantilla de verdad y el
 * `MultitareaService` de verdad: lo único doblado son los servicios que
 * arrastrarían media app a jsdom. Un host que copie el `<button>` probaría la
 * copia — y la copia no es la que se despliega.
 *
 * ── Las dos propiedades, y cómo falla cada una ───────────────────────────────
 *  1. **Clic izquierdo = abrir esta pantalla en otra pestaña.** Es la acción, y
 *     se queda con el clic principal porque es lo que la gente viene a hacer;
 *     un menú de preferencias no debería cobrarse ese clic.
 *  2. **Clic derecho = las opciones.** Si se rompe, el navegador se come el
 *     gesto con su propio menú contextual y la pantalla de preferencias
 *     simplemente no existe — indistinguible de "todavía no lo hicimos".
 *
 * Las NEGATIVAS importan tanto como las positivas y están abajo: un manejador
 * que hiciera LAS DOS cosas en cualquiera de los dos botones —o que de paso
 * cambiara la preferencia— pasaría todas las pruebas positivas.
 */

const CLAVE = 'mt.detallesAparte.v1';

/**
 * jsdom no implementa `matchMedia`, y el layout la llama en la inicialización de
 * sus campos: sin esto el componente ni se construye.
 *
 * `matches: false` NO es un atajo — es el caso que se quiere probar: **escritorio**.
 * El botón de multitarea existe sólo ahí (`@if (!isMobile())`), porque en un
 * teléfono o en una caja de tienda no hay ventanas que administrar.
 */
function escritorio(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('LayoutComponent · `[MT.3]` el botón de multitarea', () => {
  let fix: ComponentFixture<LayoutComponent>;
  let mt: MultitareaService;
  let abrirVentana: ReturnType<typeof vi.fn>;

  /** El botón de verdad, localizado como lo localiza un lector de pantalla. */
  const boton = (): HTMLButtonElement => {
    const b = (fix.nativeElement as HTMLElement).querySelector('button[aria-label="Multitarea"]');
    if (!b) throw new Error('no se renderizó el botón de multitarea');
    return b as HTMLButtonElement;
  };

  /**
   * El menú se dibuja con `appendTo="body"`, o sea FUERA del árbol del
   * componente: buscarlo en `fix.nativeElement` daría siempre vacío y la prueba
   * leería "el menú no abrió" cuando abrió perfecto.
   */
  const itemsDelMenu = (): HTMLElement[] =>
    Array.from(document.body.querySelectorAll('.p-menu-item-link, .p-menu-item-label')).filter(
      (e): e is HTMLElement => e instanceof HTMLElement,
    );

  const etiquetas = (): string[] =>
    Array.from(document.body.querySelectorAll('.p-menu .p-menu-item-label'))
      .map((e) => (e.textContent ?? '').trim())
      .filter(Boolean);

  const menuAbierto = (): boolean => document.body.querySelector('.p-menu') !== null;

  const clicIzquierdo = (): void => {
    boton().click();
    fix.detectChanges();
  };

  /** El gesto real: `contextmenu` es lo que emite el navegador con el botón derecho. */
  const clicDerecho = (): MouseEvent => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    boton().dispatchEvent(ev);
    fix.detectChanges();
    return ev;
  };

  /** Aprieta el item del menú cuyo texto empieza con lo pedido. */
  const clicEnItem = (texto: string): void => {
    const item = itemsDelMenu().find((e) => (e.textContent ?? '').trim().startsWith(texto));
    if (!item) throw new Error(`no hay item "${texto}" en el menú; hay: ${etiquetas().join(' | ')}`);
    (item.closest('a, button, [role="menuitem"]') as HTMLElement | null)?.click() ?? item.click();
    fix.detectChanges();
  };

  beforeEach(async () => {
    localStorage.removeItem(CLAVE);
    escritorio();
    abrirVentana = vi.fn();
    vi.stubGlobal('open', abrirVentana);

    await TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        MessageService,
        { provide: AuthService, useValue: { user: () => ({ username: 'edgar', role_name: 'admin', permissions: {} }) } },
        // Con permisos: sin ellos el layout entra en modo KIOSCO (`isRestricted`) y esconde
        // la barra entera — incluido el botón que se prueba.
        { provide: PermissionsService, useValue: { has: () => true, hasAny: () => true, isAdmin: () => true } },
        { provide: ThemeService, useValue: { isMonochrome: () => true, toggle: vi.fn() } },
        { provide: DataUpdateService, useValue: { hasPendingUpdate: signal(false), init: vi.fn(), destroy: vi.fn() } },
        { provide: WebSocketService, useValue: { connected: signal(false) } },
        { provide: HapticService, useValue: { tap: vi.fn(), impact: vi.fn() } },
        { provide: CountFocusService, useValue: { active: signal(false) } },
        { provide: DataScopeService, useValue: { dim: () => of(null) } },
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), disconnect: vi.fn(), alert$: new Subject(), connected: signal(false) } },
        { provide: FindingsService, useValue: { stats: () => of({}) } },
        { provide: ActionsService, useValue: { stats: () => of({}) } },
        { provide: ServiceDeskService, useValue: { notifications: () => of([]) } },
        { provide: EtiquetasService, useValue: { notices: () => of([]) } },
      ],
    }).compileComponents();

    fix = TestBed.createComponent(LayoutComponent);
    mt = TestBed.inject(MultitareaService);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  });

  afterEach(() => {
    fix?.destroy();
    document.body.querySelectorAll('.p-menu').forEach((e) => e.remove());
    vi.unstubAllGlobals();
    localStorage.removeItem(CLAVE);
    TestBed.resetTestingModule();
  });

  it('el botón existe en escritorio, con su `aria-haspopup`', () => {
    expect(boton().getAttribute('aria-haspopup')).toBe('menu');
    // Cerrado de arranque: un menú que nace abierto tapa la barra.
    expect(boton().getAttribute('aria-expanded')).toBe('false');
  });

  describe('clic IZQUIERDO → abre la pestaña, directo', () => {
    it('abre la URL actual en otra pestaña, con noopener', () => {
      clicIzquierdo();
      expect(abrirVentana).toHaveBeenCalledWith(window.location.href, '_blank', 'noopener');
    });

    /**
     * NEGATIVA. El clic principal es la ACCIÓN y nada más: si además destapara
     * el menú, quedaría un menú flotando sobre una pestaña que ya se abrió —
     * y ese menú ya no gobierna nada de lo que la persona está mirando.
     */
    it('NEGATIVA: NO abre el menú', () => {
      clicIzquierdo();
      expect(menuAbierto()).toBe(false);
      expect(boton().getAttribute('aria-expanded')).toBe('false');
    });

    /** NEGATIVA: es una acción, no una preferencia. No debe tocar el modo. */
    it('NEGATIVA: NO cambia la preferencia', () => {
      mt.ponerModo('lado');
      clicIzquierdo();
      expect(mt.modo()).toBe('lado');
    });

    it('dos clics, dos pestañas: la acción no se "consume"', () => {
      clicIzquierdo();
      clicIzquierdo();
      expect(abrirVentana).toHaveBeenCalledTimes(2);
    });
  });

  describe('clic DERECHO → el menú de opciones', () => {
    it('abre el menú con la acción y los tres modos', () => {
      expect(menuAbierto()).toBe(false);
      clicDerecho();
      expect(menuAbierto()).toBe(true);
      expect(etiquetas()).toEqual([
        'Abrir esta pantalla en otra ventana',
        'Al abrir un detalle…',
        'Reemplazar esta pantalla',
        'Abrirlo al lado (pantalla partida)',
        'Abrirlo en otra ventana',
      ]);
      expect(boton().getAttribute('aria-expanded')).toBe('true');
    });

    /**
     * Sin `preventDefault`, el navegador dibuja SU menú contextual encima del
     * nuestro: el gesto abre dos menús y gana el de él. jsdom no pinta ese menú,
     * así que lo que se afirma es lo único observable y lo que de verdad lo
     * gobierna — que el evento quedó cancelado.
     */
    it('cancela el menú contextual del navegador', () => {
      expect(clicDerecho().defaultPrevented).toBe(true);
    });

    /**
     * NEGATIVA. Si el clic derecho además disparara la acción, cada intento de
     * mirar las opciones abriría una pestaña de más.
     */
    it('NEGATIVA: NO abre ninguna pestaña', () => {
      clicDerecho();
      expect(abrirVentana).not.toHaveBeenCalled();
    });

    it('vuelve a apretarlo y el menú se cierra', () => {
      clicDerecho();
      expect(menuAbierto()).toBe(true);
      clicDerecho();
      expect(boton().getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('las opciones del menú', () => {
    /** La acción, que es lo único del menú que NO es una preferencia. */
    it('«Abrir esta pantalla en otra ventana» abre la URL actual, con noopener', () => {
      clicDerecho();
      clicEnItem('Abrir esta pantalla en otra ventana');
      expect(abrirVentana).toHaveBeenCalledWith(window.location.href, '_blank', 'noopener');
    });

    it('NEGATIVA: esa acción NO cambia la preferencia', () => {
      clicDerecho();
      clicEnItem('Abrir esta pantalla en otra ventana');
      expect(mt.modo()).toBe('aqui');
      expect(localStorage.getItem(CLAVE)).toBeNull();
    });

    const modos: [texto: string, modo: string][] = [
      ['Reemplazar esta pantalla', 'aqui'],
      ['Abrirlo al lado (pantalla partida)', 'lado'],
      ['Abrirlo en otra ventana', 'ventana'],
    ];

    for (const [texto, modo] of modos) {
      it(`«${texto}» deja el modo en "${modo}" y lo persiste`, () => {
        // Se arranca en otro modo a propósito: si el test empezara en el mismo
        // que afirma, un item que no hiciera NADA pasaría igual.
        mt.ponerModo(modo === 'lado' ? 'ventana' : 'lado');
        fix.detectChanges();
        clicDerecho();
        clicEnItem(texto);
        expect(mt.modo()).toBe(modo);
        expect(localStorage.getItem(CLAVE)).toBe(modo);
      });

      it(`«${texto}» elegido se marca con el check al reabrir el menú`, () => {
        clicDerecho();
        clicEnItem(texto);
        clicDerecho();
        const marcado = Array.from(document.body.querySelectorAll('.p-menu .p-menu-item-link'))
          .filter((e) => e.querySelector('.pi-check-circle'))
          .map((e) => (e.textContent ?? '').trim());
        expect(marcado).toEqual([texto]);
      });
    }

    /**
     * NEGATIVA sobre el check: si el ícono se pintara siempre, la prueba de
     * arriba pasaría sin que el menú diga nada. Exactamente UNO, nunca tres.
     */
    it('NEGATIVA: el check está en UNO solo, no en los tres', () => {
      clicDerecho();
      expect(document.body.querySelectorAll('.p-menu .pi-check-circle').length).toBe(1);
    });

    it('«Al abrir un detalle…» es un rótulo, no una opción: está deshabilitado', () => {
      clicDerecho();
      const rotulo = Array.from(document.body.querySelectorAll('.p-menu .p-menu-item')).find((e) =>
        (e.textContent ?? '').includes('Al abrir un detalle'),
      );
      expect(rotulo?.className).toContain('p-disabled');
    });
  });

});
