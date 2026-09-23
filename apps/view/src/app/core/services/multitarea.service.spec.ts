import { TestBed } from '@angular/core/testing';
import { MultitareaService } from './multitarea.service';
import { alCambiarEnOtraVentana, guardarPreferencia, leerPreferencia } from '../utils/cross-tab';

/**
 * `[MT.2]` + `[MT.3]` — la multitarea es OPCIONAL y no cuesta nada en reposo.
 *
 * Tres propiedades, y cada una falla distinto:
 *
 *  1. **Apagada, la app se comporta como siempre.** El `target` viene vacío, así que
 *     `RouterLink` navega por dentro del SPA. Si esto se rompe, la preferencia deja
 *     de ser opcional y todo el mundo empieza a abrir ventanas sin pedirlo.
 *  2. **Prendida, el navegador abre aparte.** `target="_blank"` y nada más: cero
 *     interceptores de clic. Es lo que la hace imperceptible en rendimiento.
 *  3. **Llega a las otras ventanas.** Una preferencia de multitarea que no se
 *     propaga es una preferencia que miente: la prendés en una ventana, mirás la
 *     otra y se comporta al revés.
 */

const CLAVE = 'mt.detallesAparte.v1';

/** Lo que el navegador manda a las OTRAS ventanas cuando una escribe. */
function otraVentanaEscribe(clave: string, valor: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key: clave, newValue: valor, storageArea: localStorage }));
}

describe('Multitarea', () => {
  beforeEach(() => {
    localStorage.removeItem(CLAVE);
    TestBed.configureTestingModule({});
  });
  afterEach(() => {
    localStorage.removeItem(CLAVE);
    TestBed.resetTestingModule();
  });

  describe('la preferencia', () => {
    it('nace apagada: el enlace navega por dentro, como siempre', () => {
      const mt = TestBed.inject(MultitareaService);
      expect(mt.detallesAparte()).toBe(false);
      // undefined, no '_self': sin atributo en el DOM. Y NO null: el input
      // 'target' de RouterLink es 'string | undefined'.
      expect(mt.target()).toBeUndefined();
    });

    it('prendida, el enlace lleva target=_blank', () => {
      const mt = TestBed.inject(MultitareaService);
      mt.alternarDetallesAparte();
      expect(mt.detallesAparte()).toBe(true);
      expect(mt.target()).toBe('_blank');
    });

    it('se recuerda entre recargas', () => {
      TestBed.inject(MultitareaService).alternarDetallesAparte();
      expect(leerPreferencia(CLAVE)).toBe('1');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      expect(TestBed.inject(MultitareaService).detallesAparte()).toBe(true);
    });

    it('se apaga y vuelve a apagarse de verdad (no queda pegada)', () => {
      const mt = TestBed.inject(MultitareaService);
      mt.alternarDetallesAparte();
      mt.alternarDetallesAparte();
      expect(mt.detallesAparte()).toBe(false);
      expect(mt.target()).toBeUndefined();
      expect(leerPreferencia(CLAVE)).toBe('0');
    });
  });

  describe('llega a las otras ventanas', () => {
    it('otra ventana la prende → ésta se entera', () => {
      const mt = TestBed.inject(MultitareaService);
      expect(mt.detallesAparte()).toBe(false);
      otraVentanaEscribe(CLAVE, '1');
      expect(mt.detallesAparte()).toBe(true);
    });

    it('otra ventana la apaga → ésta se entera', () => {
      guardarPreferencia(CLAVE, '1');
      const mt = TestBed.inject(MultitareaService);
      expect(mt.detallesAparte()).toBe(true);
      otraVentanaEscribe(CLAVE, '0');
      expect(mt.detallesAparte()).toBe(false);
    });

    /**
     * NEGATIVA. Sin esto, un listener que reaccione a CUALQUIER clave pasaría las
     * dos pruebas de arriba: cambiar el tema, el filtro guardado de una tabla o
     * el contador del verificador le movería la preferencia de multitarea a todo
     * el mundo. El evento 'storage' llega por TODAS las claves del origen, así
     * que filtrar no es opcional.
     */
    it('NEGATIVA: el cambio de OTRA clave no la toca', () => {
      const mt = TestBed.inject(MultitareaService);
      mt.alternarDetallesAparte();
      expect(mt.detallesAparte()).toBe(true);
      otraVentanaEscribe('tradeMarketingThemeMode', 'false');
      otraVentanaEscribe('auth_token', null);
      expect(mt.detallesAparte()).toBe(true);
    });
  });

  describe('el primitivo de sincronía', () => {
    it('avisa del borrado con null — que es cómo se ve un cierre de sesión', () => {
      const vistos: (string | null)[] = [];
      const dejar = alCambiarEnOtraVentana('auth_token', (v) => vistos.push(v));
      otraVentanaEscribe('auth_token', null);
      expect(vistos).toEqual([null]);
      dejar();
    });

    it("un 'clear()' de otra ventana (key null) se trata como borrado", () => {
      const vistos: (string | null)[] = [];
      const dejar = alCambiarEnOtraVentana('auth_token', (v) => vistos.push(v));
      window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage }));
      expect(vistos).toEqual([null]);
      dejar();
    });

    it('dejar de escuchar deja de escuchar', () => {
      const vistos: (string | null)[] = [];
      const dejar = alCambiarEnOtraVentana('x', (v) => vistos.push(v));
      dejar();
      otraVentanaEscribe('x', '1');
      expect(vistos).toEqual([]);
    });
  });
});
