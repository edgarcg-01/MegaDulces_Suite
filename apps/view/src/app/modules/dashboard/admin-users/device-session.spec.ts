import {
  SESSION_PRESETS,
  generateDevicePassword,
  isDeviceAccount,
  sessionLabel,
} from './device-session';

/**
 * `[CH.1.11]` — Cada afirmación de la pantalla de dispositivos con su negativa
 * (ADR-056: un gate sin prueba negativa es una intención).
 *
 * Funciones puras, sin `TestBed`: lo que se prueba es la regla, no el render.
 */
describe('device-session', () => {
  describe('isDeviceAccount', () => {
    it('una cuenta con TTL propio ES un dispositivo', () => {
      expect(isDeviceAccount({ token_ttl_days: 365 })).toBe(true);
      expect(isDeviceAccount({ token_ttl_days: 1 })).toBe(true);
    });

    // La negativa que importa: si esto diera `true`, TODA la población (126
    // cuentas en prod) se pintaría como kiosco y el filtro no filtraría nada.
    it('una persona (sin TTL) NO es un dispositivo', () => {
      expect(isDeviceAccount({ token_ttl_days: null })).toBe(false);
      expect(isDeviceAccount({})).toBe(false);
      expect(isDeviceAccount({ token_ttl_days: undefined })).toBe(false);
    });
  });

  describe('sessionLabel', () => {
    it('nombra la duración de una cuenta de dispositivo', () => {
      expect(sessionLabel(365)).toBe('Sesión 1 año');
      expect(sessionLabel(30)).toBe('Sesión 30 d');
      expect(sessionLabel(180)).toBe('Sesión 180 d');
    });

    it('sin TTL dice "normal", nunca un número inventado', () => {
      expect(sessionLabel(null)).toBe('Sesión normal');
      expect(sessionLabel(undefined)).toBe('Sesión normal');
    });
  });

  describe('SESSION_PRESETS', () => {
    // El primer preset es el que APAGA la sesión larga: si dejara de ser `null`,
    // la pantalla no tendría forma de volver una cuenta al default de 12 h.
    it('el primer preset devuelve al default global (null)', () => {
      expect(SESSION_PRESETS[0].value).toBeNull();
    });

    it('ningún preset se acerca al techo de 3650 días', () => {
      for (const p of SESSION_PRESETS) {
        if (p.value !== null) {
          expect(p.value).toBeGreaterThanOrEqual(1);
          expect(p.value).toBeLessThanOrEqual(365);
        }
      }
    });
  });

  describe('generateDevicePassword', () => {
    it('tiene largo fijo y no se repite entre llamadas', () => {
      const a = generateDevicePassword();
      const b = generateDevicePassword();
      expect(a.length).toBe(14);
      expect(b.length).toBe(14);
      expect(a).not.toBe(b);
    });

    // La razón de ser del alfabeto: esta contraseña se teclea a mano en el piso,
    // muchas veces leída de un papel. Un `O` que se lee `0` es una llamada a
    // soporte. 200 muestras = 2,800 caracteres.
    it('nunca emite un caracter ambiguo (0 O 1 l I) en 200 muestras', () => {
      const ambiguos = /[0O1lI]/;
      for (let i = 0; i < 200; i++) {
        const pass = generateDevicePassword();
        expect(pass).not.toMatch(ambiguos);
      }
    });

    it('usa más de un caracter distinto (no devuelve el mismo repetido)', () => {
      const pass = generateDevicePassword();
      expect(new Set(pass.split('')).size).toBeGreaterThan(3);
    });
  });
});
