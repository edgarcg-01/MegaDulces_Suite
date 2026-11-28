import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { CobroLlegada, CorteArqueo, CorteCobro, CorteLlegada, CorteRow, CortesSucursalesResponse, FacturasContadoResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import {
  FinanzasCortesSucursalesComponent, FILTROS_CORTES, camposBuscablesDeCorte, celdaLlegada, cuentasPorSaber, cumpleFiltro, etiquetaCuadre,
  fraseDelCorte, fraseDelPeriodo, llegadaDelCobro, resumenDelFiltro, ultimoCobroHasta,
} from './finanzas-cortes-sucursales.component';

/**
 * `[CSU.31]` Cortes / Sucursales responde «¿dónde está hoy el dinero que vendió cada caja?» (anexo FB §10–11).
 *
 * Lo que este candado cuida es lo que puede MENTIR:
 * - una cifra que no lleva a sus cortes (CSU.UI.2): el filtro de cada cifra cuenta y suma lo mismo que la cifra;
 * - «no llegó» dicho cuando la llegada no se midió (CSU.UI.8): `null` se dice, nunca se pinta como cero;
 * - una fecha de Kepler en el futuro publicada como «último cobro» (CSU.UI.1);
 * - el detalle que sigue diciendo «Todavía no se mide» con la llegada ya en la respuesta.
 *
 * Vectores SINTÉTICOS (el repo es público), con la forma de los casos medidos en prod.
 */
const HOY = '2026-11-27';
const PLAZO = 3;
const SIN_FUERA: ReadonlySet<string> = new Set();

const lleg = (p: Partial<CobroLlegada>): CobroLlegada => ({
  estado: 'en_banco', cuenta: '1604', renglones: [], caja_general: [], cuenta_bancos: 'STDR 9999', libro_hasta: '2026-11-25', ...p,
});
const cobro = (folio: string, monto: number, fecha: string, llegada: CobroLlegada | null): CorteCobro => ({
  doc_prefix: 'UA0501', folio, fecha, monto, forma_pago: 'deposito', concepto: 'DEPOSITO EFECTIVO', medio_cobro: 'banco',
  cuenta_tesoreria: 'SANTANDER 9999', llegada,
});
const llegadaCorte = (p: Partial<CorteLlegada>): CorteLlegada => ({
  estado: 'llego', llego: 0, por_saber: 0, sin_conciliar: 0, puente: 0, sin_deposito: 0, edad_dias: null, ...p,
});
function corte(p: Partial<CorteRow>): CorteRow {
  return {
    clave: `08-UD2301-${p.folio ?? '0000001'}`, sucursal: '08', sucursal_nombre: 'Sucursal Ocho',
    documento: `UD2301-${p.folio ?? '0000001'}`, folio: '0000001', fecha: '2026-11-02', referencia: 'Caja 3-39',
    caja: '3', turno: '39', monto: 1000, cobrado: 1000, saldo: 0, estado_cobro: 'cobrado',
    cobros: [], cobros_cancelados: [], devoluciones: [], devoluciones_total: 0, arqueo: null, cuadre: 'cuadra', diferencia: 0,
    sin_cuadrar: false, llegada: null, venta_turno: null, venta_sin_forma_de_pago: null,
    ...p,
  } as CorteRow;
}

// Un corte que llegó en 2 depósitos; uno que llegó a medias y lo demás espera el estado de cuenta; uno sin
// conciliar; uno sin depósito de 10 días; uno sin depósito de hoy, y uno con venta sin forma de pago.
const LLEGO = corte({
  folio: '0000001', monto: 3000, cobrado: 3000,
  cobros: [
    cobro('0000101', 1000, '2026-11-03', lleg({ renglones: [{ cuenta: 'STDR 9999', fecha: '2026-11-03', monto: 1000, concepto: 'VENTA', pareo: 'motor-tes', debil: false }] })),
    cobro('0000102', 2000, '2026-11-09', lleg({ renglones: [{ cuenta: 'STDR 9999', fecha: '2026-11-09', monto: 5000, concepto: 'DEPOSITO', pareo: 'motor-tes-group', debil: true }] })),
  ],
  llegada: llegadaCorte({ estado: 'llego', llego: 3000 }),
  venta_turno: { tickets: 20, total: 3000, devoluciones: 0, neto: 3000, igual_al_corte: true },
});
const POR_SABER = corte({
  folio: '0000002', monto: 500, cobrado: 500,
  cobros: [
    cobro('0000103', 200, '2026-11-04', lleg({})),
    cobro('0000104', 300, '2026-11-20', lleg({ estado: 'banco_sin_libro', cuenta_bancos: 'STDR 1111', libro_hasta: '2026-11-10' })),
  ],
  llegada: llegadaCorte({ estado: 'por_saber', llego: 200, por_saber: 300 }),
});
const SIN_CONCILIAR = corte({
  folio: '0000003', monto: 800, cobrado: 800, cuadre: 'corte_distinto', diferencia: 120, sin_cuadrar: true,
  cobros: [cobro('0000105', 800, '2026-11-05', lleg({ estado: 'sin_conciliar', cuenta_bancos: 'BBVA 2222', libro_hasta: '2026-11-25' }))],
  llegada: llegadaCorte({ estado: 'sin_conciliar', sin_conciliar: 800 }),
});
const VIEJO = corte({
  folio: '0000004', fecha: '2026-11-17', monto: 400, cobrado: 0, saldo: 400, estado_cobro: 'sin_cobro',
  llegada: llegadaCorte({ estado: 'sin_deposito', sin_deposito: 400, edad_dias: 10 }),
});
const DE_HOY = corte({
  folio: '0000005', fecha: '2026-11-26', monto: 250, cobrado: 0, saldo: 250, estado_cobro: 'sin_cobro',
  llegada: llegadaCorte({ estado: 'sin_deposito', sin_deposito: 250, edad_dias: 1 }),
});
const VSFP = corte({
  folio: '0000006', monto: 1700, cobrado: 1700, cuadre: 'corte_distinto', diferencia: 900, sin_cuadrar: true, venta_sin_forma_de_pago: 900,
  venta_turno: { tickets: 12, total: 1800, devoluciones: 100, neto: 1700, igual_al_corte: true },
  cobros: [cobro('0000106', 1700, '2026-11-06', lleg({}))],
  llegada: llegadaCorte({ estado: 'llego', llego: 1700 }),
});
const TODOS = [LLEGO, POR_SABER, SIN_CONCILIAR, VIEJO, DE_HOY, VSFP];
const ctx = { hoy: HOY, plazo: PLAZO, llegadaMedida: true, ventaMedida: true, donde: null, diasConFuera: SIN_FUERA };

describe('[CSU.31] CSU.UI.1 — el último cobro es el de HASTA HOY', () => {
  it('un cobro que Kepler fechó en el futuro no es el «último cobro»: se cuenta aparte, con su fecha', () => {
    const futuro = corte({ cobros: [cobro('0000134', 275.31, '2026-12-13', null), cobro('0000135', 10, '2026-11-25', null)] });
    expect(ultimoCobroHasta([LLEGO, futuro], HOY)).toEqual({ fecha: '2026-11-25', futuros: 1, primeraFutura: '2026-12-13' });
  });
  it('control: sin fechas futuras, es el máximo de siempre', () => {
    expect(ultimoCobroHasta(TODOS, HOY)).toEqual({ fecha: '2026-11-20', futuros: 0, primeraFutura: null });
  });
  it('el cobro de HOY sí cuenta como último (no es futuro)', () => {
    expect(ultimoCobroHasta([corte({ cobros: [cobro('1', 1, HOY, null)] })], HOY).fecha).toBe(HOY);
  });
});

describe('[CSU.31] CSU.UI.2 — cada cifra lleva exactamente a sus cortes', () => {
  it('⭐ los filtros de llegada suman, al centavo, lo que suma el periodo (por monto, no por estado del corte)', () => {
    const suma = (k: 'llego' | 'por_saber' | 'sin_conciliar') => TODOS.reduce((t, c) => t + (c.llegada?.[k] ?? 0), 0);
    expect(resumenDelFiltro(TODOS, 'con_llegada', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 3, monto: suma('llego') });
    expect(resumenDelFiltro(TODOS, 'por_saber', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 1, monto: suma('por_saber') });
    expect(resumenDelFiltro(TODOS, 'sin_conciliar', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 1, monto: suma('sin_conciliar') });
  });
  it('un corte con una parte que llegó y otra por saber está en LOS DOS filtros', () => {
    expect(cumpleFiltro(POR_SABER, 'con_llegada', HOY, PLAZO, SIN_FUERA)).toBe(true);
    expect(cumpleFiltro(POR_SABER, 'por_saber', HOY, PLAZO, SIN_FUERA)).toBe(true);
  });
  it('«con más de N días» es la MISMA regla del indicador: saldo y más días que el plazo', () => {
    expect(resumenDelFiltro(TODOS, 'vencido', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 1, monto: 400 });
    expect(resumenDelFiltro(TODOS, 'con_saldo', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 2, monto: 650 });
  });
  it('sin cuadrar y venta sin forma de pago se cuentan con lo que trae el corte (la regla del servidor)', () => {
    expect(resumenDelFiltro(TODOS, 'sin_cuadrar', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 2, monto: null });
    expect(resumenDelFiltro(TODOS, 'venta_sin_forma_de_pago', HOY, PLAZO, SIN_FUERA)).toEqual({ cortes: 1, monto: 900 });
  });
  it('días con conteos fuera de corte: el corte del día-sucursal que tiene uno', () => {
    const fuera = new Set(['2026-11-17|08']);
    expect(TODOS.filter((c) => cumpleFiltro(c, 'fuera_de_corte', HOY, PLAZO, fuera)).map((c) => c.folio)).toEqual(['0000004']);
  });
  it('⛔ sin medición de llegada, los filtros de llegada dan cero cortes (la pantalla los APAGA, no los ofrece en 0)', () => {
    const sinMedir = TODOS.map((c) => ({ ...c, llegada: null }));
    for (const f of ['con_llegada', 'por_saber', 'sin_conciliar'] as const) expect(resumenDelFiltro(sinMedir, f, HOY, PLAZO, SIN_FUERA).cortes).toBe(0);
  });
  it('«Mostrar» ofrece los 9 filtros, «todos» primero', () => {
    expect(FILTROS_CORTES).toHaveLength(9);
    expect(FILTROS_CORTES[0]).toBe('todos');
  });
});

describe('[CSU.31] la respuesta del periodo, en una frase', () => {
  const texto = (t: { texto: string }[]) => t.map((x) => x.texto).join('');
  it('dice cuánto llegó de lo aplicado, y cada número que cuenta cortes abre ESOS cortes', () => {
    const t = fraseDelPeriodo(TODOS, ctx);
    // Aplicado = la suma de los depósitos de los cortes: 3,000 + 500 + 800 + 1,700.
    expect(texto(t)).toContain('De $6,000.00 que Kepler aplicó a los cortes, $4,900.00 (81.7 %) ya están en el banco o en Caja General.');
    expect(texto(t)).toContain('(STDR 1111 llega al 10/11/26), en 1 corte.');
    // Cada número de la frase con filtro: su número es el del filtro.
    for (const x of t.filter((y) => y.filtro)) {
      const n = resumenDelFiltro(TODOS, x.filtro!, HOY, PLAZO, SIN_FUERA).cortes;
      expect(x.texto.startsWith(String(n))).toBe(true);
    }
    expect(t.map((x) => x.filtro).filter(Boolean)).toEqual(['por_saber', 'sin_conciliar', 'con_saldo', 'vencido', 'venta_sin_forma_de_pago']);
  });
  it('lo «por saber» nombra la cuenta y hasta dónde llega su estado de cuenta', () => {
    expect(texto(fraseDelPeriodo(TODOS, ctx))).toContain('STDR 1111 llega al 10/11/26');
    expect(cuentasPorSaber(TODOS)).toEqual([{ cuenta: 'STDR 1111', libro_hasta: '2026-11-10', monto: 300 }]);
  });
  it('⛔ sin medición: se DICE que no se midió y no se publica ningún «llegó»', () => {
    const t = texto(fraseDelPeriodo(TODOS.map((c) => ({ ...c, llegada: null })), { ...ctx, llegadaMedida: false }));
    expect(t).toContain('No se pudo medir si ese dinero llegó');
    expect(t).not.toContain('ya están en el banco');
  });
  it('con una sucursal elegida, la frase lo dice', () => {
    expect(texto(fraseDelPeriodo([LLEGO], { ...ctx, donde: 'Sucursal Ocho' }))).toMatch(/^En Sucursal Ocho, de \$3,000\.00/);
  });
  it('sin la venta del turno medida, se dice (no se calla la venta sin forma de pago)', () => {
    expect(texto(fraseDelPeriodo(TODOS, { ...ctx, ventaMedida: false }))).toContain('La venta del turno no se pudo medir.');
  });
  it('sin cortes, no hay frase', () => {
    expect(fraseDelPeriodo([], ctx)).toEqual([]);
  });
});

describe('[CSU.31] la llegada de un corte y de un depósito, en palabras', () => {
  it('la celda: «Llegó» y «Por saber» neutros; ámbar lo sin conciliar y lo que pasó el plazo sin depósito (CSU.UI.7)', () => {
    expect(celdaLlegada(LLEGO, HOY, PLAZO)).toEqual({ label: 'Llegó', sev: 'secondary' });
    expect(celdaLlegada(POR_SABER, HOY, PLAZO)).toEqual({ label: 'Por saber $300.00', sev: 'secondary' });
    expect(celdaLlegada(SIN_CONCILIAR, HOY, PLAZO)).toEqual({ label: 'Sin conciliar $800.00', sev: 'warn' });
    expect(celdaLlegada(VIEJO, HOY, PLAZO)).toEqual({ label: 'Sin depósito · 10 días', sev: 'warn' });
    expect(celdaLlegada(DE_HOY, HOY, PLAZO)).toEqual({ label: 'Sin depósito · 1 día', sev: 'secondary' });
  });
  it('⛔ sin medición (null o un corte de una API vieja sin el campo) → null: la celda cae al estado de cobro, nunca «no llegó»', () => {
    expect(celdaLlegada(corte({ llegada: null }), HOY, PLAZO)).toBeNull();
    const viejo = corte({});
    delete (viejo as Partial<CorteRow>).llegada;
    expect(celdaLlegada(viejo, HOY, PLAZO)).toBeNull();
    expect(fraseDelCorte(viejo)).toBeNull();
  });
  it('la frase del corte: cuánto llegó, en cuántos depósitos, de qué fecha a qué fecha y a qué cuenta', () => {
    expect(fraseDelCorte(LLEGO)).toBe('El dinero del corte llegó: $3,000.00 en 2 depósitos del 03/11/26 al 09/11/26 a STDR 9999.');
    expect(fraseDelCorte(POR_SABER)).toBe('$300.00 están en una cuenta cuyo estado de cuenta Bancos todavía no tiene completo para esa fecha: no se puede saber si llegaron. $200.00 sí llegaron.');
    expect(fraseDelCorte(VIEJO)).toBe('Kepler no le ha aplicado ningún depósito; el corte tiene 10 días.');
  });
  it('un depósito: dónde está, o por qué todavía no se puede decir', () => {
    expect(llegadaDelCobro(LLEGO.cobros[0])).toEqual({ titulo: 'En el banco', alerta: false });
    expect(llegadaDelCobro(LLEGO.cobros[1]).titulo).toContain('probable');
    expect(llegadaDelCobro(POR_SABER.cobros[1])).toEqual({ titulo: 'Todavía no se puede saber: el estado de cuenta de STDR 1111 en Bancos llega al 10/11/26', alerta: false });
    expect(llegadaDelCobro(SIN_CONCILIAR.cobros[0]).alerta).toBe(true);
    expect(llegadaDelCobro(cobro('9', 1, HOY, lleg({ estado: 'caja_sin_asiento' })))).toEqual({ titulo: 'Falta su entrada en Caja General', alerta: true });
    expect(llegadaDelCobro(cobro('9', 1, HOY, null))).toEqual({ titulo: 'No se pudo medir si llegó.', alerta: false });
  });
});

describe('[CSU.31] revisión independiente — lo que la pantalla no puede afirmar', () => {
  const PUENTE = corte({
    folio: '0000007', monto: 500, cobrado: 500,
    cobros: [cobro('0000107', 500, '2026-11-07', lleg({ estado: 'puente', cuenta: '0001', cuenta_bancos: null, libro_hasta: null }))],
    llegada: llegadaCorte({ estado: 'llego', llego: 0, puente: 500 }),
  });
  it('un corte saldado sólo con devoluciones o ajustes NO dice «Llegó», y tampoco cae en «Con dinero que ya llegó»', () => {
    expect(celdaLlegada(PUENTE, HOY, PLAZO)).toEqual({ label: 'Saldado con devoluciones o ajustes', sev: 'secondary' });
    expect(fraseDelCorte(PUENTE)).toBe('Kepler saldó el corte con devoluciones o ajustes por $500.00: ese dinero no viaja al banco.');
    expect(cumpleFiltro(PUENTE, 'con_llegada', HOY, PLAZO, SIN_FUERA)).toBe(false);
  });
  it('«sin conciliar» dice que falta el testigo, no que falte el dinero', () => {
    expect(fraseDelCorte(SIN_CONCILIAR)).toContain('no tienen renglón del banco ni entrada de Caja General que los respalde');
    expect(fraseDelCorte(SIN_CONCILIAR)).not.toContain('no están');
  });
  it('si el estado de cuenta llega justo al día del depósito, se dice que ese último día suele venir incompleto', () => {
    const mismoDia = cobro('0000108', 10, '2026-11-10', lleg({ estado: 'banco_sin_libro', cuenta_bancos: 'STDR 1111', libro_hasta: '2026-11-10' }));
    expect(llegadaDelCobro(mismoDia).titulo).toContain('el mismo día del depósito, y ese último día suele venir incompleto');
    expect(llegadaDelCobro(POR_SABER.cobros[1]).titulo).not.toContain('mismo día');
  });
});

describe('[CSU.31] D4 — «Corte distinto» se llama por su nombre cuando la venta del turno lo explica', () => {
  it('con venta sin forma de pago: «Venta sin forma de pago $X»; sin ella, «Corte distinto» de siempre', () => {
    expect(etiquetaCuadre(VSFP)).toBe('Venta sin forma de pago $900.00');
    expect(etiquetaCuadre(SIN_CONCILIAR)).toBe('Corte distinto $120.00');
  });
  it('el buscador encuentra por estado de llegada y por la fecha del cobro (la del cobro fechado en el futuro)', () => {
    const campos = camposBuscablesDeCorte(POR_SABER).filter(Boolean).map(String);
    expect(campos).toContain('por saber');
    expect(campos).toContain('20/11/26');
  });
});

// ─── La pantalla montada ─────────────────────────────────────────────────────────────────────────────────────
const RESPUESTA = (conLlegada: boolean): CortesSucursalesResponse => ({
  periodo: { from: '2026-11-01', to: '2026-11-30' }, alcance: { todas: true, sucursales: [] },
  totales: { cortes: TODOS.length, vendido: 6650, cobrado: 6000, pendiente: 650, sin_cobro: 2, con_diferencia: 2, sin_arqueo: 6, contado_igual_esperado: 0, con_declaracion_cajero: 0 },
  sucursales: [], cortes: conLlegada ? TODOS : TODOS.map((c) => { const x = { ...c } as Partial<CorteRow>; delete x.llegada; return x as CorteRow; }),
  conteos_fuera_de_corte: [], cortes_en_blanco: 0, ultimo_corte: '2026-11-26', umbral_descuadre: 50, plazo_cobro_dias: PLAZO,
  ...(conLlegada ? {
    llegada: { aplicado: 6000, llego: 4900, por_saber: 300, sin_conciliar: 800, puente: 0, sin_deposito: 650, cortes: { llego: 2, por_saber: 1, sin_conciliar: 1, parcial: 0, sin_deposito: 2 } },
    venta_sin_forma_de_pago: { cortes: 1, monto: 900 },
  } : {}),
} as unknown as CortesSucursalesResponse);

function montar(conLlegada = true) {
  TestBed.configureTestingModule({
    imports: [FinanzasCortesSucursalesComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: { isAdmin: () => true, isSuperadmin: () => false, has: () => true, hasExplicit: () => true, hasAny: () => true } }],
  });
  const fixture = TestBed.createComponent(FinanzasCortesSucursalesComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne((r) => r.url.includes('/finance/cortes-sucursales?')).flush(RESPUESTA(conLlegada));
  http.match(() => true);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const c = fixture.componentInstance;
  const texto = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const render = () => fixture.detectChanges();
  return { c, el, http, texto, render };
}

describe('[CSU.31] la pantalla', () => {
  it('el indicador «Llegó a la empresa» filtra: la lista y su pista llegan a su número (CSU.UI.2)', () => {
    const { c, el, texto, render } = montar();
    const llego = [...el.querySelectorAll<HTMLElement>('.ms-item')].find((x) => (x.textContent ?? '').includes('Llegó a la empresa'))!;
    expect(llego.getAttribute('role')).toBe('button');
    llego.click(); render();
    expect(c.filtro()).toBe('con_llegada');
    expect(c.cortes()).toHaveLength(3);
    expect(texto()).toContain('3 de 6 cortes · Con dinero que ya llegó · $4,900.00');
    // Otra vez el mismo indicador quita el filtro.
    llego.click(); render();
    expect(c.filtro()).toBe('todos');
  });

  it('un número de la frase abre sus cortes, y «Quitar filtro» los devuelve todos', () => {
    const { c, el, texto, render } = montar();
    const boton = [...el.querySelectorAll<HTMLButtonElement>('.cs-respuesta button')].find((b) => (b.textContent ?? '').startsWith('1 corte tiene'))!;
    boton.click(); render();
    expect(c.filtro()).toBe('sin_conciliar');
    expect(texto()).toContain('1 de 6 cortes · Sin conciliar en Bancos ni en Caja General · $800.00');
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Quitar filtro')!.click(); render();
    expect(c.filtro()).toBe('todos');
  });

  it('⭐ el detalle ya no dice «Todavía no se mide»: cada depósito dice dónde llegó, y pide las facturas del turno', () => {
    const { c, el, http, texto, render } = montar();
    c.selCorte.set(c.data()!.cortes[0]); render();
    expect(texto()).not.toContain('Todavía no se mide');
    expect(texto()).toContain('El dinero del corte llegó: $3,000.00 en 2 depósitos');
    expect([...el.querySelectorAll('.cs-step h3')].map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim()))
      .toEqual(['1 La venta del turno', '2 Corte contra el arqueo del turno', '3 Cobros aplicados en Kepler y a dónde llegaron']);
    expect(texto()).toContain('STDR 9999 · 09/11/26 · $5,000.00');
    expect(texto()).toContain('un abono que cubre este y otros depósitos');
    const req = http.expectOne((r) => r.url.includes('/finance/cortes-sucursales/facturas?'));
    expect(req.request.url).toContain('corte=08-UD2301-0000001');
    expect(req.request.url).toContain('from=2026-11-02&to=2026-11-02');
    expect(texto()).toContain('Buscando las facturas del turno');
    req.flush({ facturas: [{ sucursal: '08', tipo: 12, tipo_nombre: 'Cont No Fiscal', folio: '0000900', fecha: '2026-11-04', cliente: 'Cliente Uno', total: 120, notas: [], notas_total: 0, neto: 120, ticket: { caja: '3', folio: '5001', fecha: '2026-11-02', turno: '39', total: 120, pago: null }, corte: '08-UD2301-0000001', sin_corte: null }] } as unknown as FacturasContadoResponse);
    render();
    expect(texto()).toContain('0000900');
    expect(texto()).toContain('facturada el 04/11/26');
    expect(texto()).toContain('3-5001');
  });

  it('si las facturas del turno fallan, se dice y se puede reintentar (no «ningún ticket se facturó»)', () => {
    const { c, el, http, texto, render } = montar();
    c.selCorte.set(c.data()!.cortes[0]); render();
    http.expectOne((r) => r.url.includes('/facturas?')).flush('falla', { status: 500, statusText: 'Error' });
    render();
    expect(texto()).toContain('No se pudieron traer las facturas del turno');
    expect(texto()).not.toContain('Ningún ticket de este turno se facturó');
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Reintentar')!.click();
    expect(http.match((r) => r.url.includes('/facturas?'))).toHaveLength(1);
  });

  it('la venta sin forma de pago se nombra en el detalle (D4) con la venta del turno que la prueba', () => {
    const { c, texto, render } = montar();
    const arqueo = { esperado_neto: 800, esperado_total: 900, efectivo_esperado: 500, tarjeta_esperado: 300, transfer_esperado: 0, conteo_fisico: null, electronico_kepler: null,
      fisico_diferencia: null, arqueo_declarado: false, declaracion_cajero: null, desglose_kepler: null, conteos_cajero: [], conteos_cajero_sin_ligar: 0 } as unknown as CorteArqueo;
    c.selCorte.set({ ...VSFP, arqueo }); render();
    expect(texto()).toContain('Tickets del turno (12)');
    expect(texto()).toContain('Igual al corte');
    expect(texto()).toContain('Venta sin forma de pago $900.00');
    expect(texto()).toContain('El turno vendió $900.00 más de lo que la caja registró cobrado');
  });

  it('⛔ una respuesta sin la llegada (API anterior a CSU.29): «No medido», las opciones de llegada apagadas y «Todo cobrado» como antes', () => {
    const { c, texto } = montar(false);
    expect(texto()).toContain('No medido');
    expect(texto()).toContain('No se pudo medir si ese dinero llegó');
    const ops = c.opcionesFiltro();
    expect(ops.filter((o) => o.disabled).map((o) => o.value)).toEqual(['venta_sin_forma_de_pago', 'con_llegada', 'por_saber', 'sin_conciliar']);
    expect(ops.find((o) => o.value === 'con_llegada')!.label).toContain('no se pudo medir');
  });

  it('revisión: un corte sin caja-turno NO pide sus facturas ni dice «ningún ticket se facturó»', () => {
    const { c, http, texto, render } = montar();
    c.selCorte.set({ ...c.data()!.cortes[0], caja: null, turno: null, venta_turno: null }); render();
    expect(http.match((r) => r.url.includes('/facturas?'))).toHaveLength(0);
    expect(texto()).toContain('No se pueden buscar: sin la venta del turno ligada');
    expect(texto()).not.toContain('Ningún ticket de este turno se facturó');
  });

  it('revisión: si al recargar la llegada ya no se midió, el filtro de llegada se quita (no deja una lista vacía que parece «ninguno»)', () => {
    const { c, http, render } = montar();
    c.ponerFiltro('con_llegada', false); render();
    expect(c.filtro()).toBe('con_llegada');
    c.reload();
    http.expectOne((r) => r.url.includes('/finance/cortes-sucursales?')).flush(RESPUESTA(false));
    render();
    expect(c.filtro()).toBe('todos');
  });

  it('revisión: «días con conteos fuera de corte» dice cuántos conteos quedan en la lista y cuántos caen en días sin cortes', () => {
    const { c, http, texto, render } = montar();
    const fuera = (fecha: string) => ({ id: fecha, fecha, sucursal: '08', hora: '10:00:00', tipo: 'sin_caja', caja: null, total: 100, usuario: null, folio: null, motivo: 'fondo', por_que: 'sin_caja', piezas: [], piezas_diferencia: null, nota: null });
    c.reload();
    http.expectOne((r) => r.url.includes('/finance/cortes-sucursales?'))
      .flush({ ...RESPUESTA(true), conteos_fuera_de_corte: [fuera('2026-11-17'), fuera('2026-11-20')] } as unknown as CortesSucursalesResponse);
    render();
    c.ponerFiltro('fuera_de_corte', false); render();
    expect(c.cortes().map((x) => x.folio)).toEqual(['0000004']);
    expect(texto()).toContain('1 conteo(s) (1 más en días sin cortes, que la lista no muestra)');
  });

  it('CSU.UI.1: la pista no publica una fecha futura como «último cobro»', () => {
    const { texto } = montar();
    expect(texto()).toContain('último cobro aplicado en Kepler: 20/11/26');
  });
});
