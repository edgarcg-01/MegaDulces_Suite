import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError, type Observable } from 'rxjs';
import type { AvanceDelEmbudo, CalendarioCompras, DefinirOcasionalesRespuesta, EmbudoLlenado, GuardarReglaRespuesta, PropuestaDiaFijo, PropuestaSinRegla, PropuestasCalendario } from '@megadulces/contracts';
import { ComprasCalendarioComponent } from './compras-calendario.component';
import { CalendarioComprasService } from '../calendario-compras.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import type { ResponsablesCalendario } from '@megadulces/contracts';

/**
 * `[PQ.3.14]` «Sin regla» con el día fijo por sucursal. El fixture copia DOS propuestas medidas en prod el
 * 2026-11-21 (con claves y nombres de prueba): un proveedor que en Yurécuaro entrega un viernes sí y otro no, y uno
 * que en Morelia Abastos cae en jueves y ya tiene su regla corporativa.
 */
const HOY = '2026-11-21';
const SUC = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];

const cal = (): CalendarioCompras => ({
  hoy: HOY, reglas: [], resumen: { rezagada: 0, toca_hoy: 0, sin_ancla: 0, al_dia: 0, fuera_de_ciclo: 0 },
  zonas: [{ code: 'LP', nombre: 'La Piedad', sucursales: ['01', '02', '03', '04'] }, { code: 'MOR', nombre: 'Morelia', sucursales: ['07', '08'] }],
  sucursales: SUC, actividad_desde: '2026-09-20', fuente: 'prueba', tu_alcance: { todas: true, sucursales: SUC },
} as unknown as CalendarioCompras);

const dia = (o: Partial<PropuestaDiaFijo>): PropuestaDiaFijo => ({
  branch_code: '04', weekday: 5, every_days: 14, dias: 13, en_el_dia: 13, recientes: { en_el_dia: 5, esperadas: 6 }, ultima: '2026-11-13', ...o,
});
const prov = (o: Partial<PropuestaSinRegla>): PropuestaSinRegla => ({
  supplier_code: 'PT1', supplier_name: 'TOSTADAS DE PRUEBA', supplier_record: 'ficha_viva', proposal_status: 'propuesto',
  cycle_days_proposed: 14, next_date_proposed: '2026-11-27', rounds_12m: 20, last_order_date: '2026-11-13', branches_12m: ['02', '04'],
  reglas_vivas: 0, dias_fijos: [], peso: { escalon: 2, compra_pct: 1, ocs_12m: 10 }, ...o,
});
const avance = (o: Partial<AvanceDelEmbudo>): AvanceDelEmbudo => ({
  escalon: null, proveedores: 3, con_regla: 1, compra_pct: 100, compra_con_regla_pct: 1, ocs_pct: 100, ocs_con_regla_pct: 1, ...o,
});
const EMBUDO: EmbudoLlenado = { measured: true, note: null, total: avance({}), escalones: [avance({ escalon: 1, proveedores: 0, con_regla: 0, compra_pct: 0, compra_con_regla_pct: 0, ocs_pct: 0, ocs_con_regla_pct: 0 }), avance({ escalon: 2 }), avance({ escalon: 3, proveedores: 0, con_regla: 0, compra_pct: 0, compra_con_regla_pct: 0, ocs_pct: 0, ocs_con_regla_pct: 0 })] };

/** `[PQ.3.22]` Quién puede ser responsable: uno de oficina (todas), el encargado de Yurécuaro y uno de La Piedad. */
const RESPONSABLES: ResponsablesCalendario = {
  personas: [
    { user_id: 'U-GER', nombre: 'Gerencia Prueba', puesto: 'gerente_compras', sucursales: null },
    { user_id: 'U-YUR', nombre: 'Encargado Yurécuaro', puesto: 'encargado_tienda', sucursales: ['04'] },
    { user_id: 'U-LP', nombre: 'Compras La Piedad', puesto: 'compras', sucursales: ['01', '02', '03', '04'] },
  ],
};

function montar(prop: PropuestasCalendario, vista?: string, calendario: CalendarioCompras = cal()) {
  const api = {
    calendario: vi.fn(() => of(calendario)), propuestas: vi.fn(() => of(prop)),
    guardarRegla: vi.fn(() => of({ id: 'R-NUEVA', accion: 'creada' } as GuardarReglaRespuesta)),
    definirOcasionales: vi.fn((): Observable<DefinirOcasionalesRespuesta> => of({ definidas: 1, hasta: '2027-05-20', omitidas: [] })),
    responsables: vi.fn((): Observable<ResponsablesCalendario> => of(RESPONSABLES)),
  };
  const perms = { has$: () => signal(true), has: () => true, isAdmin: () => false };
  TestBed.configureTestingModule({
    imports: [ComprasCalendarioComponent],
    providers: [
      provideRouter([]), { provide: CalendarioComprasService, useValue: api }, { provide: PermissionsService, useValue: perms },
      { provide: AuthService, useValue: { user: signal({ sub: 'U-YO' }) } },
      ...(vista ? [{ provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({ vista })) } }] : []),
    ],
  });
  const f = TestBed.createComponent(ComprasCalendarioComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, el: f.nativeElement as HTMLElement, api };
}
/** El detalle que se abre tras guardar (privado: lo que el side-peek va a mostrar). */
const abiertaId = (c: ComprasCalendarioComponent) => (c as unknown as { abiertaId: () => string | null }).abiertaId();

describe('[PQ.3.14] Sin regla: el día fijo por sucursal', () => {
  const PROP: PropuestasCalendario = {
    hoy: HOY, con_regla: 1, dia_fijo: { measured: true, note: null }, embudo: EMBUDO,
    sin_regla: [prov({ dias_fijos: [dia({})] }), prov({ supplier_code: 'PX2', supplier_name: 'SIN DIA FIJO', dias_fijos: [] })],
    dia_fijo_pendiente: [prov({
      supplier_code: 'PB3', supplier_name: 'BEBIDAS DE PRUEBA', reglas_vivas: 1,
      dias_fijos: [dia({ branch_code: '08', weekday: 4, every_days: 7, dias: 43, en_el_dia: 38, recientes: { en_el_dia: 12, esperadas: 13 }, ultima: '2026-11-19' })],
    })],
  };

  it('la línea por sucursal dice el día, el periodo y lo reciente; abre la vista «Sin regla» (0 reglas)', () => {
    const { el } = montar(PROP);
    const t = el.textContent ?? '';
    expect(t).toContain('Yurécuaro: un viernes sí y otro no');
    expect(t).toContain('5 de 6 viernes en las últimas 13 semanas');
    expect(t).toContain('2 sucursales tienen día fijo');
  });

  it('el que YA tiene regla sigue en la lista con su pendiente, y NO cuenta como «sin regla»', () => {
    const { c, el } = montar(PROP);
    expect(c.sinRegla().map((p) => p.supplier_code)).toEqual(['PT1', 'PX2', 'PB3']);
    expect(el.textContent ?? '').toContain('ya tiene 1 regla; falta la de su sucursal con día fijo');
    expect(c.respuesta()).toContain('2 proveedores con compra en Kepler no tienen regla');
  });

  it('el clic abre el formulario LLENO: sucursal, viernes cada 2 semanas desde la última de ESA sucursal, y la evidencia', () => {
    const { c, el, f } = montar(PROP);
    const btn = [...el.querySelectorAll<HTMLButtonElement>('button.cc-diafijo')].find((b) => b.textContent?.includes('Yurécuaro'));
    expect(btn?.getAttribute('aria-label')).toBe('Definir la regla de Yurécuaro: un viernes sí y otro no');
    btn?.click();
    f.detectChanges();
    expect(c.dlgRegla()).toBe(true);
    // `[PQ.3.15]` Antes «cada 14 días» (se movía con cada orden); ahora viernes cada 2 semanas anclado en ESA sucursal.
    expect([c.rScope, c.rSucursales, c.rPatron, c.rCadencia, c.rAncla?.getDate(), c.rProv?.ancla]).toEqual(['branch', ['04'], 'weekdays', '2', 13, '2026-11-13']);
    expect(c.rEvidencia).toContain('13 de los 13 días con orden o entrada de los últimos 12 meses cayeron en viernes');
    expect(c.problemaRegla()).toBeNull();
    expect(c.vistaPrevia().startsWith('vie 27 nov')).toBe(true);
  });

  it('cada semana se arma como «días de la semana» con ese día marcado', () => {
    const { c } = montar(PROP);
    c.abrirReglaDeDiaFijo(PROP.dia_fijo_pendiente[0], PROP.dia_fijo_pendiente[0].dias_fijos[0]);
    expect([c.rScope, c.rSucursales, c.rPatron, c.rCadencia, c.rSemana.map((x, i) => (x ? i + 1 : 0)).filter(Boolean)]).toEqual(['branch', ['08'], 'weekdays', 'semana', [4]]);
  });

  it('NEGATIVA: abrir otra regla después limpia la evidencia (no se queda pegada a otro proveedor)', () => {
    const { c } = montar(PROP);
    c.abrirReglaDeDiaFijo(PROP.sin_regla[0], PROP.sin_regla[0].dias_fijos[0]);
    c.abrirReglaDePropuesta(PROP.sin_regla[1]);
    expect(c.rEvidencia).toBeNull();
    expect(c.rScope).toBe('corporate');
  });

  it('aceptar desde «Sin regla» NO abre el detalle encima de la lista, y el aviso dice DÓNDE quedó (prueba visual 2026-11-21)', () => {
    const { c, api } = montar(PROP);
    c.abrirReglaDeDiaFijo(PROP.sin_regla[0], PROP.sin_regla[0].dias_fijos[0]);
    c.guardarRegla();
    expect(api.guardarRegla).toHaveBeenCalledTimes(1);
    expect(c.dlgRegla()).toBe(false);
    expect(abiertaId(c)).toBeNull();
    expect(c.aviso()).toBe('Regla creada: TOSTADAS DE PRUEBA en Yurécuaro, cada 2 semanas, en viernes.');
  });

  it('NEGATIVA: desde «Reglas» guardar SÍ abre el detalle de la regla (el cambio es sólo de «Sin regla»)', () => {
    const { c } = montar(PROP, 'reglas');
    expect(c.vista()).toBe('reglas');
    c.abrirReglaDeDiaFijo(PROP.dia_fijo_pendiente[0], PROP.dia_fijo_pendiente[0].dias_fijos[0]);
    c.guardarRegla();
    expect(abiertaId(c)).toBe('R-NUEVA');
    expect(c.aviso()).toBe('Regla creada: BEBIDAS DE PRUEBA en Morelia Abastos, cada jueves.');
  });

  it('NEGATIVA: sin medir el día fijo, la pantalla lo DICE (no lo pinta como «ninguno»)', () => {
    const { el } = montar({ ...PROP, dia_fijo: { measured: false, note: 'No se pudo leer la actividad de Kepler de 12 meses: el día fijo por sucursal no se midió.' }, sin_regla: PROP.sin_regla.map((p) => ({ ...p, dias_fijos: [] })), dia_fijo_pendiente: [] });
    const t = el.textContent ?? '';
    expect(t).toContain('el día fijo por sucursal no se midió');
    expect(t).toContain('Las propuestas por ciclo sí están');
    expect(t).not.toContain('tienen día fijo');
  });
});

describe('[PQ.3.18] Sin regla: el embudo de llenado', () => {
  // Llegan DESORDENADOS (como si la API no ordenara): la pantalla junta las dos listas y las ordena por escalón y peso.
  const PROP: PropuestasCalendario = {
    hoy: HOY, con_regla: 1, dia_fijo: { measured: true, note: null },
    sin_regla: [
      prov({ supplier_code: 'C3', supplier_name: 'OCASIONAL DE PRUEBA', proposal_status: 'una_compra', peso: { escalon: 3, compra_pct: 0.1, ocs_12m: 1 } }),
      prov({ supplier_code: 'B2', supplier_name: 'RECURRENTE DE PRUEBA', peso: { escalon: 2, compra_pct: 1, ocs_12m: 12 } }),
      prov({ supplier_code: 'A1', supplier_name: 'GRANDE DE PRUEBA', rounds_12m: 49, peso: { escalon: 1, compra_pct: 10.9, ocs_12m: 490 } }),
    ],
    dia_fijo_pendiente: [prov({ supplier_code: 'D1', supplier_name: 'BOLSAS DE PRUEBA', reglas_vivas: 1, dias_fijos: [dia({})], peso: { escalon: 1, compra_pct: 8.5, ocs_12m: 420 } })],
    embudo: {
      measured: true, note: null,
      total: avance({ proveedores: 340, con_regla: 1, compra_con_regla_pct: 8.5, ocs_con_regla_pct: 4 }),
      escalones: [
        avance({ escalon: 1, proveedores: 62, con_regla: 1, compra_pct: 82.8, compra_con_regla_pct: 8.5, ocs_pct: 65.8, ocs_con_regla_pct: 4 }),
        avance({ escalon: 2, proveedores: 184, con_regla: 0, compra_pct: 15.4, compra_con_regla_pct: 0, ocs_pct: 32.4, ocs_con_regla_pct: 0 }),
        avance({ escalon: 3, proveedores: 94, con_regla: 0, compra_pct: 1.8, compra_con_regla_pct: 0, ocs_pct: 1.8, ocs_con_regla_pct: 0 }),
      ],
    },
  };

  it('dice primero cuánto se lleva y cada escalón con su avance (lo hecho DE lo que pesa)', () => {
    const { el } = montar(PROP);
    const t = el.textContent ?? '';
    expect(el.querySelector('.cc-embudo-total')?.textContent?.trim()).toBe('Con regla: 1 de 340 proveedores · 8.5\u00a0% de la compra · 4\u00a0% de las OC');
    expect([...el.querySelectorAll('.cc-escalon')].map((b) => b.textContent?.trim())).toEqual([
      'Escalón 1 · el 80\u00a0% de la compra o el 50\u00a0% de las OC', 'Escalón 2 · el resto con compra recurrente', 'Escalón 3 · ocasionales',
    ]);
    expect(t).toContain('1 de 62 proveedores · 8.5\u00a0% de 82.8\u00a0% de la compra · 4\u00a0% de 65.8\u00a0% de las OC');
  });

  it('la lista va por escalón y luego por lo que pesa, juntando «sin regla» y los pendientes de día fijo', () => {
    const { c } = montar(PROP);
    expect(c.sinRegla().map((p) => p.supplier_code)).toEqual(['A1', 'D1', 'B2', 'C3']);
  });

  it('el renglón dice su peso: parte de la compra, OC, rondas y escalón (las rondas ya no son columna)', () => {
    const { el } = montar(PROP);
    const fila = [...el.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('GRANDE DE PRUEBA'));
    expect(fila?.textContent).toContain('10.9\u00a0% de la compra');
    expect(fila?.textContent).toContain('490 OC · 49 rondas en 12 meses · escalón 1');
    expect([...el.querySelectorAll('th')].map((h) => h.textContent?.trim())).not.toContain('Rondas en 12 meses');
  });

  it('un clic en el escalón filtra la lista a ése (aria-pressed y lo dice); otro clic vuelve a todos', () => {
    const { c, el, f } = montar(PROP);
    const b1 = () => el.querySelectorAll<HTMLButtonElement>('.cc-escalon')[0];
    b1().click(); f.detectChanges();
    expect(c.sinRegla().map((p) => p.supplier_code)).toEqual(['A1', 'D1']);
    expect(b1().getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent ?? '').toContain('Viendo sólo el Escalón 1 · el 80\u00a0% de la compra o el 50\u00a0% de las OC.');
    b1().click(); f.detectChanges();
    expect(c.sinRegla().map((p) => p.supplier_code)).toEqual(['A1', 'D1', 'B2', 'C3']);
    expect(b1().getAttribute('aria-pressed')).toBe('false');
  });

  it('un escalón ya lleno lo dice en la tabla, no «nada coincide»', () => {
    const { c, el, f } = montar({ ...PROP, sin_regla: PROP.sin_regla.filter((p) => p.supplier_code !== 'C3') });
    c.filtrarEscalon(3); f.detectChanges();
    expect(el.textContent ?? '').toContain('No quedan proveedores sin regla en el Escalón 3 · ocasionales.');
  });

  it('(c) el escalón 3 ofrece sacar del ciclo a sus ocasionales SIN regla; el diálogo dice qué hace antes de hacerlo', () => {
    const { el, f } = montar(PROP);
    const b = el.querySelector<HTMLButtonElement>('.cc-ocasionales');
    expect(b?.textContent?.trim()).toBe('Sacar del ciclo al ocasional');
    b!.click(); f.detectChanges();
    const d = document.querySelector('.p-dialog')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(d).toContain('1 proveedor compró una o pocas veces en 12 meses');
    expect(d).toContain('«cada 180 días»');
    expect(d).toContain('fuera de ciclo hasta el sáb 22 may'); // hoy (21-nov) + 182 días, la misma cuenta que el servidor
    expect(d).toContain('Son: OCASIONAL DE PRUEBA.');
  });

  it('(c) al confirmar manda las claves que la pantalla muestra, cierra y dice cuántos quedaron y hasta cuándo', () => {
    const { c: comp, el, f, api } = montar(PROP);
    comp.abrirOcasionales(); f.detectChanges();
    comp.guardarOcasionales(); f.detectChanges();
    expect(api.definirOcasionales).toHaveBeenCalledWith(['C3']);
    expect(comp.dlgOcasionales()).toBe(false);
    expect(el.textContent ?? '').toContain('1 proveedor ocasional quedó fuera de ciclo hasta el jue 20 may');
  });

  it('(c) si falla, el diálogo se queda abierto y dice que no se guardó ninguno', () => {
    const { c: comp, f, api } = montar(PROP);
    api.definirOcasionales.mockReturnValueOnce(throwError(() => ({ status: 403, error: { message: 'Fuera de tu alcance' } })));
    comp.abrirOcasionales(); f.detectChanges();
    comp.guardarOcasionales(); f.detectChanges();
    expect(comp.dlgOcasionales()).toBe(true);
    expect(comp.errorDlg()).toMatch(/^No se guardó ninguno\./);
  });

  it('(c) NEGATIVA: sin ocasionales sin regla (o sin peso medido) no hay botón', () => {
    const sin = montar({ ...PROP, sin_regla: PROP.sin_regla.filter((p) => p.supplier_code !== 'C3') });
    expect(sin.el.querySelector('.cc-ocasionales')).toBeNull();
    TestBed.resetTestingModule();
    const nm = montar({ ...PROP, sin_regla: PROP.sin_regla.map((p) => ({ ...p, peso: null })) });
    expect(nm.el.querySelector('.cc-ocasionales')).toBeNull();
  });

  it('NEGATIVA: sin la compra medida lo DICE (no pinta 0 %), no ofrece escalones y la lista queda en el orden de Kepler', () => {
    const nm: PropuestasCalendario = {
      ...PROP,
      sin_regla: PROP.sin_regla.map((p) => ({ ...p, peso: null })), dia_fijo_pendiente: [],
      embudo: { measured: false, note: 'No se pudo leer la compra de 12 meses: el peso de cada proveedor no se midió y la lista va en el orden de Kepler.',
        total: avance({ proveedores: 340, con_regla: 1, compra_pct: null, compra_con_regla_pct: null, ocs_pct: null, ocs_con_regla_pct: null }), escalones: [] },
    };
    const { c, el } = montar(nm);
    const t = el.textContent ?? '';
    expect(el.querySelector('.cc-embudo-total')?.textContent?.trim()).toBe('Con regla: 1 de 340 proveedores (lo que pesan en la compra no se midió)');
    expect(t).toContain('el peso de cada proveedor no se midió');
    expect(el.querySelectorAll('.cc-escalon').length).toBe(0);
    expect(c.sinRegla().map((p) => p.supplier_code)).toEqual(['C3', 'B2', 'A1']);
    expect(t).toContain('Peso no medido');
  });
});
