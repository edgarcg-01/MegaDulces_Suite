import { NotFoundException } from '@nestjs/common';
import { ErpShipmentsService } from './erp-shipments.service';

/**
 * EMB.12 — `ErpShipmentsService.nuevoEmbarque`: ARMA la hoja con lo que contestan las vistas.
 *
 * Las reglas sueltas ya tienen su spec (`nuevo-embarque.logic.spec.ts`); aquí se prueba el
 * ensamble, que es donde un cruce mal hecho publica otra cosa: la carga pegada a la parada que
 * no es, el chofer resuelto por el nombre en vez de la clave, la sucursal que tumba la hoja.
 * Con una base de mentira que contesta por tabla — la consulta real ya la cubre el smoke
 * `database/tests/test-newdb-emb-nuevo-embarque.js` contra Postgres.
 */

type Filas = Record<string, any[]>;

function baseFalsa(tablas: Filas, opts: { paradas: any[]; sucursalNombre?: string | null }) {
  const tablasConsultadas: string[] = [];
  const raws: string[] = [];
  const trx: any = (tabla: string) => {
    tablasConsultadas.push(tabla);
    let filas = [...(tablas[tabla] ?? [])];
    const cumple = (f: any, k: string, v: any) => !(k in f) || f[k] === v;
    const b: any = {
      where(a: any, v?: any) {
        filas = typeof a === 'string'
          ? filas.filter((f) => cumple(f, a, v))
          : filas.filter((f) => Object.entries(a).every(([k, x]) => cumple(f, k, x)));
        return b;
      },
      whereNull: () => b,
      whereNot: () => b,
      select: () => b,
      first: async () => filas[0],
      then: (ok: any, ko: any) => Promise.resolve(filas).then(ok, ko),
    };
    return b;
  };
  trx.raw = async (sql: string) => {
    raws.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ ok: opts.sucursalNombre !== undefined }] };
    if (sql.includes('erp_shipment_stops')) return { rows: opts.paradas };
    if (sql.includes('pv_suc_ip')) return { rows: opts.sucursalNombre ? [{ nombre: opts.sucursalNombre }] : [] };
    throw new Error(`consulta inesperada: ${sql}`);
  };
  const tk: any = { run: async (_tenant: string, fn: (t: any) => any) => fn(trx) };
  return { svc: new ErpShipmentsService(tk), tablasConsultadas, raws };
}

// La guía 0001419 de Canindo, recortada a dos paradas de rutas distintas.
const VIAJE = {
  sucursal: '06', guia_embarque: '0001419', guia_digital: '06-G0001419', fecha: new Date(2026, 9, 3),
  vehicle_id: 'v17', transporte_descripcion: 'FORD 450 GASOLINA SUPER DUTY', transporte_placas: 'NC-1134-D',
  multi_transporte: false, multi_chofer: false, multi_fecha: false,
};
const encabezado = (folio: string, total: string, chofer: string | null = '00017') => ({
  serie: '1', serie_label: 'Telemarketing', folio, folio_digital: `06UD4101-${folio}`, fecha: new Date(2026, 9, 3),
  cliente_code: 'C3051', destino_nombre: 'CLIENTE', destino_ciudad: 'JIQUILPAN', total,
  resp_surtido: '01', resp_checado: '02', resp_embarque: '03',
  transporte_code: '00017', transporte_clave_kepler: '00017', chofer_code: chofer, chofer_clave_kepler: chofer,
  chofer_nombre: chofer ? 'CESAR CASAS MENDOZA' : null, vehicle_id: 'v17',
});
const PARADAS = [
  { serie: 1, folio: '0001051', ruta_clave: 'R0041', ruta_nombre: 'SANTAGIO TANGAMNADAPIO', orden_visita: 1,
    facturado: true, facturacion: 'F', nota_almacen: '10  CAJAS    A-1', cajas: '10', sueltos: '6', kg: null },
  { serie: 1, folio: '0001052', ruta_clave: 'R0057', ruta_nombre: 'JIQUILPAN', orden_visita: 2,
    facturado: true, facturacion: 'F', nota_almacen: '67  CAJAS  B-4', cajas: '67', sueltos: '0', kg: null },
];
const tablas = (over: Filas = {}): Filas => ({
  'analytics.erp_shipment_trips': [VIAJE],
  'analytics.erp_shipment_headers': [encabezado('0001051', '12054.93'), encabezado('0001052', '54468.36')],
  'analytics.v_kepler_responsables': [
    { sucursal: '06', rol: 'surtido', codigo: '01', nombre: 'JORGE' },
    { sucursal: '06', rol: 'checado', codigo: '02', nombre: 'ANA GABRIELA CISNEROS' },
    { sucursal: '06', rol: 'embarque', codigo: '03', nombre: 'JUAN MANUEL ESPINOZA' },
  ],
  'logistics.vehicles': [{ id: 'v17', plate: 'NC-1134-D', brand: 'FORD', model: '450', status: 'disponible', active: true }],
  'logistics.trackers': [],
  'logistics.drivers': [
    { id: 'd-otro', kepler_code: '00099', full_name: 'CESAR CASAS MENDOZA', active: true },
    { id: 'd-cesar', kepler_code: '00017', full_name: 'CESAR C.', active: true },
  ],
  'logistics.routes': [
    { id: 'r57', name: 'JIQUILPAN', kepler_code: 'R0057', driver_commission: '98.04', helper_commission: '57.76', active: true },
  ],
  'logistics.shipments': [],
  ...over,
});

describe('ErpShipmentsService.nuevoEmbarque — arma la hoja de la guía', () => {
  it('pega a cada parada SU carga y la ordena por ruta', async () => {
    const { svc } = baseFalsa(tablas(), { paradas: PARADAS, sucursalNombre: 'Sucursal Canindo' });
    const h = await svc.nuevoEmbarque('06', '0001419');
    expect(h.paradas.map((p: any) => p.folio)).toEqual(['0001052', '0001051']); // JIQUILPAN antes que SANTAGIO
    expect(h.paradas[1]).toMatchObject({ cajas: 10, sueltos: 6, kg: null, total: 12054.93, ruta_clave: 'R0041' });
    expect(h.resumen).toMatchObject({ cajas: 77, sueltos: 6, valor_venta: 66523.29 });
  });

  it('trae fecha local, nombre de la sucursal y responsables por su clave', async () => {
    const { svc } = baseFalsa(tablas(), { paradas: PARADAS, sucursalNombre: 'Sucursal Canindo' });
    const h = await svc.nuevoEmbarque('06', '0001419');
    expect(h.viaje).toMatchObject({ fecha: '2026-10-03', sucursal_nombre: 'Sucursal Canindo', guia_digital: '06-G0001419' });
    expect(h.responsables).toMatchObject({ surtio: ['JORGE'], checo: ['ANA GABRIELA CISNEROS'], embarco: ['JUAN MANUEL ESPINOZA'] });
  });

  it('el chofer se resuelve por la CLAVE de Kepler, no por el nombre', async () => {
    const { svc } = baseFalsa(tablas(), { paradas: PARADAS, sucursalNombre: 'Sucursal Canindo' });
    const h = await svc.nuevoEmbarque('06', '0001419');
    // `d-otro` tiene el mismo nombre pero otra clave: no debe salir.
    expect(h.chofer).toMatchObject({ kepler_code: '00017', driver_id: 'd-cesar', en_suite: true, falta: false });
  });

  it('sin chofer en Kepler: falta, y ni se pregunta al padrón', async () => {
    const t = tablas({ 'analytics.erp_shipment_headers': [encabezado('0001051', '12054.93', null)] });
    const { svc, tablasConsultadas } = baseFalsa(t, { paradas: PARADAS.slice(0, 1), sucursalNombre: 'Sucursal Canindo' });
    const h = await svc.nuevoEmbarque('06', '0001419');
    expect(h.chofer).toMatchObject({ falta: true, driver_id: null, en_suite: false });
    expect(tablasConsultadas).not.toContain('logistics.drivers');
  });

  it('la unidad sin rastreador lo dice; con rastreador, no', async () => {
    const sin = await baseFalsa(tablas(), { paradas: PARADAS, sucursalNombre: 'x' }).svc.nuevoEmbarque('06', '0001419');
    expect(sin.unidad).toMatchObject({ kepler_code: '00017', vehicle_id: 'v17', gps: false });
    expect(sin.unidad.motivo).toMatch(/rastreador/);
    const con = await baseFalsa(tablas({ 'logistics.trackers': [{ id: 't1', vehicle_id: 'v17' }] }), { paradas: PARADAS, sucursalNombre: 'x' })
      .svc.nuevoEmbarque('06', '0001419');
    expect(con.unidad).toMatchObject({ gps: true, motivo: null });
  });

  it('la comisión sale de la ruta con tarifa; la que no tiene se declara sin tarifa', async () => {
    const { svc } = baseFalsa(tablas(), { paradas: PARADAS, sucursalNombre: 'x' });
    const { comision } = await svc.nuevoEmbarque('06', '0001419');
    expect(comision).toMatchObject({ driver: 98.04, helper: 57.76 });
    expect(comision.ruta_usada).toMatchObject({ route_id: 'r57' });
    expect(comision.sin_tarifa.map((r: any) => r.clave)).toEqual(['R0041']);
  });

  it('sin el catálogo de sucursales la hoja sale igual, sin nombre y sin consultarlo', async () => {
    const { svc, raws } = baseFalsa(tablas(), { paradas: PARADAS }); // sucursalNombre undefined = la tabla no existe
    const h = await svc.nuevoEmbarque('06', '0001419');
    expect(h.viaje.sucursal_nombre).toBeNull();
    expect(raws.filter((s) => s.includes('pv_suc_ip') && !s.includes('to_regclass'))).toHaveLength(0);
  });

  it('una guía ya tomada lo dice, con su folio', async () => {
    const t = tablas({ 'logistics.shipments': [{ id: 'e1', folio: 'EMB-2026-00012', status: 'programado', kepler_sucursal: '06', kepler_guia: '0001419' }] });
    const h = await baseFalsa(t, { paradas: PARADAS, sucursalNombre: 'x' }).svc.nuevoEmbarque('06', '0001419');
    expect(h.tomado).toMatchObject({ id: 'e1', folio: 'EMB-2026-00012' });
    const libre = await baseFalsa(tablas(), { paradas: PARADAS, sucursalNombre: 'x' }).svc.nuevoEmbarque('06', '0001419');
    expect(libre.tomado).toBeNull();
  });

  it('una guía que Kepler no tiene es 404', async () => {
    const { svc } = baseFalsa(tablas({ 'analytics.erp_shipment_trips': [] }), { paradas: [] });
    await expect(svc.nuevoEmbarque('06', '9999999')).rejects.toThrow(NotFoundException);
  });
});
