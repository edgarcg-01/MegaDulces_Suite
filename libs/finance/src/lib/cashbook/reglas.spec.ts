import { DineroInvalido, valorDePiezas, type AsientoPropuesto, type CuentaPropuesta, type PiezasTexto } from '@megadulces/contracts';
import { identidadDeCaos, llaveDePiezaCaos, piezasQueEntranALaMaquina, type MovimientoCaos } from './identidad';
import {
  CUENTAS_FIJAS, ReglaInvalida, apertura, chequeDepositado, chequeDevuelto, chequeRecibido, clasificarSuspenso, cobranzaRuta,
  cobroEnDolares, depositoEnBanco, entregaRuta, esSinRegla, faltante, gasto, movimientoCaos, otroIngreso, pagoDelCajon, regresoCustodiaAlCajon,
  cambioDeMonedas, aCustodiaDesdeCajon,
  sobrante, type Contexto, type Propuesta, type ResultadoRegla,
} from './reglas';

/**
 * `[LE.2.3]` `[LE.2.7]` — Las reglas de registro: un asiento correcto por hecho, los rechazos con
 * el mismo nombre que la base, y una prueba por PROPIEDADES con un verificador escrito aparte de
 * `armar()` (dos implementaciones de «cuadra», cruzadas).
 */
const CAJERA: Contexto = { actor: { kind: 'persona', user_id: 'u-cajera', employee_id: 'e-cajera' }, valueAt: '2026-10-27T12:00:00-06:00' };
const FEED: Contexto = { actor: { kind: 'servicio', service: 'feed-caos' }, valueAt: '2026-10-27T12:00:00-06:00' };

function propuesta(r: ResultadoRegla): Propuesta {
  if (esSinRegla(r)) throw new Error(`se esperaba asiento y vino sin regla: ${r.motivo}`);
  return r;
}
const linea = (p: Propuesta, code: string, n = 0) => p.asiento.lines.filter((l) => l.account === code)[n];

/** El verificador INDEPENDIENTE de `armar()`: lo que la base exigirá, recalculado desde cero. */
function verificar(p: Propuesta): void {
  const cuentas = new Map<string, CuentaPropuesta>(p.cuentas.map((c) => [c.code, c]));
  const porMoneda: Record<string, bigint> = {};
  const piezas: Record<string, bigint> = {};
  expect(p.asiento.lines.length).toBeGreaterThanOrEqual(2);
  for (const l of p.asiento.lines) {
    const c = cuentas.get(l.account);
    expect(c, `la cuenta ${l.account} viaja en «cuentas»`).toBeDefined();
    if (!c) return;
    const monto = BigInt(l.amount_minor);
    expect(monto).not.toBe(0n);
    porMoneda[c.currency] = (porMoneda[c.currency] ?? 0n) + monto;
    if (c.tracks_pieces) {
      expect(l.pieces && Object.keys(l.pieces).length > 0).toBe(true);
      const n = Object.fromEntries(Object.entries(l.pieces ?? {}).map(([k, v]) => [k, Number(v)]));
      expect(valorDePiezas(n, c.currency)).toBe(monto);
      for (const [k, v] of Object.entries(l.pieces ?? {})) piezas[`${c.currency}|${k}`] = (piezas[`${c.currency}|${k}`] ?? 0n) + BigInt(v);
    } else {
      expect(l.pieces).toBeUndefined();
    }
    expect(l.account).toMatch(/^[A-Z][A-Z0-9_:.-]*$/);
  }
  for (const s of Object.values(porMoneda)) expect(s).toBe(0n);
  if (p.asiento.lines.every((l) => cuentas.get(l.account)?.tracks_pieces)) for (const s of Object.values(piezas)) expect(s).toBe(0n);
  expect(p.asiento.rule_version).toMatch(/^le2-/);
}

const mov = (o: Partial<MovimientoCaos> & Pick<MovimientoCaos, 'type_id' | 'type_label' | 'total' | 'piezas'>): MovimientoCaos => ({
  device: 'AST700-19758', external_id: 1723, occurred_at: '2026-10-26T18:00:00-06:00', ref: null, user_external: 'Vendedor (006) - VENTAS', ...o,
});
const B = (denom: number, quantity: number) => ({ denom: String(denom), pieza_tipo: 'B', quantity: String(quantity) });

describe('[LE.2.4] identidad de los hechos de la máquina', () => {
  it('llaves del catálogo: billetes a secas, la moneda de $20 con «m»; un tipo desconocido revienta', () => {
    expect(llaveDePiezaCaos('500.00', 'B')).toBe('500');
    expect(llaveDePiezaCaos('-20.00', 'B')).toBe('20');
    expect(llaveDePiezaCaos('20', 'M')).toBe('20m');
    expect(llaveDePiezaCaos('0.50', 'M')).toBe('0.5');
    expect(() => llaveDePiezaCaos('500', 'X')).toThrow();
  });

  it('la huella no depende del orden de las piezas, pero sí de su contenido', () => {
    const a = mov({ type_id: 0, type_label: 'Deposito', total: '600.00', piezas: [B(500, 1), B(100, 1)] });
    const b = mov({ type_id: 0, type_label: 'Deposito', total: '600.00', piezas: [B(100, 1), B(500, 1)] });
    const c = mov({ type_id: 0, type_label: 'Deposito', total: '600.00', piezas: [B(200, 3)] });
    expect(identidadDeCaos(a)).toEqual(identidadDeCaos(b));
    expect(identidadDeCaos(a).event_hash).not.toBe(identidadDeCaos(c).event_hash);
    expect(identidadDeCaos(a).event_ref).toBe('caos:AST700-19758:1723');
  });

  it('dirección: depósito y dotar entran, dispensar y vaciar salen; fin de día y contenido modificado no mueven', () => {
    const p = [B(500, 2)];
    expect(piezasQueEntranALaMaquina(mov({ type_id: 0, type_label: 'Deposito', total: '1000', piezas: p }))).toEqual({ 500: '2' });
    expect(piezasQueEntranALaMaquina(mov({ type_id: 8, type_label: 'Dotar', total: '1000', piezas: p }))).toEqual({ 500: '2' });
    expect(piezasQueEntranALaMaquina(mov({ type_id: 4, type_label: 'Dispensar', total: '1000', piezas: p }))).toEqual({ 500: '-2' });
    expect(piezasQueEntranALaMaquina(mov({ type_id: 5, type_label: 'Vaciar Stocks', total: '1000', piezas: p }))).toEqual({ 500: '-2' });
    expect(piezasQueEntranALaMaquina(mov({ type_id: 2, type_label: 'Fin de Dia', total: '1000', piezas: p }))).toBeNull();
    expect(piezasQueEntranALaMaquina(mov({ type_id: 13, type_label: 'Contenido Modificado', total: '-25420', piezas: [] }))).toBeNull();
  });
});

describe('[LE.2.3] reglas: lo que hace la máquina', () => {
  it('E-02 · el caso del PM: «ruta 27 261026» abona a la ruta 27 con cada billete', () => {
    const p = propuesta(movimientoCaos(mov({ type_id: 0, type_label: 'Deposito', total: '19000.00', ref: 'ruta 27 261026',
      piezas: [B(500, 30), B(200, 20)] }), FEED));
    verificar(p);
    expect(p.asiento.event_kind).toBe('deposito_caos');
    expect(linea(p, 'BOVEDA_CAOS')).toEqual({ account: 'BOVEDA_CAOS', amount_minor: '1900000', pieces: { 200: '20', 500: '30' } });
    expect(linea(p, 'POR_RENDIR:RUTA:27').amount_minor).toBe('-1900000');
    expect(p.asiento.event_ref).toBe('caos:AST700-19758:1723');
    expect(p.asiento.meta?.grano).toBe('ruta_dia');
  });

  it('E-02 · sin ruta declarada NO se reparte por antigüedad: va a Suspenso, con el porqué (B19)', () => {
    const p = propuesta(movimientoCaos(mov({ type_id: 0, type_label: 'Deposito', total: '500.00', ref: 'pagos gdl', piezas: [B(500, 1)] }), FEED));
    verificar(p);
    expect(linea(p, 'SUSPENSO_MXN').amount_minor).toBe('-50000');
    expect(p.asiento.meta?.grano).toBe('sin_declarar');
  });

  it('E-02 · D15: la plaza sin ruta abona a la PLAZA, sin inventarse una ruta ni pasar por Suspenso', () => {
    const p = propuesta(movimientoCaos(mov({ type_id: 0, type_label: 'Deposito', total: '500.00', ref: 'rd can', piezas: [B(500, 1)] }), FEED));
    verificar(p);
    expect(linea(p, 'POR_RENDIR:PLAZA:CANINDO').amount_minor).toBe('-50000');
    expect(linea(p, 'SUSPENSO_MXN')).toBeUndefined();
    expect(p.asiento.lines.some((l) => l.account.startsWith('POR_RENDIR:RUTA:'))).toBe(false);
    expect(p.asiento.meta?.grano).toBe('plaza');
    const mor = propuesta(movimientoCaos(mov({ type_id: 0, type_label: 'Deposito', total: '200.00', ref: 'rd morelia', piezas: [B(200, 1)] }), FEED));
    expect(linea(mor, 'POR_RENDIR:PLAZA:MORELIA').amount_minor).toBe('-20000');
  });

  it('E-02 · la vecinal declara su dueño: su propia cuenta por rendir', () => {
    const p = propuesta(movimientoCaos(mov({ type_id: 0, type_label: 'Deposito', total: '500.00', ref: 'rv1 251026', piezas: [B(500, 1)] }), FEED));
    expect(linea(p, 'POR_RENDIR:VECINAL').amount_minor).toBe('-50000');
  });

  it('E-07/E-08 · un retiro sin clasificar deja la bóveda igual a la máquina y el dinero en Suspenso', () => {
    const m = mov({ type_id: 4, type_label: 'Dispensar', total: '25000.00', ref: 'retiro', piezas: [B(500, 50)] });
    const sin = propuesta(movimientoCaos(m, FEED));
    verificar(sin);
    expect(linea(sin, 'BOVEDA_CAOS')).toEqual({ account: 'BOVEDA_CAOS', amount_minor: '-2500000', pieces: { 500: '-50' } });
    expect(linea(sin, 'SUSPENSO_MXN').amount_minor).toBe('2500000');
    const cajon = propuesta(movimientoCaos(m, CAJERA, { tipo: 'cajon' }));
    verificar(cajon);
    expect(linea(cajon, 'CAJA_MXN')).toEqual({ account: 'CAJA_MXN', amount_minor: '2500000', pieces: { 500: '50' } });
    const cust = propuesta(movimientoCaos(m, CAJERA, { tipo: 'custodia', empleado: 'e-luis', nombre: 'Luis' }));
    verificar(cust);
    expect(cust.asiento.event_kind).toBe('retiro_a_custodia');
    expect(linea(cust, 'CUSTODIA:E-LUIS').amount_minor).toBe('2500000');
  });

  it('`[LE.2.9]` un retiro con el código de un PAGO es el gasto de su documento: bóveda → egreso, sin pasar por el cajón', () => {
    const m = mov({ type_id: 4, type_label: 'Dispensar', total: '780.00', ref: 'JAQD-8 nomina cedis', piezas: [B(500, 1), B(200, 1), B(50, 1), B(20, 1), B(10, 1)] });
    const pago = propuesta(movimientoCaos(m, FEED, { tipo: 'pago', concepto: 'NOMINA CEDIS', documento: '00|X-D-26|0023782|0011' }));
    verificar(pago);
    expect(pago.asiento.event_kind).toBe('gasto');
    expect(linea(pago, 'BOVEDA_CAOS').amount_minor).toBe('-78000');
    expect(linea(pago, 'EGRESO:NOMINA_CEDIS').amount_minor).toBe('78000');
    expect(pago.asiento.meta?.['documento']).toBe('00|X-D-26|0023782|0011');
    expect(pago.asiento.lines.some((l) => l.account === 'CAJA_MXN' || l.account === 'SUSPENSO_MXN')).toBe(false);   // NEGATIVA: ni cajón ni Suspenso
  });

  it('E-15 · «Vaciar Stocks» cuyo total no coincide con su desglose NO se asienta: es un hallazgo (el #1478)', () => {
    const r = movimientoCaos(mov({ type_id: 5, type_label: 'Vaciar Stocks', total: '20.00', piezas: [B(500, 172), B(20, 11)] }), FEED);
    expect(esSinRegla(r)).toBe(true);
    if (esSinRegla(r)) expect(r.motivo).toMatch(/no coincide con su desglose/);
  });

  it('E-14/E-15 · Dotar y Vaciar: sin confirmar origen/destino van contra Suspenso (LE.0.2); vaciar al banco va a tránsito', () => {
    const dotar = propuesta(movimientoCaos(mov({ type_id: 8, type_label: 'Dotar', total: '1000.00', piezas: [B(500, 2)] }), FEED));
    verificar(dotar);
    expect(linea(dotar, 'SUSPENSO_MXN').amount_minor).toBe('-100000');
    expect(dotar.asiento.meta?.motivo).toMatch(/LE\.0\.2/);
    const banco = propuesta(movimientoCaos(mov({ type_id: 5, type_label: 'Vaciar Stocks', total: '1000.00', piezas: [B(500, 2)] }), CAJERA, { tipo: 'banco' }));
    verificar(banco);
    expect(banco.asiento.event_kind).toBe('envio_a_banco');
    expect(linea(banco, 'TRANSITO_BANCO').amount_minor).toBe('100000');
  });

  it('sin regla: Fin de Día (es una lectura, no un movimiento) y Contenido Modificado; el Cambio se asienta siempre (dirección probada en LE.3.4)', () => {
    expect(esSinRegla(movimientoCaos(mov({ type_id: 2, type_label: 'Fin de Dia', total: '279110', piezas: [B(500, 292)] }), FEED))).toBe(true);
    expect(esSinRegla(movimientoCaos(mov({ type_id: 13, type_label: 'Contenido Modificado', total: '-25420', piezas: [] }), FEED))).toBe(true);
    const cambio = mov({ type_id: 7, type_label: 'Cambio', total: '0', piezas: [B(500, 2), B(-100, 10)] });
    const sinQuien = propuesta(movimientoCaos(cambio, FEED));
    verificar(sinQuien);
    expect(sinQuien.asiento.lines.filter((l) => l.account === 'SUSPENSO_MXN')).toHaveLength(2);
    const ok = propuesta(movimientoCaos(cambio, CAJERA, { tipo: 'cajon' }));
    verificar(ok);
    expect(ok.asiento.lines).toHaveLength(4);
  });
});

describe('[LE.2.3] reglas: lo que registra una persona', () => {
  it('E-01 + E-04 · Kepler cobra 21 mil, la ruta entrega 2 mil al cajón por pieza', () => {
    const k = cobranzaRuta({ ruta: '027', origenRef: '01-005|U-A-5|0000024|0011', monto: '2100000', fecha: '2026-10-26' },
      { actor: { kind: 'servicio', service: 'feed-kepler' }, valueAt: CAJERA.valueAt });
    verificar(k);
    expect(linea(k, 'POR_RENDIR:RUTA:27').amount_minor).toBe('2100000');
    expect(k.asiento.event_ref).toBe('kepler:01-005|U-A-5|0000024|0011');
    const e = entregaRuta({ ruta: '27', piezas: { 1000: '1', 500: '2' } }, CAJERA);
    verificar(e);
    expect(linea(e, 'POR_RENDIR:RUTA:27').amount_minor).toBe('-200000');
  });

  it('E-03 · sacar de Suspenso, en las dos direcciones', () => {
    const retiro = clasificarSuspenso({ eventRefOriginal: 'caos:AST700-19758:1800', monto: '2500000', estaEn: 'debe', hacia: CUENTAS_FIJAS.CAJA_MXN, piezas: { 500: '50' } }, CAJERA);
    verificar(retiro);
    expect(linea(retiro, 'SUSPENSO_MXN').amount_minor).toBe('-2500000');
    expect(retiro.asiento.event_ref).toBe('clasifica:caos:AST700-19758:1800');
    const dotar = clasificarSuspenso({ eventRefOriginal: 'caos:AST700-19758:1801', monto: '100000', estaEn: 'haber', hacia: CUENTAS_FIJAS.CAJA_MXN, piezas: { 500: '2' } }, CAJERA);
    verificar(dotar);
    expect(linea(dotar, 'CAJA_MXN')).toEqual({ account: 'CAJA_MXN', amount_minor: '-100000', pieces: { 500: '-2' } });
  });

  it('E-09/E-10/E-11 · gastos y la custodia que regresa', () => {
    verificar(gasto({ concepto: 'Papelería', desde: { tipo: 'cajon', piezas: { 100: '3', '0.5': '1' } } }, CAJERA));
    const g = gasto({ concepto: 'Combustible ruta', desde: { tipo: 'custodia', empleado: 'e-luis', nombre: 'Luis', monto: '150000' } }, CAJERA);
    verificar(g);
    expect(linea(g, 'EGRESO:COMBUSTIBLE_RUTA').amount_minor).toBe('150000');
    verificar(regresoCustodiaAlCajon({ empleado: 'e-luis', nombre: 'Luis', piezas: { 200: '5' } }, CAJERA));
  });

  it('E-05/E-12/E-20 · faltante y sobrante: siempre a nombre de alguien, con su evento propio', () => {
    const f = faltante({ de: { tipo: 'ruta', ruta: '27', monto: '10000' }, empleado: 'e-vend', nombre: 'Vendedor 27' }, CAJERA);
    verificar(f);
    expect(f.asiento.event_kind).toBe('faltante');
    expect(linea(f, 'FALTANTE:E-VEND').amount_minor).toBe('10000');
    verificar(faltante({ de: { tipo: 'cajon', piezas: { 100: '1' } }, empleado: 'e-cajera', nombre: 'Cajera' }, CAJERA));
    verificar(faltante({ de: { tipo: 'custodia', empleado: 'e-luis', nombre: 'Luis', monto: '500' }, empleado: 'e-luis', nombre: 'Luis' }, CAJERA));
    const s = sobrante({ en: { tipo: 'cajon', piezas: { 20: '1' } }, empleado: 'e-cajera', nombre: 'Cajera' }, CAJERA);
    verificar(s);
    expect(s.asiento.event_kind).toBe('sobrante');
  });

  it('E-21 · cien dólares a 18.25: por los puentes y con el tipo de cambio en el asiento', () => {
    const u = cobroEnDolares({ ruta: '27', piezasUsd: { 100: '1' }, tipoDeCambio: '18.25', fuente: 'DOF 2026-10-27', fijadoPor: 'u-mariaz' }, CAJERA);
    verificar(u);
    expect(linea(u, 'CAJA_USD').amount_minor).toBe('10000');
    expect(linea(u, 'POR_RENDIR:RUTA:27').amount_minor).toBe('-182500');
    expect(u.asiento.meta).toMatchObject({ tipo_de_cambio: '18.25', tc_fuente: 'DOF 2026-10-27', tc_fijado_por: 'u-mariaz' });
  });

  it('E-16/E-22/E-23 · banco, cheques con folio y otros ingresos', () => {
    verificar(depositoEnBanco({ cuentaBanco: 'BBVA 0123', monto: '100000', referencia: 'mov-1' }, CAJERA));
    const ch = chequeRecibido({ ruta: '27', folio: 'CH-77', monto: '350000' }, CAJERA);
    verificar(ch);
    expect(ch.asiento.event_ref).toBe('cheque:CH-77');
    verificar(chequeDepositado({ folio: 'CH-77', monto: '350000' }, CAJERA));
    verificar(chequeDevuelto({ ruta: '27', folio: 'CH-77', monto: '350000', desde: { tipo: 'banco', cuentaBanco: 'BBVA 0123' } }, CAJERA));
    verificar(otroIngreso({ concepto: 'Venta de cartón', piezas: { 50: '2' } }, CAJERA));
  });

  it('E-27 · apertura: una moneda por asiento', () => {
    const a = apertura({ moneda: 'MXN', fecha: '2026-11-02', conteos: [{ cuenta: 'BOVEDA_CAOS', piezas: { 500: '200' } }, { cuenta: 'CAJA_MXN', piezas: { 100: '10' } }] }, CAJERA);
    verificar(a);
    expect(linea(a, 'APERTURA_MXN').amount_minor).toBe('-10100000');
    expect(() => apertura({ moneda: 'MXN', fecha: '2026-11-02', conteos: [{ cuenta: 'CAJA_USD', piezas: { 100: '1' } }] }, CAJERA))
      .toThrow(ReglaInvalida);
  });
});

describe('[LE.2.3] rechazos con el nombre de la base', () => {
  const codigo = (fn: () => unknown): string => { try { fn(); return 'sin error'; } catch (e) { return (e as ReglaInvalida).codigo ?? (e as Error).name; } };
  it.each([
    ['un gasto del cajón sin piezas', () => gasto({ concepto: 'x', desde: { tipo: 'cajon', piezas: {} } }, CAJERA), 'cashbook_cuenta_exige_piezas'],
    ['un monto en cero', () => cobranzaRuta({ ruta: '27', origenRef: 'x', monto: '0', fecha: '2026-10-26' }, FEED), 'cashbook_monto_invalido'],
    ['un monto negativo', () => depositoEnBanco({ cuentaBanco: 'x', monto: '-5', referencia: 'r' }, CAJERA), 'cashbook_monto_invalido'],
    ['piezas que se cancelan (suman cero)', () => entregaRuta({ ruta: '27', piezas: { 500: '1', 100: '-5' } }, CAJERA), 'cashbook_linea_no_cero'],
  ])('NEGATIVA: %s → %s', (_q, fn, esperado) => expect(codigo(fn)).toBe(esperado));

  it('NEGATIVA: un billete fuera del catálogo o en pesos con decimales revienta antes de llegar a la base', () => {
    expect(() => entregaRuta({ ruta: '27', piezas: { 300: '1' } }, CAJERA)).toThrow(DineroInvalido);
    expect(() => cobranzaRuta({ ruta: '27', origenRef: 'x', monto: '21000.50', fecha: '2026-10-26' }, FEED)).toThrow(DineroInvalido);
  });
});

/**
 * `[LE.2.7]` Propiedad: cualquier hecho válido produce un asiento que cuadra. Generador con semilla
 * fija (reproducible: el mismo fallo sale siempre igual), 5,000 hechos de todos los tipos.
 */
describe('[LE.2.7] propiedad: todo asiento cuadra por moneda y conserva cada pieza', () => {
  let semilla = 20261027;
  const azar = (): number => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  const entre = (a: number, b: number): number => a + Math.floor(azar() * (b - a + 1));
  const unoDe = <T>(xs: readonly T[]): T => xs[entre(0, xs.length - 1)];
  const BILLETES = [20, 50, 100, 200, 500] as const;
  const piezasAlAzar = (keys: readonly string[] = ['1000', '500', '200', '100', '50', '20', '20m', '10', '5', '2', '1', '0.5']): PiezasTexto => {
    const p: PiezasTexto = {};
    for (let i = 0, n = entre(1, 4); i < n; i++) p[unoDe(keys)] = String(entre(1, 80));
    return p;
  };
  const piezasCaos = () => Array.from({ length: entre(1, 5) }, () => B(unoDe(BILLETES), entre(1, 120)));
  const totalDe = (ps: ReturnType<typeof piezasCaos>) => (ps.reduce((s, p) => s + Number(p.denom) * Number(p.quantity), 0)).toFixed(2);
  const refs = ['ruta 27 261026', 'rd28', 'r 21 251026', 'pagos gdl', 'rd can', 'rv2 251026', null, 'ruta 501'];

  const generadores: Array<() => ResultadoRegla> = [
    () => { const ps = piezasCaos(); return movimientoCaos(mov({ external_id: entre(1, 1e6), type_id: 0, type_label: 'Deposito', total: totalDe(ps), ref: unoDe(refs), piezas: ps }), FEED); },
    () => { const ps = piezasCaos(); return movimientoCaos(mov({ external_id: entre(1, 1e6), type_id: 4, type_label: 'Dispensar', total: totalDe(ps), piezas: ps }), CAJERA, unoDe([undefined, { tipo: 'cajon' as const }, { tipo: 'custodia' as const, empleado: 'e-1', nombre: 'Uno' }])); },
    () => { const ps = piezasCaos(); return movimientoCaos(mov({ type_id: unoDe([5, 8]), type_label: 'Vaciar/Dotar', total: totalDe(ps), piezas: ps }), CAJERA, unoDe([undefined, { tipo: 'cajon' as const }, { tipo: 'banco' as const }])); },
    () => {
      const entra = B(unoDe(BILLETES), entre(1, 20));
      const sale = B(-unoDe(BILLETES), entre(1, 20));
      return movimientoCaos(mov({ type_id: 7, type_label: 'Cambio', total: '0', piezas: [entra, sale] }), CAJERA, { tipo: 'cajon' });
    },
    () => cobranzaRuta({ ruta: String(entre(1, 40)), origenRef: `d-${entre(1, 1e6)}`, monto: String(entre(1, 9e8)), fecha: '2026-10-26' }, FEED),
    () => entregaRuta({ ruta: String(entre(1, 40)), piezas: piezasAlAzar() }, CAJERA),
    () => gasto({ concepto: unoDe(['Papelería', 'Gasolina', 'Comida']), desde: unoDe([{ tipo: 'cajon' as const, piezas: piezasAlAzar() }, { tipo: 'custodia' as const, empleado: 'e-2', nombre: 'Dos', monto: String(entre(1, 1e7)) }]) }, CAJERA),
    () => faltante({ de: unoDe([{ tipo: 'ruta' as const, ruta: '5', monto: String(entre(1, 1e6)) }, { tipo: 'cajon' as const, piezas: piezasAlAzar() }]), empleado: 'e-3', nombre: 'Tres' }, CAJERA),
    () => sobrante({ en: unoDe([{ tipo: 'ruta' as const, ruta: '5', monto: String(entre(1, 1e6)) }, { tipo: 'cajon' as const, piezas: piezasAlAzar() }]), empleado: 'e-3', nombre: 'Tres' }, CAJERA),
    () => cobroEnDolares({ ruta: '9', piezasUsd: piezasAlAzar(['100', '50', '20', '10', '5', '2', '1']), tipoDeCambio: `${entre(15, 22)}.${String(entre(0, 9999)).padStart(4, '0')}`, fuente: 'DOF', fijadoPor: 'u' }, CAJERA),
    () => clasificarSuspenso({ eventRefOriginal: `caos:x:${entre(1, 1e6)}`, monto: String(entre(1, 1e7)), estaEn: unoDe(['debe', 'haber'] as const), hacia: CUENTAS_FIJAS.TRANSITO_BANCO }, CAJERA),
    () => otroIngreso({ concepto: 'Reembolso', piezas: piezasAlAzar() }, CAJERA),
  ];

  it('5,000 hechos al azar: cero asientos que no cuadren', () => {
    let asientos = 0;
    let saltados = 0;
    for (let i = 0; i < 5000; i++) {
      let r: ResultadoRegla;
      try { r = unoDe(generadores)(); } catch (e) {
        // Piezas al azar que se cancelan a cero son un rechazo legítimo, no un asiento malo.
        expect((e as ReglaInvalida).codigo).toBe('cashbook_linea_no_cero');
        saltados++;
        continue;
      }
      if (esSinRegla(r)) { saltados++; continue; }
      verificar(r);
      asientos++;
    }
    expect(asientos).toBeGreaterThan(4500);
    expect(saltados).toBeLessThan(500);
    // [CI] 2026-10-28: 5,000 asientos son cuenta pura; en el runner del CI pasaba de los 5 s por omisión
    // (falló por tiempo, no por un asiento malo). Se le da su propio límite; no se recortan casos.
  }, 30_000);

  it('MUTACIÓN del verificador: un asiento descuadrado a mano SÍ lo detecta', () => {
    const p = entregaRuta({ ruta: '27', piezas: { 500: '1' } }, CAJERA);
    const roto: Propuesta = { ...p, asiento: { ...p.asiento, lines: p.asiento.lines.map((l, i) => (i === 1 ? { ...l, amount_minor: '-49999' } : l)) } as AsientoPropuesto };
    expect(() => verificar(roto)).toThrow();
  });
});

describe('[LE.2.9] la parte del cajón de un pago, con el redondeo declarado (D26)', () => {
  const base = { concepto: '201', documento: '00|X-D-26|0023782|0011', orden: 'o-1', recibe: 'Nómina CEDIS' };

  it('el testigo de hoy: $796.73 → $16.50 del cajón; el egreso suma el documento EXACTO con la máquina', () => {
    const p = pagoDelCajon({ ...base, piezas: { 10: '1', 5: '1', 1: '1', '0.5': '1' }, redondeo: -23n }, CAJERA);
    expect(p).not.toBeNull();
    if (!p) return;
    verificar(p);
    expect(linea(p, 'CAJA_MXN').amount_minor).toBe('-1650');
    expect(linea(p, 'REDONDEO_MXN').amount_minor).toBe('-23');
    // máquina 78000 (lo asienta el carril) + cajón 1673 = 79673: el importe del X-D-26, al centavo.
    expect(78000n + BigInt(linea(p, 'EGRESO:201').amount_minor)).toBe(79673n);
    expect(p.asiento).toMatchObject({ event_kind: 'gasto', event_ref: 'pago:o-1' });
    expect(p.asiento.meta).toMatchObject({ documento: base.documento, orden: 'o-1', recibe: 'Nómina CEDIS', redondeo: '-23' });
  });

  it('todo de la máquina con redondeo: sólo el redondeo contra el egreso; sin redondeo, nada que asentar', () => {
    const p = pagoDelCajon({ ...base, redondeo: 25n }, CAJERA);
    if (!p) throw new Error('debía asentar el redondeo');
    verificar(p);
    expect(p.asiento.lines.map((l) => [l.account, l.amount_minor])).toEqual([['EGRESO:201', '-25'], ['REDONDEO_MXN', '25']]);
    expect(pagoDelCajon({ ...base, redondeo: 0n }, CAJERA)).toBeNull();
  });

  it('NEGATIVA: el cajón se cuenta por pieza del catálogo; una pieza que no existe no pasa', () => {
    expect(() => pagoDelCajon({ ...base, piezas: { 3: '1' }, redondeo: 0n }, CAJERA)).toThrow(DineroInvalido);
  });
});

describe('[LE.2.11] E-29 · monedas por billetes con alguien de fuera', () => {
  const codigo = (fn: () => unknown): string => { try { fn(); return 'sin error'; } catch (e) { return (e as ReglaInvalida).codigo ?? (e as Error).name; } };
  const esCambio = (code: string) => code.startsWith('CAMBIO_EFECTIVO:');

  it('en el acto y exacto: 1,000 monedas de $10 por 20 billetes de $500; el puente queda en cero', () => {
    const p = cambioDeMonedas({ conQuien: 'Banco', salen: { 10: '1000' }, entran: { 500: '20' } }, CAJERA);
    verificar(p);
    expect(p.asiento.event_kind).toBe('cambio');
    const caja = p.asiento.lines.filter((l) => l.account === 'CAJA_MXN').map((l) => l.amount_minor);
    expect(caja).toEqual(['-1000000', '1000000']);
    const puente = p.asiento.lines.filter((l) => esCambio(l.account)).reduce((t, l) => t + BigInt(l.amount_minor), 0n);
    expect(puente).toBe(0n);
    expect(p.cuentas.find((c) => esCambio(c.code))).toMatchObject({ class: 'puente', tracks_pieces: false });
  });

  it('con comisión: el banco se queda $50 y es un gasto declarado, no un faltante', () => {
    const p = cambioDeMonedas({ conQuien: 'Banco', salen: { 10: '1000' }, entran: { 500: '19', 200: '2', 50: '1' }, comision: '5000' }, CAJERA);
    verificar(p);
    expect(p.asiento.lines.filter((l) => l.account.startsWith('EGRESO:')).map((l) => l.amount_minor)).toEqual(['5000']);
    expect(p.asiento.meta).toMatchObject({ motivo: 'cambio de monedas', con_quien: 'Banco' });
  });

  it.each([
    ['lo que sale no cuadra con lo que entra', () => cambioDeMonedas({ conQuien: 'Banco', salen: { 10: '1000' }, entran: { 500: '19' } }, CAJERA), 'cashbook_cambio_no_cuadra'],
    ['la misma pieza sale y entra', () => cambioDeMonedas({ conQuien: 'Banco', salen: { 10: '10' }, entran: { 10: '10' } }, CAJERA), 'cashbook_cambio_misma_pieza'],
    ['un cambio sin lo que entra', () => cambioDeMonedas({ conQuien: 'Banco', salen: { 10: '10' }, entran: {} }, CAJERA), 'cashbook_cuenta_exige_piezas'],
    ['una comisión negativa', () => cambioDeMonedas({ conQuien: 'Banco', salen: { 10: '10' }, entran: { 100: '1' }, comision: '-1' }, CAJERA), 'cashbook_monto_invalido'],
  ])('NEGATIVA: %s → %s', (_q, fn, esperado) => expect(codigo(fn)).toBe(esperado));

  it('«se las lleva una persona»: salen a su custodia y regresan en billetes con la comisión; la custodia queda en cero', () => {
    const sale = aCustodiaDesdeCajon({ empleado: 'e-luis', nombre: 'Luis', piezas: { 10: '1000' }, para: 'cambiar monedas en el banco' }, CAJERA);
    const regresa = regresoCustodiaAlCajon({ empleado: 'e-luis', nombre: 'Luis', piezas: { 500: '19', 200: '2', 50: '1' } }, CAJERA);
    const comision = gasto({ concepto: 'Comisión por cambio de monedas', desde: { tipo: 'custodia', empleado: 'e-luis', nombre: 'Luis', monto: '5000' } }, CAJERA);
    for (const p of [sale, regresa, comision]) verificar(p);
    expect(sale.asiento).toMatchObject({ event_kind: 'retiro_a_custodia', meta: { motivo: 'cambiar monedas en el banco' } });
    const custodia = [sale, regresa, comision].flatMap((p) => p.asiento.lines).filter((l) => l.account.startsWith('CUSTODIA:'));
    expect(custodia).toHaveLength(3);
    expect(custodia.reduce((t, l) => t + BigInt(l.amount_minor), 0n)).toBe(0n);
  });
});
