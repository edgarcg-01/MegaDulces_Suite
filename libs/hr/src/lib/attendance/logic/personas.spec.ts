/**
 * `[RH.1.11]`/`[RH.1.12]` El motor de personas: la copia de `libs/` decide IGUAL que la del guion de la carga (corre
 * en el pod, sin `libs/`), y los candidatos de la bandeja salen de esa misma regla. Sin base: corre en CI.
 */
import path from 'path';
import { PALABRAS_MINIMAS, candidatosPara, decidir, normalizarNombre, palabras, seccionDe, usernameAlta, validarAlta, type CuentaPersona } from './personas';

const GUION = require(path.resolve(__dirname, '../../../../../../database/scripts/rh/carga-personas-mega-talento.js'));

describe('[RH.1.11] las dos copias del motor deciden igual', () => {
  const nombres = ['Ana López Ruiz', '  MARÍA   josé  peña-ortiz ', 'Ma. Guadalupe Sánchez', 'O\'Brien', '', null, 'Ñoño_Pérez.Gómez', 'Clau'];
  it('normalizarNombre, seccionDe y las palabras mínimas', () => {
    expect(PALABRAS_MINIMAS).toBe(GUION.PALABRAS_MINIMAS);
    for (const n of nombres) {
      expect(normalizarNombre(n)).toBe(GUION.normalizarNombre(n));
      expect(seccionDe(n)).toBe(GUION.seccionDe(n));
    }
  });
  it('decidir, en todos los casos de la carga', () => {
    const casos = [
      { ligadas: ['u1'], cuentas: ['c1'], palabras: 3 },
      { ligadas: ['u1', 'u2'], cuentas: [], palabras: 3 },
      { ligadas: [], cuentas: ['c1'], palabras: 3 },
      { ligadas: [], cuentas: ['c1'], palabras: 2 },
      { ligadas: [], cuentas: ['c1', 'c2'], palabras: 4 },
      { ligadas: [], cuentas: [], palabras: 1 },
    ];
    for (const c of casos) expect(decidir(c)).toEqual(GUION.decidir(c));
  });
});

const cuenta = (id: string, nombre: string, o: Partial<CuentaPersona> = {}): CuentaPersona => ({ id, nombre, warehouse_code: null, status: 'active', ...o });

describe('[RH.1.12] candidatos de la bandeja', () => {
  const cuentas = [
    cuenta('a', 'Ana López Ruiz', { warehouse_code: '03' }),
    cuenta('b', 'Ana López Ruiz', { warehouse_code: '05' }),
    cuenta('c', 'Ana Patricia López Ruiz'),
    cuenta('d', 'Beto Gómez'),
  ];

  it('⭐ mismo nombre de 3+ palabras y almacén compatible = sugerido (lo que haría la carga)', () => {
    const r = candidatosPara({ nombreReloj: 'ANA LOPEZ RUIZ', almacen: '03', ligadosMismoCodigo: [], cuentas });
    expect(r.map((x) => [x.user_id, x.motivo, x.sugerido])).toEqual([['a', 'mismo_nombre', true], ['c', 'nombre_parecido', false]]);
  });

  it('⛔ el almacén incompatible no se propone; dos cuentas con el mismo nombre = ninguna sugerida', () => {
    const r = candidatosPara({ nombreReloj: 'Ana López Ruiz', almacen: null, ligadosMismoCodigo: [], cuentas });
    expect(r.filter((x) => x.motivo === 'mismo_nombre').map((x) => x.user_id).sort()).toEqual(['a', 'b']);
    expect(r.some((x) => x.sugerido)).toBe(false);
  });

  it('⭐ su código ya ligado en otro reloj de la plaza va primero y es el sugerido', () => {
    const r = candidatosPara({ nombreReloj: 'Clau', almacen: '03', ligadosMismoCodigo: ['d'], cuentas });
    expect(r[0]).toMatchObject({ user_id: 'd', motivo: 'mismo_codigo', sugerido: true });
  });

  it('⛔ ligado a DOS personas: se muestran las dos, ninguna sugerida (la carga lo deja por decidir)', () => {
    const r = candidatosPara({ nombreReloj: 'x', almacen: null, ligadosMismoCodigo: ['a', 'd'], cuentas });
    expect(r.map((x) => x.user_id).sort()).toEqual(['a', 'd']);
    expect(r.some((x) => x.sugerido)).toBe(false);
  });

  it('un apodo de una palabra no propone por nombre; el tope se respeta', () => {
    expect(candidatosPara({ nombreReloj: 'Ana', almacen: null, ligadosMismoCodigo: [], cuentas })).toEqual([]);
    const muchas = Array.from({ length: 9 }, (_, i) => cuenta(`m${i}`, `Luis Pérez ${i}`));
    expect(candidatosPara({ nombreReloj: 'Luis Pérez', almacen: null, ligadosMismoCodigo: [], cuentas: muchas, max: 5 })).toHaveLength(5);
  });

  it('el alta pide nombre de 2+ palabras y sección; la sección se guarda en MAYÚSCULAS', () => {
    expect(validarAlta({ nombre: 'Ana', seccion: 'CAJAS' })).toHaveProperty('error');
    expect(validarAlta({ nombre: 'Ana López', seccion: '' })).toHaveProperty('error');
    expect(validarAlta({ nombre: '  Ana   López ', seccion: ' cajas  piso ' })).toEqual({ nombre: 'Ana López', seccion: 'CAJAS PISO' });
    expect(usernameAlta('Zamora Canindo', '015')).toBe('rh.zamora-canindo.015');
    expect(palabras('')).toBe(0);
  });
});
