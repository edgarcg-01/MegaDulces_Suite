import { TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { PresupuestoDireccion } from '@megadulces/contracts';
import { PresupuestoDireccionComponent } from './presupuesto-direccion.component';

/**
 * `[PU.DIR.2]` — **La revisión local de la FORMA, hecha a máquina.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Edgar pidió revisar en local antes de ir a prod. La revisión visual de esta pantalla exigiría
 * `nx serve view`, que **está prohibido** por `CLAUDE.md`. Esto es lo máximo que se puede
 * verificar sin levantar nada: se monta el componente de verdad y se afirma sobre el **DOM que
 * pinta**, no sobre su estado interno.
 *
 * ⚠️ **Y declara explícitamente su límite.** Valida la forma y las declaraciones: estados
 * vacíos, errores pintados, ausencias con su motivo, y que ningún `null` salga como `$0.00`.
 * **NO valida ninguna cifra** — eso sólo existe en prod, y mirar una pantalla no lo decide.
 *
 * ── Lo que cuida, y por qué se puede romper ─────────────────────────────────────────────────
 *  1. ⛔ **Que un bloque caído se PINTE.** Un bloque que desaparece cuando su consulta falla se
 *     lee como «no hay nada», que es la respuesta contraria a la verdad. Es la mitad del
 *     contrato, no una defensa.
 *  2. ⛔ **Que `null` nunca llegue a la pantalla como `$0.00`.** La versión en DOM de la trampa
 *     de `money()`: acá se mira el texto renderizado, no el valor de retorno de una función.
 *  3. **Que el universo viaje CON su tabla**, del payload, no de un copete escrito a mano.
 */

const PAYLOAD = (over: Partial<PresupuestoDireccion> = {}): PresupuestoDireccion => ({
  motor: {
    universo: 'corridas del autopiloto', as_of: '2026-10-12', fuente: 'analytics.cron_runs',
    corridas: 29, ok: 22, error: 7, ultima_ok: '2026-10-12 07:30', ultima_error: '2026-10-08 09:30',
    cadencia: 'diaria',
  },
  motor_error: null,
  ejercicios: {
    universo: 'las 3 filas, sin filtrar', as_of: '2026-10-12', fuente: 'budget.budgets',
    filas: [{
      id: 'b1', folio: 'PRE-2027-002', fiscal_year: 2027, status: 'borrador', is_test: false,
      creado_por: 'autopilot', dias_sin_firmar: 5, autorizado_por: null, autorizado_en: null,
    }],
  },
  ejercicios_error: null,
  obligaciones: {
    universo: 'obligaciones de gasto', as_of: '2026-10-12', fuente: 'budget.expense_obligations',
    reales: { n: 156, monto: 74_809_091.57 }, prueba: { n: 156, monto: 74_806_967.37 },
  },
  obligaciones_error: null,
  ledger: null,
  ledger_error: null,
  huecos: [],
  as_of: '2026-10-12',
  ...over,
});

function montar(d: PresupuestoDireccion | null, errorHttp = false) {
  TestBed.configureTestingModule({
    imports: [PresupuestoDireccionComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LOCALE_ID, useValue: 'es-MX' }],
  });
  const http = TestBed.inject(HttpTestingController);
  const fix = TestBed.createComponent(PresupuestoDireccionComponent);
  const req = http.expectOne((r) => r.url.includes('/finance/budget/budgets/direccion'));
  if (errorHttp) req.flush({ message: 'se cayo' }, { status: 500, statusText: 'Server Error' });
  else req.flush(d);
  fix.detectChanges();
  return { fix, texto: (fix.nativeElement as HTMLElement).textContent ?? '' };
}

describe('PU.DIR.2 · la vista Dirección, revisada en su DOM', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ si la respuesta entera falla, lo DICE — no deja la pantalla en blanco', () => {
    // ⚠️ La primera versión afirmaba `texto.length > 10` como proxy de «no está en blanco», y
    // falló: el mensaje del servidor medía 7. El umbral era mío e inventado. Lo que de verdad
    // dice el contrato es que el error viva DENTRO del bloque que lo anuncia — eso se afirma
    // sobre el elemento, no sobre cuántas letras tiene.
    const { fix, texto } = montar(null, true);
    expect(texto).toContain('se cayo');
    const alerta = (fix.nativeElement as HTMLElement).querySelector('.pres-alert');
    expect(alerta, 'el error no se pinta en su bloque').toBeTruthy();
    expect(alerta!.textContent).toContain('se cayo');
  });

  it('⛔ un bloque caído se pinta con su motivo, y NO desaparece', () => {
    const { texto } = montar(PAYLOAD({ obligaciones: null, obligaciones_error: 'sin permiso sobre budget.*' }));
    expect(texto).toContain('sin permiso sobre budget.*');
    expect(texto).toContain('Las obligaciones, en dos universos');
  });

  it('⛔ un bloque nulo SIN motivo se denuncia como defecto del servidor, no se calla', () => {
    const { texto } = montar(PAYLOAD({ ledger: null, ledger_error: null }));
    expect(texto).toContain('defecto del servidor');
  });

  it('⛔⛔ ningún monto nulo sale como $0.00 en la pantalla', () => {
    // La versión en DOM de la trampa de money(): acá se mira lo que el usuario LEE.
    const { texto } = montar(PAYLOAD({
      ledger: {
        universo: 'budget_lines', as_of: '2026-10-12', fuente: 'budget.budget_lines',
        etapas: [{ etapa: 'vigente', por_ejercicio: [{ fiscal_year: 2026, monto: null }], quien_la_mueve: 'el motor' }],
      },
    }));
    expect(texto).toContain('sin medir');
    expect(texto).not.toContain('$0.00');
  });

  it('⛔ NEGATIVA — un cero REAL sí se publica: es un dato, no una ausencia', () => {
    const { texto } = montar(PAYLOAD({
      ledger: {
        universo: 'budget_lines', as_of: '2026-10-12', fuente: 'budget.budget_lines',
        etapas: [{ etapa: 'reservado', por_ejercicio: [{ fiscal_year: 2026, monto: 0 }], quien_la_mueve: 'el calendario' }],
      },
    }));
    expect(texto).toContain('$0.00');
  });

  it('el universo viaja CON su tabla, y sale del payload', () => {
    const { texto } = montar(PAYLOAD());
    expect(texto).toContain('budget.expense_obligations');
    expect(texto).toContain('budget.budgets');
    expect(texto).toContain('las 3 filas, sin filtrar');
  });

  it('⛔ un hueco NO medible muestra su motivo y ningún número', () => {
    const { fix } = montar(PAYLOAD({
      huecos: [{
        nombre: 'Ticket por canal', porque: 'ninguna fuente lo tiene',
        peso: { valor: null, unidad: 'tickets', medido: false, como: 'no existe conteo por canal' },
      }],
    }));
    const celdas = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('td'));
    const peso = celdas.find((c) => c.textContent?.includes('no existe conteo por canal'));
    expect(peso, 'el motivo del hueco no se pinta').toBeTruthy();
    expect(peso!.textContent).not.toMatch(/\d/);
  });

  /*
   * ⚠️ **Un `montar()` por caso.** `TestBed.configureTestingModule` no se puede llamar dos veces
   * sin resetear, así que un `it` con dos montajes falla por el ARNÉS y no por lo que vigila.
   * Está escrito en `comercial-ventas-por-ruta.url.spec.ts` desde antes, lo leí hoy, y lo volví
   * a hacer igual: la lección no se transfiere sola por haberla visto.
   */
  it('el aviso de corridas con error aparece cuando hay errores', () => {
    expect(montar(PAYLOAD()).texto).toContain('terminaron en error');
  });

  it('⛔ NEGATIVA — sin corridas con error, el aviso NO se pinta', () => {
    const { texto } = montar(PAYLOAD({ motor: { ...PAYLOAD().motor!, error: 0 } }));
    expect(texto).not.toContain('terminaron en error');
  });

  it('⛔ la respuesta declara lo que NO cubre cuando un bloque no se pudo medir', () => {
    const { texto } = montar(PAYLOAD({ motor: null, motor_error: 'timeout' }));
    expect(texto).toContain('no se pudo medir');
    expect(texto).toContain('el motor');
  });

  it('sin ejercicios, lo dice en vez de mostrar una tabla vacía', () => {
    const { texto } = montar(PAYLOAD({
      ejercicios: { universo: 'u', as_of: '2026-10-12', fuente: 'budget.budgets', filas: [] },
    }));
    expect(texto).toContain('No hay ningún ejercicio dado de alta');
  });
});
