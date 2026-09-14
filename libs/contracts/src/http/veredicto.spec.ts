import { ORDEN_VEREDICTO, veredictoDe, type ColaMedida, type MeVeredicto } from './identity-me.contract';

/**
 * `[SN.29]` — El veredicto de una cola de trabajo.
 *
 * ── Por qué este archivo existe ─────────────────────────────────────────────────────────────
 * `veredictoDe` nació en `libs/trade/src/lib/users/me-work.ts`, que **no tiene runner de pruebas**
 * (sólo `lint`). Dejarlo ahí habría sido un primitivo sin candado — exactamente lo que ADR-056
 * prohíbe, y lo que la Fase VP contó 21 veces en este repo. Se mudó a `libs/contracts`, donde vive
 * su tipo y donde `[SN.1]` ya había montado jest.
 *
 * ── Qué se vigila ───────────────────────────────────────────────────────────────────────────
 * Las tres confusiones que esta función existe para evitar, cada una medida contra prod el
 * 2026-09-14 antes de escribirse:
 *
 *  1. **`cerradas_30d: null` ≠ `cerradas_30d: 0`.** «La fuente no lo puede contestar» y «nadie
 *     cerró ninguna» son afirmaciones OPUESTAS. `logistics.fleet_alerts` no tiene `updated_at`, y
 *     un `?? 0` en el camino la habría declarado congelada teniendo 10,339 filas resueltas.
 *  2. **`sin_medir` ≠ `al_dia`.** Lo que no se pudo medir no se ordena junto a lo sano.
 *  3. **Una cola sin umbral no puede salir `atrasada`** — y por eso el umbral es obligatorio en el
 *     registro. Es el `cfg ? classify : 'ok'` que la Fase VP encontró en `db-health`.
 *
 * El reloj se inyecta (`ahora`) porque una prueba que depende de `Date.now()` real cambia de
 * resultado con el calendario: las fechas de acá son relativas a un instante fijo.
 */

/** Instante fijo de referencia. Todas las fechas del archivo se calculan contra éste. */
const AHORA = Date.parse('2026-09-14T12:00:00.000Z');
const haceDias = (n: number): string => new Date(AHORA - n * 86_400_000).toISOString();

const cola = (p: Partial<ColaMedida> & { flujo?: Partial<ColaMedida['flujo']> }): ColaMedida => ({
  total: 10,
  mas_viejo_at: haceDias(1),
  ...p,
  flujo: { entradas_7d: 1, entradas_30d: 4, cerradas_30d: 4, ...(p.flujo ?? {}) },
});

const v = (c: ColaMedida, umbral: number | null = 7): MeVeredicto => veredictoDe(c, umbral, AHORA);

describe('SN.29 · veredictoDe — qué hacer con una cola, no cuánto tiene', () => {
  describe('congelada: cero salidas MEDIDAS', () => {
    it('la cola sin una sola fila resuelta en 30 días es congelada, no atrasada', () => {
      // El caso real: `reconciliation.discrepancies`, 2,409 abiertas de 2,409 filas, desde el 8-jul.
      const descuadres = cola({
        total: 2409,
        mas_viejo_at: haceDias(68),
        flujo: { entradas_7d: 209, entradas_30d: 648, cerradas_30d: 0 },
      });
      expect(v(descuadres)).toBe('congelada');
    });

    it('⛔ NEGATIVA — con `cerradas_30d: null` NO puede salir congelada: es otra afirmación', () => {
      const sinMedirSalidas = cola({
        total: 2409,
        mas_viejo_at: haceDias(68),
        flujo: { entradas_7d: 209, entradas_30d: 648, cerradas_30d: null },
      });
      expect(v(sinMedirSalidas)).not.toBe('congelada');
      // Entró algo y no se sabe cuánto salió: no se puede afirmar que se acumule ni que esté sana.
      expect(v(sinMedirSalidas)).toBe('atrasada');
    });

    it('cero salidas SIN abiertos no es congelada: no hay nada estancado', () => {
      expect(v(cola({ total: 0, flujo: { entradas_30d: 0, cerradas_30d: 0 } }))).toBe('al_dia');
    });
  });

  describe('se_acumula: entra más de lo que sale, en la misma ventana', () => {
    it('648 entradas contra 12 salidas: resuelve el 1.9% de lo que llega', () => {
      expect(v(cola({ flujo: { entradas_30d: 648, cerradas_30d: 12 } }))).toBe('se_acumula');
    });

    it('la fluctuacion normal de una cola en regimen NO es crecimiento', () => {
      // El caso que refuto la regla `entradas > cerradas` en la primera corrida de esta prueba:
      // 3 filas de saldo sobre 7,205. Ver `RITMO_MINIMO` en el contrato.
      expect(v(cola({ total: 9, flujo: { entradas_30d: 7205, cerradas_30d: 7202 } }), 1)).toBe('al_dia');
    });

    it('sin entradas en 30 dias no puede estar creciendo (y no se divide por cero)', () => {
      expect(v(cola({ total: 5, flujo: { entradas_30d: 0, cerradas_30d: 0 } }), 90)).toBe('congelada');
      expect(v(cola({ total: 5, flujo: { entradas_30d: 0, cerradas_30d: 3 } }), 90)).toBe('al_dia');
    });

    it('la cola que drena más de lo que recibe queda al día aunque sea grande', () => {
      // El caso real: `logistics.fleet_alerts` — 9 abiertas, 7,205 entradas, 7,202 resueltas.
      const flota = cola({
        total: 9,
        mas_viejo_at: haceDias(0),
        flujo: { entradas_7d: 9, entradas_30d: 7205, cerradas_30d: 7202 },
      });
      expect(v(flota, 1)).toBe('al_dia');
    });

    it('⛔ la ventana es la MISMA para los dos lados: `entradas_7d` no participa del veredicto', () => {
      // Un pico de esta semana sobre un mes a la baja NO debe declararse "crece". Si el veredicto
      // mirara `entradas_7d` normalizado, 209/7 = 29.8/día contra 7,262/30 = 242/día diría lo
      // correcto por casualidad; con un pico grande diría lo contrario.
      const picoSobreMesSano = cola({
        flujo: { entradas_7d: 5000, entradas_30d: 100, cerradas_30d: 900 },
      });
      expect(v(picoSobreMesSano)).toBe('al_dia');
    });
  });

  describe('atrasada: el umbral declarado', () => {
    it('pasa el umbral y lo dice', () => {
      expect(v(cola({ mas_viejo_at: haceDias(8) }), 7)).toBe('atrasada');
    });

    it('justo en el umbral todavía no está atrasada (es `>`, no `>=`)', () => {
      expect(v(cola({ mas_viejo_at: haceDias(7) }), 7)).toBe('al_dia');
    });

    it('⛔ NEGATIVA — sin umbral NUNCA sale atrasada, y por eso el registro lo exige', () => {
      // Ésta es la razón de que `BandejaDef.umbral_dias` sea obligatorio: una cola sin umbral se
      // pinta sana para siempre. Es el `cfg ? classify : 'ok'` de `db-health` (Fase VP).
      expect(v(cola({ mas_viejo_at: haceDias(900) }), null)).toBe('al_dia');
    });
  });

  describe('sin_medir: lo que no se pudo medir NO se asume sano', () => {
    it('sin flujo y sin fecha', () => {
      expect(
        v(cola({ mas_viejo_at: null, flujo: { entradas_7d: null, entradas_30d: null, cerradas_30d: null } })),
      ).toBe('sin_medir');
    });

    it('sin flujo, con fecha dentro del umbral: tampoco se declara al día', () => {
      expect(
        v(cola({ mas_viejo_at: haceDias(1), flujo: { entradas_7d: null, entradas_30d: null, cerradas_30d: null } })),
      ).toBe('sin_medir');
    });

    it('sin flujo pero con fecha PASADA del umbral: el umbral alcanza para condenarla', () => {
      expect(
        v(cola({ mas_viejo_at: haceDias(40), flujo: { entradas_7d: null, entradas_30d: null, cerradas_30d: null } })),
      ).toBe('atrasada');
    });
  });

  describe('el orden de atención', () => {
    it('lo que el trabajo de hoy puede frenar va primero; lo congelado, después', () => {
      // No es por gravedad: una cola congelada necesita un DUEÑO, no un clic. Ponerla arriba
      // repetiría el defecto que esto corrige — promover lo que no se puede atender.
      expect(ORDEN_VEREDICTO.se_acumula).toBeLessThan(ORDEN_VEREDICTO.atrasada);
      expect(ORDEN_VEREDICTO.atrasada).toBeLessThan(ORDEN_VEREDICTO.congelada);
    });

    it('⛔ `sin_medir` nunca se ordena junto a `al_dia`', () => {
      expect(ORDEN_VEREDICTO.sin_medir).toBeLessThan(ORDEN_VEREDICTO.al_dia);
    });

    it('los cinco veredictos tienen posición y ninguna se repite', () => {
      const pos = Object.values(ORDEN_VEREDICTO);
      expect(pos).toHaveLength(5);
      expect(new Set(pos).size).toBe(5);
    });
  });

  describe('⚠️ la regresión que esto corrige: ordenar por antigüedad premia el abandono', () => {
    it('la cola sana queda por ENCIMA de la congelada aunque su más viejo sea de hoy', () => {
      // Medido en prod: con el orden de `[SN.12]` (antigüedad del más viejo) los descuadres —68
      // días, cero resueltos en su historia— encabezaban, y las alertas de flota —9 abiertas de
      // hoy, 10,339 cerradas— iban al fondo. La cola más sana de la empresa, enterrada por sana.
      const descuadres = cola({
        total: 2409, mas_viejo_at: haceDias(68),
        flujo: { entradas_7d: 209, entradas_30d: 648, cerradas_30d: 0 },
      });
      const reabasto = cola({
        total: 21125, mas_viejo_at: haceDias(66),
        flujo: { entradas_7d: 1688, entradas_30d: 4054, cerradas_30d: 7262 },
      });

      const orden = [descuadres, reabasto]
        .map((c) => v(c, 2))
        .map((x) => ORDEN_VEREDICTO[x]);

      // El reabasto (que se trabaja, 7,262 resueltas) queda por encima del congelado.
      expect(orden[1]).toBeLessThan(orden[0]);
    });
  });
});
