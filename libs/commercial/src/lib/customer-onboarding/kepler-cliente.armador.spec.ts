import type { SolicitudAlta, UsoCfdiOpcion } from '@megadulces/contracts';
import { fichaVacia } from './ficha-kepler';
import {
  armarClienteKepler,
  columnasDelPlan,
  enSerie,
  llevaCredito,
  planConClave,
  serieDe,
  siguienteClave,
  textoKepler,
  type EntradaClienteKepler,
} from './kepler-cliente.armador';

/**
 * `[ALC.1.6]` El armador del alta en Kepler. El caso base reproduce, con datos FICTICIOS, la forma
 * exacta de la ficha 21054 que Kepler escribió el 2026-11-07 (contado, Morelia, venta de piso de
 * Morelia Abastos): misma columna vacía, mismo `0.00`, mismo `0.0000`. Los datos reales del
 * cliente no van al repo (es público); la comparación contra la fila real se corrió fuera.
 */

const USOS: UsoCfdiOpcion[] = [
  { clave: 'G01', descripcion: 'Adquisición de mercancías.', regimenes: ['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626'] },
  { clave: 'G03', descripcion: 'Gastos en general.', regimenes: ['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626'] },
  { clave: 'S01', descripcion: 'Sin efectos fiscales.', regimenes: ['601', '603', '605', '606', '612', '616', '621', '625', '626'] },
];
const FORMAS = ['01', '03', '04', '28', '99'];

type Sol = EntradaClienteKepler['solicitud'];
function solicitud(over: Partial<Sol> = {}): Sol {
  return {
    rfc: 'PEPJ800101AB1', curp: null, tipo_persona: 'fisica', nombre_fiscal: 'JUANA PEREZ PEREZ',
    regimen_fiscal: '612', codigo_postal_fiscal: '58260', uso_cfdi: 'G01', forma_pago: '28',
    ficha: {
      ...fichaVacia(), nombre: 'JUANA PEREZ PEREZ', direccion_1: 'BLVD SIN NOMBRE 100 15', direccion_2: 'CENTRO MORELIA',
      estado: 'MICHOACAN', codigo_postal: '58260', rfc: 'PEPJ800101AB1',
    },
    vendedor_code: '20002', grupo_code: '2VP01', zona_code: '20000', credito: null,
    ...over,
  };
}
const entrada = (over: Partial<Sol> = {}, estadoDelCp: string | null = 'MICHOACAN'): EntradaClienteKepler =>
  ({ solicitud: solicitud(over), estadoDelCp, usos: USOS, formasPago: FORMAS });
const aprobado = (credito_aprobado: number, plazo_aprobado: number, descuento_aprobado = 0): SolicitudAlta['credito'] => ({
  decision: 'aprobado', por: 'u', por_nombre: null, el: '2026-11-07', motivo: 'ok', credito_aprobado, plazo_aprobado, descuento_aprobado,
});
const bloqueos = (a: ReturnType<typeof armarClienteKepler>) => a.hallazgos.filter((x) => x.gravedad === 'bloquea').map((x) => x.campo);

describe('[ALC.1.6] la clave: serie por zona y por crédito', () => {
  it('contado 1xxxx/2xxxx/3xxxx y crédito CR1###/CR2###/CR3### (Francisco: CR1001); otra zona no es de clientes', () => {
    expect(serieDe('20000', false)?.patron).toBe('2####');
    expect(serieDe('10000', true)?.patron).toBe('CR1###');
    expect(serieDe('02', false)).toBeNull();
    expect(serieDe('', true)).toBeNull();
  });

  it('el siguiente consecutivo ignora lo que no es de la serie (6 dígitos, O, TI, otra zona)', () => {
    const existentes = ['21053', ' 21054 ', '2105', '210540', 'C2120', 'CR2017', 'TI009', '30232', 'CR002'];
    expect(siguienteClave(serieDe('20000', false)!, existentes)).toEqual({ ok: true, clave: '21055' });
    expect(siguienteClave(serieDe('30000', true)!, existentes)).toEqual({ ok: true, clave: 'CR3001' });
    expect(siguienteClave(serieDe('10000', false)!, [])).toEqual({ ok: true, clave: '10001' });
    expect(siguienteClave(serieDe('10000', true)!, [])).toEqual({ ok: true, clave: 'CR1001' });
  });

  it('crédito: el consecutivo cuenta las C viejas y las CR (C1120 y CR1066 → CR1121); la clave nueva es CR', () => {
    expect(siguienteClave(serieDe('10000', true)!, ['C1120', 'CR1066', 'C1119'])).toEqual({ ok: true, clave: 'CR1121' });
    expect(siguienteClave(serieDe('20000', true)!, ['C2120', 'CR2017'])).toEqual({ ok: true, clave: 'CR2121' });
    expect(siguienteClave(serieDe('30000', true)!, ['CR3105', 'C3111'])).toEqual({ ok: true, clave: 'CR3112' });
    expect(enSerie(serieDe('10000', true)!, 'CR1121')).toBe(true);
    expect(enSerie(serieDe('10000', true)!, 'C1121'), 'una clave nueva de crédito no es C').toBe(false);
  });

  it('NEGATIVA: contar sólo las CR repetiría el número de otro cliente (CR1067 con C1067 ya ocupada)', () => {
    const s = serieDe('10000', true)!;
    const soloCR = { ...s, cuenta: s.regex };
    expect(siguienteClave(soloCR, ['C1120', 'CR1066'])).toEqual({ ok: true, clave: 'CR1067' });
    expect(siguienteClave(s, ['C1120', 'CR1066'])).not.toEqual({ ok: true, clave: 'CR1067' });
  });

  it('NEGATIVA: la serie llena no se desborda a la de otra zona', () => {
    const r = siguienteClave(serieDe('20000', false)!, ['29999']);
    expect(r.ok).toBe(false);
    expect(enSerie(serieDe('20000', false)!, '30000')).toBe(false);
  });

  it('crédito es lo APROBADO con límite o plazo; un descuento solo sigue de contado', () => {
    expect(llevaCredito({ credito: aprobado(15000, 15) })).toBe(true);
    expect(llevaCredito({ credito: aprobado(0, 15) })).toBe(true);
    expect(llevaCredito({ credito: aprobado(0, 0, 3) })).toBe(false);
    expect(llevaCredito({ credito: { ...aprobado(15000, 15)!, decision: 'rechazado' } })).toBe(false);
    expect(llevaCredito({ credito: null })).toBe(false);
  });
});

describe('[ALC.1.6] el texto como lo escribe Kepler', () => {
  it('mayúsculas, sin acentos, con Ñ, sin control ni comillas', () => {
    expect(textoKepler('Michoacán\r')).toBe('MICHOACAN');
    expect(textoKepler('peña  ñandú')).toBe('PEÑA ÑANDU');
    expect(textoKepler("O'Higgins \"el bueno\"")).toBe('OHIGGINS EL BUENO');
    expect(textoKepler('José Nuñez')).toBe('JOSE NUÑEZ');
    expect(textoKepler(null)).toBe('');
  });
});

describe('[ALC.1.6] el plan: la forma de la ficha 21054', () => {
  it('contado en Morelia: las 30 columnas de kdud y las 19 de kdfedir', () => {
    const a = armarClienteKepler(entrada());
    expect(bloqueos(a)).toEqual([]);
    expect(a.serie?.patron).toBe('2####');
    const p = planConClave(a.plan, '21055');
    expect(p.kdud).toEqual({
      c1: '', c2: '21055', c3: 'JUANA PEREZ PEREZ', c4: 'BLVD SIN NOMBRE 100 15', c5: 'CENTRO MORELIA', c6: 'MICHOACAN',
      c7: '', c8: '', c9: '', c10: 'PEPJ800101AB1', c11: '', c12: '20002', c13: '2VP01', c14: '20000',
      c15: '0.00', c16: 0, c17: '', c18: '', c19: '', c20: '', c21: '', c22: '', c23: '', c24: '', c25: '', c26: '',
      c27: '58260', c28: '0.0000', c29: '0.0000', c30: '',
    });
    expect(Object.keys(p.kdud)).toHaveLength(30);
    expect(p.kdfedir).toEqual({
      c1: 3, c2: '21055', c3: '1', c4: '', c5: '', c6: '', c7: '', c8: '', c9: '', c10: '', c11: '', c12: '',
      c13: '', c14: '28', c15: '', c16: 'G01', c17: 0, c18: '612', c19: '',
    });
    expect(Object.keys(p.kdfedir)).toHaveLength(19);
  });

  it('CP y nombre fiscal: vacíos si son los de la ficha (como 21054); escritos si difieren', () => {
    const a = armarClienteKepler(entrada({
      nombre_fiscal: 'Juana Pérez Pérez', codigo_postal_fiscal: '58000',
      ficha: { ...solicitud().ficha, nombre: 'ABARROTES LA JUANITA' },
    }));
    expect(a.plan.kdfedir).toMatchObject({ c13: '58000', c19: 'JUANA PEREZ PEREZ' });
    expect(a.plan.kdud).toMatchObject({ c3: 'ABARROTES LA JUANITA', c27: '58260' });
  });

  it('crédito aprobado: límite, plazo y descuento; sin forma elegida va la 99 y se dice', () => {
    const a = armarClienteKepler(entrada({ credito: aprobado(15000, 15, 2.5), forma_pago: null }));
    expect(a.serie?.patron).toBe('CR2###');
    expect(a.plan.kdud).toMatchObject({ c15: '15000.00', c16: 15, c17: '2.5' });
    expect(a.plan.kdfedir['c14']).toBe('99');
    expect(a.hallazgos.find((x) => x.campo === 'forma_pago')?.gravedad).toBe('aviso');
  });

  it('sin RFC (genérico): uso S01 por costumbre, sin CURP', () => {
    const a = armarClienteKepler(entrada({ rfc: 'XAXX010101000', regimen_fiscal: '616', uso_cfdi: null, curp: 'PEPJ800101MMNRRN09', forma_pago: '01' }));
    expect(bloqueos(a)).toEqual([]);
    expect(a.plan.kdfedir['c16']).toBe('S01');
    expect(a.plan.kdud['c30']).toBe('');
  });

  it('el estado sale del CP: un «MICHOCAN» tecleado se corrige y se avisa', () => {
    const a = armarClienteKepler(entrada({ ficha: { ...solicitud().ficha, estado: 'Michocan' } }));
    expect(a.plan.kdud['c6']).toBe('MICHOACAN');
    expect(a.hallazgos.find((x) => x.campo === 'ficha.estado')?.mensaje).toContain('MICHOCAN');
  });

  it('teléfonos sólo con dígitos; uno que no tiene 10 se avisa', () => {
    const a = armarClienteKepler(entrada({ ficha: { ...solicitud().ficha, telefono_1: '(443) 123-4567', telefono_2: '12345' } }));
    expect(a.plan.kdud).toMatchObject({ c7: '4431234567', c8: '12345' });
    expect(a.hallazgos.filter((x) => x.campo.startsWith('ficha.telefono')).map((x) => x.campo)).toEqual(['ficha.telefono_2']);
  });

  it('columnasDelPlan: lo que se ve en las pantallas de Kepler, con su rótulo', () => {
    const c = columnasDelPlan(planConClave(armarClienteKepler(entrada()).plan, '21055'));
    expect(c.kdud[0]).toEqual({ columna: 'c2', rotulo: 'Clave', valor: '21055' });
    expect(c.kdfedir.map((x) => x.columna)).toEqual(['c18', 'c16', 'c14', 'c13', 'c19']);
  });
});

describe('[ALC.1.6] NEGATIVAS: lo que no se escribe', () => {
  it('grupo de otra zona bloquea; vendedor de otra zona sólo avisa (hay 3 fichas así en Kepler)', () => {
    const a = armarClienteKepler(entrada({ grupo_code: '1VP01', vendedor_code: '30003' }));
    expect(bloqueos(a)).toEqual(['grupo_code']);
    expect(a.hallazgos.find((x) => x.campo === 'vendedor_code')?.gravedad).toBe('aviso');
  });

  it('zona que no es de clientes (01, 02, 03) o vacía bloquea', () => {
    expect(bloqueos(armarClienteKepler(entrada({ zona_code: '02' })))).toContain('zona_code');
    expect(bloqueos(armarClienteKepler(entrada({ zona_code: null })))).toContain('zona_code');
  });

  it('lo que no cabe bloquea y NO se recorta', () => {
    const largo = 'AV. ' + 'X'.repeat(37);
    const a = armarClienteKepler(entrada({ ficha: { ...solicitud().ficha, direccion_1: largo } }));
    expect(bloqueos(a)).toEqual(['ficha.direccion_1']);
    expect(a.plan.kdud['c4']).toBe(largo);
  });

  it('uso de CFDI que el SAT no admite con el régimen, o fuera de catálogo, bloquea', () => {
    expect(bloqueos(armarClienteKepler(entrada({ regimen_fiscal: '616', uso_cfdi: 'G01' })))).toEqual(['uso_cfdi']);
    expect(bloqueos(armarClienteKepler(entrada({ uso_cfdi: 'P01' })))).toEqual(['uso_cfdi']);
    expect(bloqueos(armarClienteKepler(entrada({ forma_pago: '07' })))).toEqual(['forma_pago']);
  });
});
