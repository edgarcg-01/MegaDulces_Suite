/**
 * `[RH.1.4]`/`[RH.1.4b]` Las reglas de la carga de personas, sin base (corre en CI). Lo que se prueba es lo que
 * decide a quién se crea, a quién se liga, qué fichas son la misma persona, y que la sección de RH se guarda tal cual.
 */
import fs from 'fs';
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const P = require(path.join(RAIZ, 'database/scripts/rh/carga-personas-mega-talento.js'));
const MAPEO = JSON.parse(fs.readFileSync(P.MAPEO_POR_OMISION, 'utf8'));
const migPersonas = require(path.join(RAIZ, 'database/migrations-newdb', `${P.MIGRACION_PERSONAS}.js`));

const ficha = (o: Record<string, unknown>) => ({ sitio: 'cedis', codigo: '1', nombre: 'Ana', nombre_completo: 'Ana López Ruiz', departamento: null, activo: true, es_promotora: false, ...o });

describe('[RH.1.4b] carga de personas — reglas', () => {
  it('el rol sin acceso es el de la migración', () => {
    expect(migPersonas.ROL).toBe(P.ROL_SIN_ACCESO);
  });

  it('el mapeo trae sólo plazas, cada una con su fuente, y confirma Madero y Catedral', () => {
    expect(MAPEO.departamentos).toBeUndefined();
    const sitios = MAPEO.sitios as Record<string, { warehouse_code: string | null; fuente: string }>;
    expect(Object.keys(sitios)).toEqual(expect.arrayContaining([
      'morelia-abastos', 'zamora-canindo', 'sucursal-ph', 'la-piedad-abastos', 'corporativo', '8-esquinas',
      'morelia-vicente-guerrero', 'zamora-catedral', 'yurecuaro-centro', 'cedis', 'reloj-196']));
    for (const s of Object.values(sitios)) expect(s.fuente.length).toBeGreaterThan(5);
    expect([sitios['morelia-vicente-guerrero'].warehouse_code, sitios['zamora-catedral'].warehouse_code]).toEqual(['07', '05']);
  });

  it('la sección de RH se guarda TAL CUAL (mayúsculas, sin espacios de sobra), nunca traducida', () => {
    expect(P.seccionDe('  suc.Padre   Hidalgo ')).toBe('SUC.PADRE HIDALGO');
    expect(P.seccionDe('STAFF LA PIEDAD')).toBe('STAFF LA PIEDAD');
    expect(P.seccionDe('')).toBeNull();
    expect(P.seccionDe(null)).toBeNull();
  });

  describe('agruparPersonas', () => {
    it('el mismo nombre completo en dos plazas es UNA persona con dos fichas', () => {
      const g = P.agruparPersonas([
        ficha({ sitio: 'corporativo', codigo: '126' }),
        ficha({ sitio: '8-esquinas', codigo: '73', nombre_completo: 'ana lópez  ruiz' }),
        ficha({ sitio: 'cedis', codigo: '9', nombre_completo: 'Otra Persona Distinta' }),
      ]);
      expect(g.map((p: { fichas: unknown[] }) => p.fichas.length)).toEqual([2, 1]);
    });

    it('⛔ NEGATIVA — un nombre de menos de 3 palabras no se une con nada (es un apodo)', () => {
      const g = P.agruparPersonas([
        ficha({ sitio: 'corporativo', codigo: '1', nombre_completo: null, nombre: 'Juan Pérez' }),
        ficha({ sitio: 'cedis', codigo: '2', nombre_completo: null, nombre: 'Juan Pérez' }),
      ]);
      expect(g).toHaveLength(2);
    });
  });

  it('el almacén de la persona: el de sus plazas si coinciden; si no, ninguno', () => {
    expect(P.almacenDe([ficha({ sitio: 'cedis' }), ficha({ sitio: 'corporativo' })], MAPEO.sitios)).toBe('00');
    expect(P.almacenDe([ficha({ sitio: 'cedis' }), ficha({ sitio: 'sucursal-ph' })], MAPEO.sitios)).toBeNull();
  });

  describe('decidir', () => {
    it('reusa a la persona ya ligada (idempotente)', () => {
      expect(P.decidir({ ligadas: ['u1'], cuentas: ['u9'], palabras: 3 })).toEqual({ accion: 'reusar', userId: 'u1' });
    });
    it('liga a una cuenta existente SÓLO si es una y el nombre es completo', () => {
      expect(P.decidir({ ligadas: [], cuentas: ['u9'], palabras: 3 })).toEqual({ accion: 'ligar_cuenta', userId: 'u9' });
    });
    it('el empate con cuentas de la Suite NO frena: crea desde Mega Talento y deja aviso para Sistemas', () => {
      expect(P.decidir({ ligadas: [], cuentas: ['u8', 'u9'], palabras: 4 })).toEqual({ accion: 'crear', aviso: 'varias_cuentas_de_la_suite_con_el_mismo_nombre' });
      expect(P.decidir({ ligadas: [], cuentas: ['u9'], palabras: 2 })).toEqual({ accion: 'crear', aviso: 'nombre_corto_coincide_con_una_cuenta' });
    });
    it('⛔ sólo se detiene si sus códigos ya están ligados a dos personas', () => {
      expect(P.decidir({ ligadas: ['u1', 'u2'], cuentas: [], palabras: 3 })).toMatchObject({ accion: 'por_decidir' });
    });
    it('sin nada → crear sin aviso', () => {
      expect(P.decidir({ ligadas: [], cuentas: [], palabras: 1 })).toEqual({ accion: 'crear' });
    });
  });

  it('username estable por ficha', () => {
    expect(P.usernameDe('8-esquinas', '0042')).toBe('mt.8-esquinas.0042');
    expect(P.usernameDe('Corporativo Comida', 'A 7')).toBe('mt.corporativo-comida.a-7');
  });
});
