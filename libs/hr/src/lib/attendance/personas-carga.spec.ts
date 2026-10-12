/**
 * `[RH.1.4]` Las reglas de la carga de personas, sin base (corre en CI). Lo que se prueba es lo que
 * decide a quién se crea, a quién se liga y a quién NO se toca.
 */
import fs from 'fs';
import path from 'path';
import { esDeptoDePromotoria as esPromotoriaTs } from './logic/tipos';

const RAIZ = path.resolve(__dirname, '../../../../..');
const P = require(path.join(RAIZ, 'database/scripts/rh/carga-personas-mega-talento.js'));
const MAPEO = JSON.parse(fs.readFileSync(P.MAPEO_POR_OMISION, 'utf8'));
const mig = require(path.join(RAIZ, 'database/migrations-newdb', `${P.MIGRACION_PERSONAS}.js`));

describe('[RH.1.4] carga de personas — reglas', () => {
  it('la copia de esDeptoDePromotoria da lo mismo que la de la asistencia', () => {
    const casos = ['PROMOTORIA', 'Promotoras', 'ZONA PROMOTORIA', 'PROMOTORIA MEGA DULCES', 'promotoria megadulces',
      'Promotoría de marca · promotoria_marca', 'Tienda / Piso de Venta', '', null, 'STAFF'];
    for (const c of casos) expect(P.esDeptoDePromotoria(c)).toBe(esPromotoriaTs(c));
  });

  it('el departamento de promotoría que crea la migración lo reconoce la asistencia', () => {
    const [code, nombre] = mig.DEPTO_PROMOTORIA;
    expect(code).toBe(P.DEPTO_PROMOTORIA);
    // Así lo arma el lector del padrón: «nombre · código».
    expect(esPromotoriaTs(`${nombre} · ${code}`)).toBe(true);
    expect(mig.ROL).toBe(P.ROL_SIN_ACCESO);
  });

  it('el mapeo versionado se prepara sin variantes repetidas y cubre los 12 sitios', () => {
    const mp = P.prepararMapeo(MAPEO);
    expect(Object.keys(mp.sitios)).toEqual(expect.arrayContaining([
      'morelia-abastos', 'zamora-canindo', 'sucursal-ph', 'la-piedad-abastos', 'corporativo', '8-esquinas',
      'morelia-vicente-guerrero', 'zamora-catedral', 'yurecuaro-centro', 'cedis', 'reloj-196']));
    // Ninguna entrada está validada todavía: RH no contestó el doc de mapeos.
    expect(MAPEO.departamentos.every((g: { validado: boolean }) => g.validado === false)).toBe(true);
  });

  it('⛔ NEGATIVA — una variante en dos grupos rompe la preparación', () => {
    expect(() => P.prepararMapeo({ sitios: {}, departamentos: [
      { variantes: ['CAJAS'], department_code: 'cajas' }, { variantes: ['Cajas.'], department_code: 'tienda' }] })).toThrow(/dos grupos/);
  });

  it('normaliza el texto del departamento (acentos, puntos, espacios)', () => {
    expect(P.normalizarTexto('  Suc.Padre   Hidalgo ')).toBe('SUC PADRE HIDALGO');
    expect(P.normalizarTexto('Almacén')).toBe('ALMACEN');
    expect(P.normalizarNombre('María-José  López')).toBe('MARIA JOSE LOPEZ');
  });

  describe('resolverFicha', () => {
    const mp = P.prepararMapeo(MAPEO);
    it('departamento mapeado → su código y su puesto por defecto', () => {
      const r = P.resolverFicha({ sitio: 'sucursal-ph', departamento: 'Cajas' }, mp);
      expect(r).toMatchObject({ warehouse_code: '01', department_code: 'cajas', position_code: 'cajera', promotora: false, validado: false });
      expect(r.avisos).toEqual([]);
    });
    it('la promotora de marca va a promotoria_marca aunque su texto diga otra cosa', () => {
      const r = P.resolverFicha({ sitio: 'cedis', departamento: 'ALMACEN', es_promotora: true }, mp);
      expect(r).toMatchObject({ department_code: 'promotoria_marca', position_code: null, promotora: true });
    });
    it('«PROMOTORIA MEGA DULCES» es piso, NO promotoría de marca', () => {
      const r = P.resolverFicha({ sitio: 'cedis', departamento: 'PROMOTORIA MEGA DULCES' }, mp);
      expect(r).toMatchObject({ department_code: 'tienda', promotora: false });
    });
    it('sin departamento o con uno desconocido → null y aviso, nunca inventado', () => {
      expect(P.resolverFicha({ sitio: 'cedis', departamento: null }, mp)).toMatchObject({ department_code: null, avisos: ['sin_departamento'] });
      expect(P.resolverFicha({ sitio: 'cedis', departamento: 'ASTRONAUTAS' }, mp)).toMatchObject({ department_code: null, avisos: ['departamento_sin_mapeo'] });
      expect(P.resolverFicha({ sitio: 'otro', departamento: 'CAJAS' }, mp)).toMatchObject({ warehouse_code: null, avisos: ['sitio_sin_mapeo'] });
    });
  });

  describe('decidir', () => {
    it('reusa a la persona ya ligada (idempotente)', () => {
      expect(P.decidir({ ligadas: ['u1'], cuentas: ['u9'], palabras: 3 })).toEqual({ accion: 'reusar', userId: 'u1' });
    });
    it('liga a una cuenta existente SÓLO si es una y el nombre es completo', () => {
      expect(P.decidir({ ligadas: [], cuentas: ['u9'], palabras: 3 })).toEqual({ accion: 'ligar_cuenta', userId: 'u9' });
      expect(P.decidir({ ligadas: [], cuentas: ['u9'], palabras: 2 })).toMatchObject({ accion: 'por_decidir', motivo: 'nombre_corto_coincide_con_una_cuenta' });
      expect(P.decidir({ ligadas: [], cuentas: ['u8', 'u9'], palabras: 4 })).toMatchObject({ accion: 'por_decidir', motivo: 'varias_cuentas_con_el_mismo_nombre' });
    });
    it('un código ligado a dos personas no se resuelve solo', () => {
      expect(P.decidir({ ligadas: ['u1', 'u2'], cuentas: [], palabras: 3 })).toMatchObject({ accion: 'por_decidir' });
    });
    it('sin nada → crear', () => {
      expect(P.decidir({ ligadas: [], cuentas: [], palabras: 1 })).toEqual({ accion: 'crear' });
    });
  });

  it('username estable por ficha', () => {
    expect(P.usernameDe('8-esquinas', '0042')).toBe('mt.8-esquinas.0042');
    expect(P.usernameDe('Corporativo Comida', 'A 7')).toBe('mt.corporativo-comida.a-7');
  });
});
