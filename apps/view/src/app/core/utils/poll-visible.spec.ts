import { TestBed } from '@angular/core/testing';
import { encuestarVisible } from './poll-visible';

/**
 * Poléa sólo mientras la pestaña se ve.
 *
 * El primer bloque NO es una prueba de comportamiento, es LA MEDICIÓN: corre el
 * mismo escenario con 'setInterval' pelado y con 'encuestarVisible' y compara
 * las vueltas. Sin esto el cambio sería una intención — el proyecto pide el
 * antes/después medido cuando un commit mueve un número.
 *
 * El escenario es el de 'notifications-bell', que es el caso que manda: vive en
 * el header del layout, o sea corre en TODA pantalla de la Suite, cada 60 s.
 */

/** Pone la pestaña en un estado y avisa, como hace el navegador. */
function verPestania(estado: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: estado, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

const MINUTO = 60_000;

describe('encuestarVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  describe('la medición', () => {
    /**
     * 10 minutos de pestaña abierta, 8 de ellos sin que nadie la mire — que es
     * lo que pasa con la ventana que dejaste atrás para consultar otra cosa.
     */
    it('una pestaña de fondo deja de pedir: 10 vueltas → 3', () => {
      // ANTES: 'setInterval' pelado, que es lo que había en 12 de los 14 casos.
      let antes = 0;
      const timerViejo = setInterval(() => antes++, MINUTO);
      vi.advanceTimersByTime(1 * MINUTO);
      verPestania('hidden');
      vi.advanceTimersByTime(8 * MINUTO);
      verPestania('visible');
      vi.advanceTimersByTime(1 * MINUTO);
      clearInterval(timerViejo);

      // DESPUÉS: el mismo escenario, con el primitivo.
      let despues = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => despues++));
      vi.advanceTimersByTime(1 * MINUTO);
      verPestania('hidden');
      vi.advanceTimersByTime(8 * MINUTO);
      verPestania('visible');
      vi.advanceTimersByTime(1 * MINUTO);

      expect(antes).toBe(10);
      // 1 visible + 1 puesta al día al volver + 1 visible. Los 8 minutos de
      // fondo no piden nada.
      expect(despues).toBe(3);

      // La campana son DOS peticiones por vuelta: el ahorro en este escenario
      // es de 20 a 6 por pestaña de fondo cada 10 minutos.
      expect(antes * 2 - despues * 2).toBe(14);
    });
  });

  describe('la conducta', () => {
    it('oculta, no corre ni una vez', () => {
      let n = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => n++));
      verPestania('hidden');
      vi.advanceTimersByTime(10 * MINUTO);
      expect(n).toBe(0);
    });

    it('al volver después de un ciclo se pone al día sin esperar al timer', () => {
      let n = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => n++));
      verPestania('hidden');
      vi.advanceTimersByTime(5 * MINUTO);
      expect(n).toBe(0);
      verPestania('visible');
      expect(n).toBe(1); // ya, no dentro de 60 s
    });

    /**
     * NEGATIVA — el modo en que este cambio sería PEOR que no hacerlo.
     *
     * Si la puesta al día corriera en cada 'visibilitychange' sin mirar cuánto
     * pasó, alguien que alterna entre dos ventanas dispararía una consulta por
     * cada ida y vuelta: más peticiones que el timer ciego, que es justo lo que
     * la fase existe para bajar. Sin esta prueba, el bloque de la medición se
     * pone verde igual y el cambio se publica multiplicando el costo en el uso
     * más común de trabajar con dos ventanas.
     */
    it('alternar rápido entre ventanas NO dispara consultas de más', () => {
      let n = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => n++));
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(2_000); // 2 s mirando otra cosa
        verPestania('hidden');
        vi.advanceTimersByTime(2_000);
        verPestania('visible');
      }
      // 40 s de reloj en total: el timer no llegó a caer y ningún regreso
      // cumplió el ciclo, así que no se pidió nada.
      expect(n).toBe(0);
    });

    it('no dispara al arrancar salvo que se lo pidan', () => {
      let n = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => n++));
      expect(n).toBe(0);
      let m = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => m++, { inmediato: true }));
      expect(m).toBe(1);
    });

    it('parar corta el timer y deja de escuchar la pestaña', () => {
      let n = 0;
      const parar = TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => n++));
      vi.advanceTimersByTime(2 * MINUTO);
      expect(n).toBe(2);
      parar();
      vi.advanceTimersByTime(10 * MINUTO);
      verPestania('hidden');
      verPestania('visible');
      expect(n).toBe(2);
    });

    it('se corta sola cuando muere quien la creó', () => {
      let n = 0;
      TestBed.runInInjectionContext(() => encuestarVisible(MINUTO, () => n++));
      vi.advanceTimersByTime(1 * MINUTO);
      expect(n).toBe(1);
      TestBed.resetTestingModule(); // destruye el injector → dispara onDestroy
      vi.advanceTimersByTime(10 * MINUTO);
      expect(n).toBe(1);
    });
  });
});
