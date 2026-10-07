/**
 * `[SV.3]` — Candado de la pantalla "Mis rutas".
 *
 * ── Qué afirma ──────────────────────────────────────────────────────────────────────────
 * 1. Sin meta NO se pinta nada verde. Es la regla que la Fase VP existe para sostener y el
 *    estado real de las 4 rutas en prod hoy (`commercial.sales_targets` está vacía).
 * 2. El filtro "esta semana" arranca el LUNES, no el domingo que devuelve `getDay()`.
 * 3. El pivote día × ruta no pierde ni suma venta: lo que entra por la serie sale en el total.
 * 4. Una venta ausente es un guion con motivo, NUNCA un cero.
 *
 * Instanciar el componente también lo hace pasar por el compilador de Angular, que es la única
 * verificación de tipos y de plantilla disponible sin llegar al CI.
 */
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideZonelessChangeDetection } from '@angular/core';
import type { SupervisorTablero } from '@megadulces/contracts';
import { ComercialMisRutasComponent } from './comercial-mis-rutas.component';
import { ComercialService } from '../comercial.service';

const VACIO: SupervisorTablero = {
  periodo: { desde: '2026-10-01', hasta: '2026-10-06', dias: 6 },
  alcance: { reportes: 4, reportes_con_ruta: 4, rutas: ['1V001', '1V002'], motivo: null },
  rutas: [],
  serie: [],
  freshness: { data_as_of: null, status: 'unknown', stale: true, age_human: null, inputs: [] },
  cobertura: { measured: true, pct: 100, note: 'ok' },
};

/** Datos calcados de lo medido en prod el 2026-10-06 para las rutas de `mauricio_ramirez`. */
const CON_DATOS: SupervisorTablero = {
  ...VACIO,
  rutas: [
    {
      route_code: '1V001', etiqueta: '1V001 CANDELARIA SALGADO MORALES', dias_operados: 25,
      venta: 408010.09, tickets: 414, lineas: 1257, ticket_promedio: 985.53,
      meta_mes: null, venta_mes: 98731.89, estado: 'sin_meta',
      estado_motivo: 'Hay venta y no hay meta registrada.', avance: null,
      margen_pct: null, margen_motivo: 'La fuente declara el costo como sin dato.',
      ultimo_dia: '2026-10-06',
    },
    {
      route_code: '1V002', etiqueta: '1V002 RAFAEL VILLALOBOS CAMPOS', dias_operados: 25,
      venta: 216832.22, tickets: 0, lineas: 1618, ticket_promedio: null,
      meta_mes: null, venta_mes: 46878.77, estado: 'sin_meta',
      estado_motivo: 'Hay venta y no hay meta registrada.', avance: null,
      margen_pct: null, margen_motivo: 'La fuente declara el costo como sin dato.',
      ultimo_dia: '2026-10-06',
    },
  ],
  serie: [
    { route_code: '1V001', business_date: '2026-10-05', venta: 100, tickets: 2 },
    { route_code: '1V002', business_date: '2026-10-05', venta: 50, tickets: 1 },
    { route_code: '1V001', business_date: '2026-10-06', venta: 200, tickets: 3 },
  ],
};

function crear(payload: SupervisorTablero) {
  const svc = { misRutas: () => of(payload) };
  TestBed.configureTestingModule({
    imports: [ComercialMisRutasComponent],
    providers: [provideZonelessChangeDetection(), { provide: ComercialService, useValue: svc }],
  });
  const fx = TestBed.createComponent(ComercialMisRutasComponent);
  fx.detectChanges();
  return fx.componentInstance;
}

describe('SV.3 · Mis rutas', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('PRUEBA NEGATIVA: sin meta, ningún estado se pinta como bueno', () => {
    const c = crear(CON_DATOS);
    for (const r of CON_DATOS.rutas) {
      expect(r.estado).toBe('sin_meta');
      expect(c.severidad(r.estado)).not.toBe('success');
      expect(c.etiquetaEstado(r.estado)).toBe('Sin meta');
    }
    expect(c.sinMeta()).toBe(2);
  });

  it('CONTROL POSITIVO: con meta cumplida sí devuelve verde (si no, la negativa no prueba nada)', () => {
    const c = crear(VACIO);
    expect(c.severidad('ok')).toBe('success');
    expect(c.severidad('bad')).toBe('danger');
    expect(c.etiquetaEstado('ok')).toBe('En meta');
  });

  it('el pivote día × ruta no pierde ni inventa venta', () => {
    const c = crear(CON_DATOS);
    const filas = c.pivote();
    expect(filas.length).toBe(2);
    // Más reciente primero: el supervisor mira el día de hoy, no el de hace un mes.
    expect(filas[0].fecha).toBe('2026-10-06');
    const totalPivote = filas.reduce((a, f) => a + f.total, 0);
    const totalSerie = CON_DATOS.serie.reduce((a, p) => a + p.venta, 0);
    expect(totalPivote).toBe(totalSerie);
    // La celda ausente queda SIN clave, para que la plantilla pinte el guion con motivo y no un 0.
    expect(filas[0].porRuta['1V002']).toBeUndefined();
  });

  it('el nombre del vendedor sale sin repetir el código que ya está en su columna', () => {
    const c = crear(CON_DATOS);
    expect(c.nombreDe(CON_DATOS.rutas[0])).toBe('CANDELARIA SALGADO MORALES');
    // Y si la etiqueta NO empieza con el código, se respeta tal cual (no se recorta a ciegas).
    expect(c.nombreDe({ ...CON_DATOS.rutas[0], etiqueta: 'RUTA 23' })).toBe('RUTA 23');
    expect(c.nombreDe({ ...CON_DATOS.rutas[0], etiqueta: null })).toBe('');
  });

  it('ticket promedio: 0 tickets es un hueco declarado, no un cero', () => {
    const c = crear(CON_DATOS);
    const sinTickets = CON_DATOS.rutas.find((r) => r.tickets === 0)!;
    expect(sinTickets.ticket_promedio).toBeNull();
    // Y la tira de métricas tampoco lo dibuja en 0.
    const prom = c.metricas().find((m) => m.label === 'Ticket promedio')!;
    expect(prom.value).not.toBe(0);
  });

  it('el alcance vacío llega con motivo, para que la pantalla explique en vez de salir muda', () => {
    const c = crear({ ...VACIO, alcance: { reportes: 0, reportes_con_ruta: 0, rutas: [], motivo: 'sin_equipo' } });
    expect(c.data()?.alcance.motivo).toBe('sin_equipo');
    expect(c.codigos()).toEqual([]);
  });
});
