import { signal, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { DetalleUnidadCosto, LineaGastoFlota, PresupuestoAnio, ResumenCostoUnidad, UnidadCosto } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import type { PendientesCostoUnidad } from '../logistica.service';
import { LogisticaCostoUnidadComponent } from './logistica-costo-unidad.component';
import { asignacionesDe, LogisticaCostoUnidadPendientesComponent } from './logistica-costo-unidad-pendientes.component';
import { celdasCambiadas, LogisticaCostoUnidadPresupuestoComponent } from './logistica-costo-unidad-presupuesto.component';
import { LogisticaCostoUnidadNominaComponent, mesesDelAnio } from './logistica-costo-unidad-nomina.component';
import { datosDeUnidad, LogisticaCostoUnidadReposicionComponent } from './logistica-costo-unidad-reposicion.component';

/**
 * `[FCU.3]` — Las cinco pantallas de Logística › Costo por unidad. Se MONTAN (eso compila la
 * plantilla, que tsc no mira), se les da la respuesta del servidor y se recorre lo que hace cada una:
 * qué pide, qué dice arriba y, en las que escriben, el payload EXACTO que mandan. Unidades, montos y
 * folios de prueba, inventados.
 */
const VER = [Permission.LOGISTICS_COSTO_UNIDAD_VER];
const GESTIONAR = [Permission.LOGISTICS_COSTO_UNIDAD_VER, Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR];
const PERIODO = { desde: '2026-10-01', hasta: '2026-10-30', dias: 30 };

const unidad = (x: Partial<UnidadCosto> = {}): UnidadCosto => ({
  vehicle_id: 'v1', economic_number: 'UNIDAD 1', nombre: 'TRACTO PRUEBA', plate: 'AAA111', fleet_area: 'transportes',
  km: { km: 6000, fuente: 'gps', dias_gps: 30 }, guias: 12, presupuesto: 30000, real: 24000, sugerido: 0, rubros_sin_dato: 1,
  por_km_real: 4, por_km_presupuesto: 5,
  rubros: [
    { rubro: 'seguro', etiqueta: 'Seguro', grupo: 'fijos', presupuesto_anual: 60000, presupuesto: 4931.51, real: null, procedencia: 'sin_dato', sugerido: 0, renglones: 0, calculo: 'CALCULO PRUEBA' },
    { rubro: 'combustible', etiqueta: 'Combustible', grupo: 'variables', presupuesto_anual: 300000, presupuesto: 24657.53, real: 24000, procedencia: 'kepler', sugerido: 0, renglones: 3, calculo: 'CALCULO PRUEBA' },
  ],
  avisos: [{ tipo: 'sin_fecha_seguro', severidad: 'media', texto: 'Sin fecha de vencimiento del seguro en la ficha' }],
  ...x,
});
const RESUMEN: ResumenCostoUnidad = {
  periodo: PERIODO,
  unidades: [unidad(), unidad({ vehicle_id: 'v2', economic_number: 'UNIDAD 2', nombre: 'TORTON PRUEBA', plate: 'BBB222', presupuesto: null, real: 6000, rubros_sin_dato: 0, km: { km: null, fuente: null, dias_gps: 0 } })],
  pendientes: { sugerido: { renglones: 2, importe: 1500 }, ambiguo: { renglones: 1, importe: 500 }, sin_unidad: { renglones: 0, importe: 0 } },
  meses_sin_nomina: ['2026-10'],
  leido_at: '2026-10-26T12:00:00.000Z',
};
const detalle = (salarioVisible: boolean): DetalleUnidadCosto => ({
  ficha: {
    vehicle_id: 'v1', economic_number: 'UNIDAD 1', display_name: 'TRACTO PRUEBA', plate: 'AAA111', plate_kepler: null, kepler_code: '00001',
    vin: null, year: 2020, brand: null, model: null, fleet_area: 'transportes', ownership: 'propia', purchase_value: 1650000, purchase_date: null,
    useful_life_years: 10, residual_value: 150000, insurance_carrier: null, insurance_policy: null, insurance_premium: null, insurance_expires_on: null,
    driver_monthly_salary: salarioVisible ? 15000 : null, salario_visible: salarioVisible, budget_km_year: 80000, kepler_aliases: ['TRACTO 1'],
    tiene_gps: true, notes: null,
  },
  unidad: unidad({ km: { km: 80000, fuente: 'gps', dias_gps: 365 } }),
  lineas: [], guias: [], km_por_mes: [], lecturas: [],
  periodo: { desde: '2025-10-27', hasta: '2026-10-26', dias: 365 },
  leido_at: '2026-10-26T12:00:00.000Z',
});
const linea = (x: Partial<LineaGastoFlota>): LineaGastoFlota => ({
  linea_clave: '01|10|1|A100|1', sucursal: '01', folio: 'A100', renglon: 1, fecha: '2026-10-05', concepto: '038', rubro: 'combustible',
  importe: 1000, centro: '1-08-12-00', cabecera: 'CABECERA PRUEBA', texto: 'TEXTO PRUEBA', proveedor: 'PROVEEDOR PRUEBA',
  estado: 'sin_unidad', vehicle_id: null, sugerido_vehicle_id: null, candidatos: 0, ...x,
});
const PENDIENTES: PendientesCostoUnidad = {
  periodo: PERIODO,
  lineas: [
    linea({ linea_clave: '01|10|1|A100|1', estado: 'sugerido', sugerido_vehicle_id: 'v1', importe: 1500 }),
    linea({ linea_clave: '01|10|1|A101|1', folio: 'A101', estado: 'sin_unidad', importe: 700 }),
  ],
  unidades: [{ vehicle_id: 'v1', nombre: 'TRACTO PRUEBA', plate: 'AAA111', economic_number: 'UNIDAD 1' }],
};
const PRESUPUESTO: PresupuestoAnio = {
  anio: 2026,
  unidades: [
    { vehicle_id: 'v1', economic_number: 'UNIDAD 1', nombre: 'TRACTO PRUEBA', montos: { seguro: 60000, combustible: 300000 }, total: 360000 },
    { vehicle_id: 'v2', economic_number: 'UNIDAD 2', nombre: 'TORTON PRUEBA', montos: {}, total: 0 },
  ],
};

/** El HttpTestingController del montaje de la prueba (las de funciones puras no montan nada). */
let montado: HttpTestingController | null = null;

function montar<T>(cmp: Type<T>, perms: Permission[], query: Record<string, string> = {}) {
  const mapa = Object.fromEntries(perms.map((p) => [p, true]));
  TestBed.configureTestingModule({
    imports: [cmp],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: {}, queryParamMap: convertToParamMap(query) } } },
      { provide: AuthService, useValue: { user: signal({ permissions: mapa }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => false, has: (p: string) => mapa[p] === true, hasAny: (...ps: string[]) => ps.some((p) => mapa[p] === true) } },
    ],
  });
  const f = TestBed.createComponent(cmp);
  montado = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http: montado, el: f.nativeElement as HTMLElement };
}
/**
 * Todo campo de PrimeNG quedó MONTADO (tiene su input adentro). Un selector mal escrito —`<p-inputNumber>`
 * en vez de `<p-inputnumber>`— deja un elemento desconocido y vacío: el campo no se ve ni guarda, y el
 * error de `ngModel` se pierde en una promesa, así que la prueba quedaba verde. Esto lo hace rojo.
 */
function camposMuertos(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('p-inputnumber, p-datepicker, p-select'))
    .filter((x) => !x.querySelector('input, [role="combobox"]'))
    .map((x) => x.outerHTML.slice(0, 80));
}

const pide = (http: HttpTestingController, ruta: string, metodo = 'GET') =>
  http.expectOne((r) => r.method === metodo && r.url.endsWith(`/logistics/costo-unidad/${ruta}`));

describe('[FCU.3] Costo por unidad — pantallas', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => { montado?.verify(); montado = null; });

  describe('Unidades', () => {
    it('pide el mes en curso y abre con el veredicto: cuánto costaron contra el presupuesto y qué falta', () => {
      const { f, http, el } = montar(LogisticaCostoUnidadComponent, VER);
      const req = pide(http, 'resumen');
      expect(req.request.params.get('desde')).toMatch(/^\d{4}-\d{2}-01$/);
      req.flush(RESUMEN);
      f.detectChanges();
      expect(el.textContent).toContain('2 unidades costaron $30,000.00 contra $30,000.00 presupuestados (100 %). Faltan datos en 1 rubro: el real los excluye.');
      expect(el.textContent).toContain('TRACTO PRUEBA');
      expect(el.textContent).toContain('Ir a Gastos sin unidad');
    });

    it('con sólo VER, el salario se rotula «Restringido» y el titular dice que el real no lo incluye', () => {
      const { f, http, el } = montar(LogisticaCostoUnidadComponent, VER);
      const u = unidad({ rubros: [...unidad().rubros, { rubro: 'salarios', etiqueta: 'Salarios', grupo: 'fijos', presupuesto_anual: null, presupuesto: null, real: null,
        procedencia: 'restringido', sugerido: 0, renglones: 0, calculo: 'Restringido' }] });
      pide(http, 'resumen').flush({ ...RESUMEN, unidades: [u] });
      f.detectChanges();
      expect(el.textContent).toContain('No incluye salarios ni nómina administrativa: sólo los ve quien gestiona.');
    });

    it('PRUEBA NEGATIVA: con sólo VER, la ficha no se guarda, el salario no viaja y el aviso de nómina no aparece', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadComponent, VER);
      pide(http, 'resumen').flush(RESUMEN);
      c.abrir(RESUMEN.unidades[0]);
      pide(http, 'unidades/v1').flush(detalle(false));
      f.detectChanges();
      expect(c.puedeGestionar).toBe(false);
      expect('driver_monthly_salary' in c.ficha()).toBe(false);
      expect(el.textContent).toContain('El salario sólo lo ve quien gestiona Costo por unidad.');
      expect(el.textContent).not.toContain('Guardar ficha');
      expect(el.textContent).not.toContain('Falta capturar la nómina administrativa');
    });

    it('con GESTIONAR, guardar la ficha manda SÓLO lo que cambió y vuelve a leer', async () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadComponent, GESTIONAR);
      pide(http, 'resumen').flush(RESUMEN);
      c.abrir(RESUMEN.unidades[0]);
      pide(http, 'unidades/v1').flush(detalle(true));
      f.detectChanges();
      await f.whenStable();
      expect(camposMuertos(el)).toEqual([]);
      expect(el.textContent).toContain('Guardar ficha');
      expect(c.sucio()).toBe(false);
      c.editar('insurance_premium', 52000);
      c.editarFecha('insurance_expires_on', new Date(2027, 2, 31));
      c.guardarFicha();
      const put = pide(http, 'unidades/v1/ficha', 'PUT');
      expect(put.request.body).toEqual({ insurance_premium: 52000, insurance_expires_on: '2027-03-31' });
      put.flush(detalle(true).ficha);
      pide(http, 'resumen').flush(RESUMEN);
      pide(http, 'unidades/v1').flush(detalle(true));
      expect(c.sucio()).toBe(false);
    });

    it('registrar una lectura de odómetro manda la fecha local y los km enteros', () => {
      const { c, http } = montar(LogisticaCostoUnidadComponent, GESTIONAR);
      pide(http, 'resumen').flush(RESUMEN);
      c.abrir(RESUMEN.unidades[0]);
      pide(http, 'unidades/v1').flush(detalle(true));
      c.lecturaFecha.set(new Date(2026, 9, 26));
      c.lecturaKm.set(123456.7);
      c.registrarLectura();
      const post = pide(http, 'unidades/v1/odometro', 'POST');
      expect(post.request.body).toEqual({ read_on: '2026-10-26', odometer_km: 123457 });
      post.flush([]);
      pide(http, 'resumen').flush(RESUMEN);
      pide(http, 'unidades/v1').flush(detalle(true));
    });
  });

  describe('Gastos sin unidad', () => {
    it('confirmar manda SÓLO los que tienen unidad sugerida; asignar sin unidad no manda nada', () => {
      const sel = PENDIENTES.lineas;
      expect(asignacionesDe(sel, 'confirmar', null)).toEqual([{ linea_clave: '01|10|1|A100|1', decision: 'unidad', vehicle_id: 'v1' }]);
      expect(asignacionesDe(sel, 'asignar', null)).toEqual([]);
      expect(asignacionesDe(sel, 'no_es_flota', null).map((a) => a.decision)).toEqual(['no_es_flota', 'no_es_flota']);
    });

    it('respeta las fechas que trae el enlace, dice cuánto falta y guarda la selección', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadPendientesComponent, GESTIONAR, { desde: '2026-09-01', hasta: '2026-09-30' });
      const req = pide(http, 'pendientes');
      expect([req.request.params.get('desde'), req.request.params.get('hasta'), req.request.params.get('alcance')]).toEqual(['2026-09-01', '2026-09-30', 'logistica']);
      req.flush(PENDIENTES);
      f.detectChanges();
      expect(el.textContent).toContain('2 gastos de flota por confirmar ($2,200.00): 1 con unidad sugerida por el texto, 0 que nombran dos unidades y 1 sin unidad.');
      expect(camposMuertos(el)).toEqual([]);
      c.seleccion.set(PENDIENTES.lineas);
      c.unidad.set('v1');
      c.aplicar('asignar');
      const put = pide(http, 'asignaciones', 'PUT');
      expect(put.request.body).toEqual({ items: [
        { linea_clave: '01|10|1|A100|1', decision: 'unidad', vehicle_id: 'v1' },
        { linea_clave: '01|10|1|A101|1', decision: 'unidad', vehicle_id: 'v1' },
      ] });
      put.flush({ guardadas: 2 });
      pide(http, 'pendientes').flush({ ...PENDIENTES, lineas: [] });
      expect(c.seleccion()).toEqual([]);
    });

    it('«Ya decididos» pide lo decidido y «Deshacer» lo manda como quitar', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadPendientesComponent, GESTIONAR);
      pide(http, 'pendientes').flush(PENDIENTES);
      c.cambiarAlcance('decididos');
      const req = pide(http, 'pendientes');
      expect(req.request.params.get('alcance')).toBe('decididos');
      const decididas = [
        linea({ linea_clave: '01|10|1|A200|1', folio: 'A200', estado: 'confirmado', vehicle_id: 'v1' }),
        linea({ linea_clave: '01|10|1|A201|1', folio: 'A201', estado: 'no_es_flota' }),
      ];
      req.flush({ ...PENDIENTES, lineas: decididas });
      f.detectChanges();
      expect(el.textContent).toContain('2 gastos ya decididos: 1 asignado a una unidad y 1 marcado como no de flota.');
      expect(el.textContent).toContain('Deshacer lo decidido');
      expect(el.textContent).not.toContain('Confirmar lo sugerido');
      expect(c.unidadDe(decididas[0])).toBe('UNIDAD 1 TRACTO PRUEBA');
      c.seleccion.set(decididas);
      c.aplicar('quitar');
      const put = pide(http, 'asignaciones', 'PUT');
      expect(put.request.body).toEqual({ items: [
        { linea_clave: '01|10|1|A200|1', decision: 'quitar', vehicle_id: null },
        { linea_clave: '01|10|1|A201|1', decision: 'quitar', vehicle_id: null },
      ] });
      put.flush({ guardadas: 2 });
      pide(http, 'pendientes').flush({ ...PENDIENTES, lineas: [] });
    });

    it('PRUEBA NEGATIVA: con sólo VER no hay casillas ni acciones', () => {
      const { f, http, el } = montar(LogisticaCostoUnidadPendientesComponent, VER);
      pide(http, 'pendientes').flush(PENDIENTES);
      f.detectChanges();
      expect(el.querySelector('p-tablecheckbox, p-tableCheckbox')).toBeNull();
      expect(el.textContent).not.toContain('No es de flota');
    });
  });

  describe('Presupuesto', () => {
    it('sólo viajan las celdas que cambiaron; vaciar una es quitarla', () => {
      const e = new Map<string, number | null>([['v1|seguro', 60000], ['v1|combustible', 310000], ['v2|pension', 12000], ['v1|placas_refrendo_verificacion', null]]);
      expect(celdasCambiadas(PRESUPUESTO, e)).toEqual([
        { vehicle_id: 'v1', rubro: 'combustible', amount: 310000 },
        { vehicle_id: 'v2', rubro: 'pension', amount: 12000 },
      ]);
      expect(celdasCambiadas(PRESUPUESTO, new Map([['v1|seguro', null]]))).toEqual([{ vehicle_id: 'v1', rubro: 'seguro', amount: null }]);
    });

    it('abre con el total del año y guarda las celdas editadas en el año elegido', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadPresupuestoComponent, GESTIONAR);
      const anio = new Date().getFullYear();
      const req = pide(http, 'presupuesto');
      expect(req.request.params.get('anio')).toBe(String(anio));
      req.flush({ ...PRESUPUESTO, anio });
      f.detectChanges();
      expect(el.textContent).toContain(`${anio}: $360,000.00 presupuestados para 1 de 2 unidades.`);
      expect(camposMuertos(el)).toEqual([]);
      c.editar('v2', 'pension', 12000);
      expect(c.totalAnio()).toBe(372000);
      c.guardar();
      const put = pide(http, `presupuesto/${anio}`, 'PUT');
      expect(put.request.body).toEqual({ celdas: [{ vehicle_id: 'v2', rubro: 'pension', amount: 12000 }] });
      put.flush({ ...PRESUPUESTO, anio });
      expect(c.cambios()).toEqual([]);
    });

    it('PRUEBA NEGATIVA: con celdas sin guardar no cambia de año (no se tiran en silencio); descartando, sí', () => {
      const { c, http } = montar(LogisticaCostoUnidadPresupuestoComponent, GESTIONAR);
      const anio = new Date().getFullYear();
      pide(http, 'presupuesto').flush({ ...PRESUPUESTO, anio });
      c.editar('v2', 'pension', 12000);
      c.cambiarAnio(anio - 1);
      http.expectNone((r) => r.url.endsWith('/costo-unidad/presupuesto'));
      expect(c.anio()).toBe(anio);
      c.descartar();
      c.cambiarAnio(anio - 1);
      expect(pide(http, 'presupuesto').request.params.get('anio')).toBe(String(anio - 1));
    });
  });

  describe('Nómina administrativa', () => {
    it('los 12 meses del año, con lo capturado marcado', () => {
      const m = mesesDelAnio(2026, [{ year_month: '2026-02', sueldos_admin: 82000, gastos_directos: 0, metodo: 'km', notes: null }]);
      expect(m).toHaveLength(12);
      expect(m.filter((x) => x.capturado).map((x) => x.nombre)).toEqual(['Febrero']);
      expect(m[0]).toMatchObject({ year_month: '2026-01', sueldos_admin: 0, capturado: false });
    });

    it('dice qué meses faltan y guarda un mes con su método de reparto', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadNominaComponent, GESTIONAR);
      const anio = new Date().getFullYear();
      pide(http, 'nomina').flush([]);
      f.detectChanges();
      expect(el.textContent).toContain(`${anio}: no hay nada capturado.`);
      expect(camposMuertos(el)).toEqual([]);
      c.editar(`${anio}-01`, 'sueldos_admin', 82000);
      c.editar(`${anio}-01`, 'metodo', 'partes_iguales');
      expect(c.sucio(`${anio}-01`)).toBe(true);
      c.guardar(`${anio}-01`);
      const put = pide(http, 'nomina', 'PUT');
      expect(put.request.body).toEqual({ year_month: `${anio}-01`, sueldos_admin: 82000, gastos_directos: 0, metodo: 'partes_iguales', notes: null });
      put.flush([{ year_month: `${anio}-01`, sueldos_admin: 82000, gastos_directos: 0, metodo: 'partes_iguales', notes: null }]);
      expect(c.sucio(`${anio}-01`)).toBe(false);
      expect(c.total('sueldos_admin')).toBe(82000);
    });
  });

  describe('Reposición', () => {
    it('lo que falta de la unidad se declara, no se rellena', () => {
      expect(datosDeUnidad(null, { km: null, fuente: null, dias_gps: 0 }, 365).nota).toBe('Ojo: la ficha no tiene valor de compra; no hay km del último año (sin GPS ni lecturas de odómetro). Escribe el dato a mano.');
      expect(datosDeUnidad(1650000, { km: 40000, fuente: 'gps', dias_gps: 200 }, 365).nota).toContain('200 de 365 días con GPS');
      expect(datosDeUnidad(1650000, { km: 80000, fuente: 'gps', dias_gps: 365 }, 365)).toEqual({ valor: 1650000, km_anio: 80000, nota: 'Valor de compra de la ficha y km de los últimos 12 meses.' });
    });

    it('llega con la unidad desde su ficha y reproduce la tabla lateral de la hoja', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadReposicionComponent, VER, { unidad: 'v1' });
      pide(http, 'resumen').flush(RESUMEN);
      pide(http, 'unidades/v1').flush(detalle(false));
      f.detectChanges();
      expect(c.tabla()).toHaveLength(10);
      expect(c.tabla()[0]).toEqual({ anio: 1, valor_reposicion: 1650000, valor_residual: 1485000, perdida_acumulada: 165000, perdida_del_anio: 165000, por_km: 2.06 });
      expect(el.textContent).toContain('El primer año se pierden $165,000 ($2.06 por km)');
      expect(camposMuertos(el)).toEqual([]);
    });

    it('se puede volver a los supuestos de la hoja (5 %, 10 %, 10 años) tras cambiarlos', () => {
      const { c, http } = montar(LogisticaCostoUnidadReposicionComponent, VER);
      pide(http, 'resumen').flush(RESUMEN);
      expect(c.cambiaronSupuestos()).toBe(false);
      c.incremento.set(8);
      c.anios.set(5);
      expect(c.cambiaronSupuestos()).toBe(true);
      c.supuestosDeLaHoja();
      expect([c.incremento(), c.depreciacion(), c.anios()]).toEqual([5, 10, 10]);
    });

    it('PRUEBA NEGATIVA: sin valor no hay tabla, y sin km no se inventa el $/km', () => {
      const { f, c, http, el } = montar(LogisticaCostoUnidadReposicionComponent, VER);
      pide(http, 'resumen').flush(RESUMEN);
      f.detectChanges();
      expect(c.tabla()).toEqual([]);
      expect(el.textContent).toContain('escribe el valor de la unidad');
      c.valor.set(1000000);
      f.detectChanges();
      expect(c.tabla()[0].por_km).toBeNull();
      expect(el.textContent).toContain('sin km para sacarlo por km');
    });
  });
});
