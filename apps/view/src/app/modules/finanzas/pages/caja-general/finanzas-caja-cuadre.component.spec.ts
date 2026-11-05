import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { FinanzasCajaCuadreComponent } from './finanzas-caja-cuadre.component';

/**
 * `[LE.CU.4]` La lógica del Cuadre nuevo. Los huecos son renglones reales de
 * `GET /finance/caja/cuadre-huecos` contra prod (ventana 12-oct → 3-nov, 2026-11-04).
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-11-05): haciendo que el filtro «falta» deje fuera todo
 * `libro_sin_ligar` se pone roja la 1 (el duplicado ligado sólo por importe desaparecía); cambiando
 * `warehouseName` por el código crudo en `sucursalDe`, la 3; dándole `?q=` a «capturar», la 5.
 */
const t = (o: Record<string, string> = {}) => ({ venta: 'na', corte: 'na', cobro: 'na', boveda: 'na', libro: 'na', control: 'na', ...o });
const HUECOS = [
  { tipo: 'kepler_sin_libro', fecha: '2026-11-03', monto: 27246.89, ref: '01|U-A-5|0000429|0011', via: 'llave', etiqueta: 'Cobro U-A-5 0000429 sin captura en el libro', testigos: t({ cobro: 'si', libro: 'no' }), dueno: 'caja', accion: 'capturar', falta: true, certeza: 'alta' },
  { tipo: 'bulto_sin_contar', fecha: '2026-11-03', monto: 188560, ref: 'CC-2026-00020|morralla', etiqueta: 'CC-2026-00020: monto tecleado como morralla', testigos: t(), dueno: 'conteo', accion: 'contar', falta: false, certeza: 'por_confirmar' },
  { tipo: 'corte_sin_cobro', fecha: '2026-10-29', monto: 27008.35, ref: '07|U-D-23|0000088', sucursal: '07', atraso_dias: 6, atraso_p90: 5, etiqueta: 'Corte U-D-23 0000088 de la caja 4 sin cobrar completo', testigos: t({ corte: 'si', cobro: 'difiere' }), dueno: 'sucursal', accion: 'pedir_sucursal', falta: true, certeza: 'alta' },
  { tipo: 'libro_sin_ligar', fecha: '2026-10-16', monto: 20345, ref: 'libro|CI-2026-00049', via: 'identidad', etiqueta: 'CI-2026-00049 es la ruta 21 del 2026-10-16', testigos: t({ cobro: 'difiere', libro: 'si' }), dueno: 'caja', accion: 'ligar', falta: false, certeza: 'alta' },
  { tipo: 'libro_sin_ligar', fecha: '2026-10-13', monto: 21101, ref: 'libro|CI-2026-00022', via: 'importe', etiqueta: 'CI-2026-00022 sin documento ligado (candidato por importe)', testigos: t({ cobro: 'si', libro: 'si' }), dueno: 'caja', accion: 'ligar', falta: true, certeza: 'por_confirmar' },
  { tipo: 'venta_sin_cobro', fecha: '2026-11-02', monto: 31492.68, ref: 'ruta 503|2026-11-02', etiqueta: 'Ruta 503: vendió y no cobró', testigos: t({ venta: 'si', cobro: 'no' }), dueno: 'ruta', accion: 'pedir_ruta', falta: true, certeza: 'alta' },
];
const suma = (n: number, monto: number) => ({ n, monto });
const RESPUESTA = {
  period: { from: '2026-11-01', to: '2026-11-30' }, datos_al: null, huecos: HUECOS, no_medido: ['salida_sin_documento', 'captura_doble'],
  resumen: {
    falta: suma(4, 106849.92), por_confirmar_n: 1, por_ligar: suma(2, 41446), sin_contar: suma(1, 188560),
    por_dueno: { caja: suma(2, 48347.89), kepler: suma(0, 0), sucursal: suma(1, 27008.35), ruta: suma(1, 31492.68), direccion: suma(0, 0), conteo: suma(0, 0), desarrollo: suma(0, 0) },
  },
};

const crea = () => {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()] });
  const c = TestBed.runInInjectionContext(() => new FinanzasCajaCuadreComponent());
  c.hc.set(RESPUESTA as never);
  return c;
};
const refs = (c: FinanzasCajaCuadreComponent) => c.huecosVista().map((h) => h.ref);

describe('[LE.CU.4] el Cuadre de Caja General', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('1 · «falta» deja fuera lo ligado por identidad y el bulto, y CONSERVA lo ligado sólo por importe', () => {
    const c = crea();
    expect(refs(c)).toEqual(['01|U-A-5|0000429|0011', '07|U-D-23|0000088', 'libro|CI-2026-00022', 'ruta 503|2026-11-02']);
  });

  it('2 · cada cifra del reparto filtra la lista, y volver a elegirla regresa a «falta»', () => {
    const c = crea();
    c.setFiltro('kepler');
    expect(refs(c)).toEqual(['07|U-D-23|0000088']);
    c.setFiltro('por_ligar');
    expect(refs(c)).toEqual(['libro|CI-2026-00049', 'libro|CI-2026-00022']);
    c.setFiltro('por_ligar');
    expect(c.filtro()).toBe('falta');
    c.setFiltro('sin_contar');
    expect(refs(c)).toEqual(['CC-2026-00020|morralla']);
  });

  it('3 · la sucursal sale por su NOMBRE, de su campo o de la llave de Kepler; sin sucursal, nada', () => {
    const c = crea();
    const [kep, bulto, corte] = RESPUESTA.huecos as never[];
    for (const h of [kep, corte]) {
      const s = c.sucursalDe(h);
      expect(s).toBeTruthy();
      expect(s).not.toMatch(/^\d{2}$/);
    }
    expect(c.sucursalDe(bulto)).toBeNull();
  });

  it('4 · el documento se abre sólo cuando /movement lo sabe abrir', () => {
    const c = crea();
    const [kep, , corte, ligado] = RESPUESTA.huecos as never[];
    expect(c.movDe(kep)).toEqual({ source: 'kepler', key: '01|U-A-5|0000429|0011' });
    expect(c.movDe(ligado)).toEqual({ source: 'libro', key: 'libro|CI-2026-00049' });
    expect(c.movDe(corte)).toBeNull(); // un corte sin cuenta no es un movimiento de tesorería
    expect(c.folioDe(kep)).toBe('U-A-5 0000429');
    expect(c.folioDe(ligado)).toBe('CI-2026-00049');
  });

  it('5 · la acción no promete lo que la otra pantalla no hace: capturar lleva a la cola sin folio; ligar, con el folio del libro', () => {
    const c = crea();
    const [kep, bulto, corte, ligado, , ruta] = RESPUESTA.huecos as never[];
    expect(c.ligaAccion(kep)).toEqual({ label: 'Ir a la cola de Captura', ruta: '/finanzas/caja-general' });
    expect(c.ligaAccion(ligado)?.qp).toEqual({ q: 'CI-2026-00049', from: '2026-11-01', to: '2026-11-30' });
    expect(c.ligaAccion(bulto)?.ruta).toBe('/finanzas/caja-general/arqueos');
    expect(c.ligaAccion(corte)?.ruta).toBe('/finanzas/cortes-sucursales');
    expect(c.ligaAccion(ruta)).toBeNull();
    expect(c.quienCorto(ruta)).toBe('Pedir a la ruta');
  });

  it('6 · el veredicto dice cuánto falta y cuántos son por confirmar; lo no medido se nombra', () => {
    const c = crea();
    expect(c.veredicto(RESPUESTA as never)).toBe('Falta explicar $106,849.92 en 4 huecos · 1 por confirmar.');
    expect(c.textoNoMedido(RESPUESTA as never)).toBe('las salidas que sólo anota Control y las capturas dobles');
    expect(c.signo(-48047.7)).toBe('−$48,047.70');
    expect(c.signo(null)).toBe('no medido');
  });
});
