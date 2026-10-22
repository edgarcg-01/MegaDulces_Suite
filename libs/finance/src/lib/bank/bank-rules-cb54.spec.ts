import { createRequire } from 'node:module';
import { join } from 'node:path';
import { compileRules, classifyWith, type ClassifyRuleRow } from './finance-bank.service';

/**
 * `[CB.54]` — Los egresos que el motor dejaba sin categoría: texto en la columna de código, nómina/traslado/SUA
 * con un código distinto, y la línea de crédito revolvente. Las reglas son LAS DE LA MIGRACIÓN (se importan de
 * ahí, no se copian), y el tramo de abajo es el catálogo real de prod que compite con ellas.
 *
 * ⚠️ El riesgo que cuida esto es el falso POSITIVO: un «Comision» de BANORTE (~$77, comisión bancaria) no puede
 * caer en `comisiones_venta` (la regla 164, de Caja General), y una comisión a vendedores de la caja tiene que
 * seguir donde está.
 */
const req = createRequire(__filename);
const MIG = req(join(__dirname, '../../../../../database/migrations-newdb/20261022125305_bank_rules_texto_en_codigo_y_612_613.js')) as {
  REGLAS: (ClassifyRuleRow & { note: string })[];
  clasificar: (reglas: ClassifyRuleRow[], M: unknown, C: unknown, concepto: unknown) => string;
};

/** El tramo real del catálogo de prod que compite por estos conceptos. */
const PROD: ClassifyRuleRow[] = [
  { priority: 82, match_type: null, match_code: '^-$', match_concept: null, category_code: 'traspaso_entre_cuentas' },
  { priority: 144, match_type: null, match_code: '^612$', match_concept: 'PAN AMERICANO|TRASLADO|VALORES', category_code: 'traslado_valores' },
  { priority: 151, match_type: null, match_code: '^613$', match_concept: 'NOMINA|NÓMINA|\\bNOM\\b', category_code: 'nomina' },
  { priority: 164, match_type: null, match_code: null, match_concept: 'COMISION|COMISIÓN|COMISIONES', category_code: 'comisiones_venta' },
];
const CATALOGO = [...PROD, ...MIG.REGLAS];
const comp = compileRules(CATALOGO);
const cls = (M: string | null, C: string | null, x: string | null): string => classifyWith(comp, M, C, x);

describe('[CB.54] egresos que se quedaban sin categoría', () => {
  it('texto en la columna de código (BANORTE): comisión BANCARIA, nómina, capital, seguros', () => {
    expect(cls('G', 'Comision', null)).toBe('comision_bancaria');
    expect(cls('G', 'Nomina 06', null)).toBe('nomina');
    expect(cls('G', 'Nom 08', null)).toBe('nomina');
    expect(cls('G', 'PAGO DE CAPITAL 089386050', null)).toBe('pago_credito');
    expect(cls('G', 'Seguros Banorte', null)).toBe('gasto_admin');
  });
  it('⛔ la comisión a vendedores de la caja sigue en comisiones_venta (la 164 gana: va antes)', () => {
    expect(cls('G', '613', 'COMISION VENDEDORES RUTA 5')).toBe('comisiones_venta');
  });
  it('nómina, traslado de valores y SUA con un código que su regla no esperaba', () => {
    expect(cls('G', null, 'nomina 18')).toBe('nomina');
    expect(cls('G', '613', 'Servicio Panamericano de Proteccion')).toBe('traslado_valores');
    expect(cls('G', '613', 'Armostong Armored')).toBe('traslado_valores');
    expect(cls('G', null, 'SUA')).toBe('imss_sua');
  });
  it('la línea de crédito revolvente va a traspaso, como los que ya estaban categorizados', () => {
    expect(cls('LC', '/', 'CREDITO LIQUIDO DISP./9698193122 COBRO DEL PERIODO TASA 12.5132')).toBe('traspaso_entre_cuentas');
    expect(cls('PLEM', null, 'PREPAGO LEM Retiro de Recursos por (1,013,871.66) mxn')).toBe('traspaso_entre_cuentas');
    expect(cls('LC', '-', 'CREDITO LIQUIDO DISP./9688746229 COBRO DEL PERIODO')).toBe('traspaso_entre_cuentas');
  });
  it('⛔ lo que estas reglas NO resuelven se declara: el beneficiario con nombre propio sigue sin categoría', () => {
    expect(cls('G', '613', 'Oscar Hernandez')).toBe('sin_clasificar');
    expect(cls('G', '613', 'Valentin Oyanguren')).toBe('sin_clasificar');
  });
  it('⛔ «NOMINAL» no es nómina; lo que empieza con COMISI en el código sí es el cargo de comisión del banco', () => {
    expect(cls('G', 'Comisionista Perez', null)).toBe('comision_bancaria'); // ^COMISI en el CÓDIGO: es el texto del banco
    expect(cls('G', 'NOMINAL 5', null)).not.toBe('nomina');
  });
  it('la función de la migración y el motor del servicio dan lo mismo', () => {
    const casos: [string | null, string | null, string | null][] = [
      ['G', 'Comision', null], ['G', '613', 'COMISION VENDEDORES'], ['LC', '/', 'CREDITO LIQUIDO'], ['G', '613', 'Oscar Hernandez'],
      ['G', null, 'nomina 18'], ['G', 'NOMINAL 5', null], [null, null, null], ['TL', '', 'TRASPASO LEM'],
    ];
    for (const [M, C, x] of casos) expect(MIG.clasificar(CATALOGO, M, C, x)).toBe(cls(M, C, x));
  });
});
