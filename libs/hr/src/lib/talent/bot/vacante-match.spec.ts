/**
 * `[RH.3.2]` A qué vacante manda cada cosa que escribe un candidato. Los casos son los de `probar-vacantes.js` de Mega
 * Talento, con sus DOS listas: la del 29/07/2026 (con "Auxiliar de Prevención") y la de después, sin ella — el cambio
 * de DATOS que rompió el matcher sin tocar código.
 */
import { resolverVacante, vacantesUnicas } from './vacante-match';

const lista = (nombres: string[]) => nombres.map((name) => ({ name }));

const PUESTOS = lista([
  'Surtidor', 'Aux de chofer', 'Chofer', 'Almacenista', 'Bodeguero', 'Anaquelista', 'Vendedor', 'Cajero(a)',
  'Vendedor de ruta', 'Vendedor promotor', 'Practicante', 'Auxiliar de Prevención',
]);
const PUESTOS_HOY = lista([
  'Cajero(a)', 'Surtidor', 'Aux de chofer', 'Chofer', 'Almacenista', 'Bodeguero', 'Anaquelista', 'Vendedor',
  'Vendedor de ruta', 'Vendedor promotor', 'Practicante', 'Crédito y Cobranza', 'Repartidor',
  'Jefatura de recursos humanos', 'Ventas a detalle',
]);

const CASOS: Array<[string | null, string | null]> = [
  ['Cajero(a)', 'Cajero(a)'], ['cajera', 'Cajero(a)'], ['quiero ser cajera', 'Cajero(a)'], ['bodeguero', 'Bodeguero'],
  ['chofer', 'Chofer'], ['aux de chofer', 'Aux de chofer'], ['auxiliar de chofer', 'Aux de chofer'],
  ['vendedor', 'Vendedor'], ['vendedor de ruta', 'Vendedor de ruta'], ['vendedor promotor', 'Vendedor promotor'],
  ['Auxiliar de Prevención', 'Auxiliar de Prevención'], ['auxiliar de prevencion', 'Auxiliar de Prevención'],
  ['prevencion', 'Auxiliar de Prevención'], ['auxiliar de inventarios', null], ['auxiliar administrativo', null],
  ['auxiliar', null], ['Jefa de Recursos Humanos', null], ['ingeniero de sistemas', null], ['', null], [null, null],
  ['becario', 'Practicante'], ['servicio social', 'Practicante'],
];
const CASOS_HOY: Array<[string, string | null]> = [
  ['cajera', 'Cajero(a)'], ['aux de chofer', 'Aux de chofer'], ['auxiliar de chofer', 'Aux de chofer'], ['chofer', 'Chofer'],
  ['crédito y cobranza', 'Crédito y Cobranza'], ['Jefatura de recursos humanos', 'Jefatura de recursos humanos'],
  ['Jefe de RH', 'Jefatura de recursos humanos'], ['jefa de recursos humanos', 'Jefatura de recursos humanos'],
  ['recursos humanos', 'Jefatura de recursos humanos'],
  ['jefa de cedis y logística', null],
  ['Me interesa la vacante de supervisora operativo de Telemarketing o la de jefa de cedis y logística', null],
  ['gerente de tienda', null],
  ['Auxiliar de Prevención', null], ['auxiliar de prevencion', null], ['Auxiliar Multifuncional', null],
  ['auxiliar de inventarios', null], ['auxiliar administrativo', null], ['ayudante general', null],
  ['personal administrativo', null],
];

describe('[RH.3.2] resolverVacante', () => {
  it.each(CASOS)('lista del 29/07: «%s» → %s', (texto, esperado) => {
    expect(resolverVacante(texto, PUESTOS)?.name ?? null).toBe(esperado);
  });
  it.each(CASOS_HOY)('⭐ lista de hoy (sin Prevención): «%s» → %s', (texto, esperado) => {
    expect(resolverVacante(texto, PUESTOS_HOY)?.name ?? null).toBe(esperado);
  });
  it('sin vacantes no inventa ni truena', () => {
    expect(resolverVacante('cajera', [])).toBeNull();
  });
  it('vacantesUnicas quita los nombres repetidos (normalizados)', () => {
    expect(vacantesUnicas(lista(['Cajero(a)', 'cajero (a)', 'Chofer'])).map((v) => v.name)).toEqual(['Cajero(a)', 'Chofer']);
  });
});
