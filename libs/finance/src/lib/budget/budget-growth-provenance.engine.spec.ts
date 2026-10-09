/**
 * `[PVI.4]` — Pruebas de la procedencia del supuesto de crecimiento.
 *
 * ⭐ **Es la primera prueba unitaria de `libs/finance/src/lib/budget/`**: 22 archivos, 0 specs.
 * La única compuerta de este motor era el `build` del CI, que compila y no juzga la lógica — y por
 * eso el defecto de abajo llegó a prod, corrió una noche entera y reportó `ok`.
 *
 * La prueba que define el éxito es la primera: **con los 4 canales ya guardados y sin procedencia
 * previa, la pasada TIENE que escribir.** Es exactamente el estado de producción medido el
 * 2026-10-09 (cron `ok`, 2,497 celdas, `growth_provenance` NULL ×3), y la razón es que el `upsert`
 * preguntaba por `derivado` —que estaba vacío— en vez de por la procedencia.
 *
 * Y hay una **prueba negativa que reconstruye la regla vieja** (estampar `manual` sobre todo canal
 * con valor guardado) para demostrar que no era un detalle de etiqueta: con los datos reales de
 * prod, esa regla **certifica como decisión humana** el +26.67 % de `mayoreo`, que mide −9.36 %
 * sobre $169,970,622 de meta. Sin esa prueba el arreglo sería una afirmación (ADR-056: un gate sin
 * prueba negativa es una intención).
 */
import { decidirProcedencia, type EntradaProcedencia, type PropuestaCanal } from './budget-growth-provenance.engine';
import type { ProcedenciaCrec } from './budget-sales-plan.service';

const AT = '2026-10-09T15:30:00.000Z';

/** El estado REAL del ejercicio vivo en prod, medido el 2026-10-09 09:19 MX. */
const GUARDADO_PROD: Record<string, number> = {
  ruta: 0.0826, mayoreo: 0.2667, preventa: 0.5121, mostrador: 0.2105,
};

/** Lo que `proposeGrowth` propone hoy, ya con el pareo por entidad de `[PVI.1]`. */
const PROPUESTA_PROD: Record<string, PropuestaCanal> = {
  ruta: { growth_pct: 0.1398, basis: 'yoy_paired', paired_periods: 9 },
  mayoreo: { growth_pct: -0.0936, basis: 'yoy_paired', paired_periods: 8 },
  preventa: { growth_pct: 0.0412, basis: 'yoy_paired', paired_periods: 9 },
  mostrador: { growth_pct: 0.0317, basis: 'default' },
};

const entrada = (p: Partial<EntradaProcedencia> = {}): EntradaProcedencia => ({
  byChannel: PROPUESTA_PROD, yaGuardado: GUARDADO_PROD, yaProc: null, at: AT, ...p,
});

/**
 * La regla VIEJA, reconstruida tal cual estaba en `budget-autopilot.service.ts` antes de PVI.4.
 * No se usa en producción: existe para que la prueba negativa tenga con qué comparar.
 */
function reglaVieja(e: EntradaProcedencia) {
  const derivado: Record<string, number> = {};
  const procedencia: Record<string, ProcedenciaCrec> = {};
  for (const [canal, c] of Object.entries(e.byChannel)) {
    if (e.yaGuardado[canal] == null) {
      derivado[canal] = Number(c.growth_pct);
      procedencia[canal] = { basis: (c.basis ?? 'default') as ProcedenciaCrec['basis'], at: e.at };
    } else {
      procedencia[canal] = { basis: 'manual', at: e.at };
    }
  }
  return { derivado, procedencia, escribir: Object.keys(derivado).length > 0 };
}

describe('[PVI.4] procedencia del crecimiento', () => {
  // ──────────────────────────────────────────────────────────────────────────────────────────
  // (A) El defecto que llegó a prod
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('con todos los canales ya guardados y SIN procedencia previa, escribe igual', () => {
    const d = decidirProcedencia(entrada());
    expect(d.derivado).toEqual({});           // no hay nada que derivar…
    expect(d.escribir).toBe(true);            // …y aun así hay algo que declarar
    expect(Object.keys(d.procedencia).sort()).toEqual(['mayoreo', 'mostrador', 'preventa', 'ruta']);
  });

  it('PRUEBA NEGATIVA: la regla vieja NO escribía — es el estado medido en prod', () => {
    const vieja = reglaVieja(entrada());
    expect(vieja.escribir).toBe(false);       // ⇐ por esto la columna quedó NULL con el cron en `ok`
    expect(decidirProcedencia(entrada()).escribir).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // (B) El defecto que estaba escondido por (A)
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('un número sin respaldo es `preexistente`, NUNCA `manual`', () => {
    const d = decidirProcedencia(entrada());
    for (const canal of Object.keys(GUARDADO_PROD)) {
      expect(d.procedencia[canal].basis).toBe('preexistente');
    }
    expect(Object.values(d.procedencia).some((p) => p.basis === 'manual')).toBe(false);
    expect(d.resumen.preexistentes).toBe(4);
  });

  it('PRUEBA NEGATIVA: la regla vieja firmaba como humano el +26.67 % refutado', () => {
    const vieja = reglaVieja(entrada());
    expect(vieja.procedencia['mayoreo'].basis).toBe('manual');   // ⇐ la mentira
    expect(decidirProcedencia(entrada()).procedencia['mayoreo'].basis).toBe('preexistente');
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // (C) Las reglas que impiden que el arreglo haga daño
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('una procedencia ya guardada se preserva verbatim, con su `at` original', () => {
    const previa: Record<string, ProcedenciaCrec> = {
      ruta: { basis: 'yoy_paired', paired_periods: 9, at: '2026-10-08T00:16:00.000Z' },
      mayoreo: { basis: 'manual', at: '2026-10-08T00:16:00.000Z' },
      preventa: { basis: 'preexistente', at: '2026-10-08T00:16:00.000Z' },
      mostrador: { basis: 'default', at: '2026-10-08T00:16:00.000Z' },
    };
    const d = decidirProcedencia(entrada({ yaProc: previa }));
    expect(d.procedencia).toEqual(previa);
    expect(d.procedencia['ruta'].at).toBe('2026-10-08T00:16:00.000Z');  // NO se re-estampa
    expect(d.escribir).toBe(false);                                      // sin cambio, sin churn
  });

  it('un `manual` guardado sigue siendo `manual`: la firma de una persona no se pisa', () => {
    const d = decidirProcedencia(entrada({ yaProc: { mayoreo: { basis: 'manual', at: AT } } }));
    expect(d.procedencia['mayoreo'].basis).toBe('manual');
    expect(d.procedencia['ruta'].basis).toBe('preexistente');
    expect(d.escribir).toBe(true);   // los otros 3 sí cambian
  });

  it('⛔ sin un solo canal NO escribe: un `{}` sobre NULL se leería como medición vacía', () => {
    const d = decidirProcedencia(entrada({ byChannel: {} }));
    expect(d.procedencia).toEqual({});
    expect(d.escribir).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // (D) Que lo que sí funcionaba siga funcionando
  // ──────────────────────────────────────────────────────────────────────────────────────────

  it('un canal nuevo se deriva con su basis real, y `default` cuenta como no medido', () => {
    const d = decidirProcedencia(entrada({ yaGuardado: {} }));
    expect(d.derivado).toEqual({ ruta: 0.1398, mayoreo: -0.0936, preventa: 0.0412, mostrador: 0.0317 });
    expect(d.procedencia['ruta'].basis).toBe('yoy_paired');
    expect(d.procedencia['ruta'].paired_periods).toBe(9);
    expect(d.procedencia['mostrador'].basis).toBe('default');
    expect(d.resumen).toEqual({ derivados: 4, respetados: 0, sin_medir: 1, preexistentes: 0 });
    expect(d.escribir).toBe(true);
  });

  it('mezcla: uno guardado sin respaldo + uno nuevo medido', () => {
    const d = decidirProcedencia(entrada({ yaGuardado: { mayoreo: 0.2667 } }));
    expect(Object.keys(d.derivado).sort()).toEqual(['mostrador', 'preventa', 'ruta']);
    expect(d.procedencia['mayoreo'].basis).toBe('preexistente');
    expect(d.procedencia['ruta'].basis).toBe('yoy_paired');
    expect(d.resumen).toEqual({ derivados: 3, respetados: 1, sin_medir: 1, preexistentes: 1 });
  });

  it('el resumen distingue las DOS ausencias: `default` no es `preexistente`', () => {
    const d = decidirProcedencia(entrada({ yaGuardado: { mostrador: 0.2105 } }));
    // `mostrador` venía con basis `default`, pero ya tiene número guardado ⇒ no se mide hoy.
    expect(d.procedencia['mostrador'].basis).toBe('preexistente');
    expect(d.resumen.sin_medir).toBe(0);
    expect(d.resumen.preexistentes).toBe(1);
  });
});
