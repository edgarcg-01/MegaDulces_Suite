import { MktRankingService } from './mkt-ranking.service';
import { vendedorDeRuta, CANAL_TEXTO } from './mkt-ranking.logic';

/**
 * `[MKT.28]` Vecinal, Rutas y Telemarketing por VENDEDOR: Kepler guarda la ruta (`1V001`, a veces con
 * nombre «RUTA VECINAL …»), no a la persona. `[MKT.29]` El nombre sale de `rutas/quien-trabaja-la-ruta`
 * (comisión → asignación → Kepler) y Rutas lleva cada CAMIONETA con su venta del push.
 * La base se simula: cada consulta se reconoce por la tabla que lee.
 */

type Fila = Record<string, unknown>;
interface Fake {
  semana: Fila[];
  ventas?: Fila[];
  asignados?: Array<{ sucursal: string | null; codigo: string | null; etiqueta: string; nombre: string | null; dias: number }>;
  comision?: Array<{ ruta: string; nombre: string }>;
  asignacionTruena?: boolean;
  /** Push de camionetas: primera venta (promos vigentes), venta de la semana e historia semanal. */
  camionetasPrimera?: Fila[];
  camionetasVenta?: Fila[];
  camionetasHistoria?: Fila[];
}

function fakeTrx(f: Fake) {
  const consultas: string[] = [];
  const raw = (sql: string, params: unknown[] = []) => {
    consultas.push(sql);
    if (/daily_assignments/.test(sql)) {
      if (f.asignacionTruena) return Promise.reject(new Error('permission denied for table daily_assignments'));
      return Promise.resolve({ rows: f.asignados ?? [] });
    }
    if (/commission_route_config/.test(sql)) return Promise.resolve({ rows: f.comision ?? [] });
    if (/mv_kepler_vecinal_monthly/.test(sql)) return Promise.resolve({ rows: [] });
    if (/v_route_sales_lines/.test(sql)) {
      if (/min\(sl\.business_date\)/.test(sql)) return Promise.resolve({ rows: f.camionetasPrimera ?? [] });
      if (/date_trunc\('week', sl\.business_date\)/.test(sql)) return Promise.resolve({ rows: f.camionetasHistoria ?? [] });
      if (/array_agg\(DISTINCT sl\.producto\)/.test(sql)) return Promise.resolve({ rows: f.camionetasVenta ?? [] });
      return Promise.resolve({ rows: [] });
    }
    if (/FROM catalog\.products/.test(sql) && /GROUP BY 1/.test(sql)) {
      return Promise.resolve({ rows: [{ code: '09003', nombre: '5 EXH CANELS = GRATIS 1' }] });
    }
    if (/v_kepler_sales_lines/.test(sql) && /min\(business_date\)/.test(sql)) {
      const canales = params[params.length - 1] as string[];
      return Promise.resolve({ rows: f.semana.filter((r) => canales.includes(String(r['canal']))) });
    }
    if (/v_kepler_sales_lines/.test(sql) && /array_agg\(DISTINCT producto\)/.test(sql)) return Promise.resolve({ rows: f.ventas ?? [] });
    return Promise.resolve({ rows: [] });
  };
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['whereNull', 'whereNotNull', 'select', 'orderBy', 'whereBetween', 'whereIn', 'where']) b[m] = () => b;
    b['first'] = () => Promise.resolve(undefined);
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve([]).then(ok, ko);
    return b;
  };
  const trx = Object.assign(() => builder(), { raw, fn: { now: () => 'now()' } });
  return { trx, consultas };
}

function svcCon(trx: unknown) {
  const svc = new MktRankingService(
    { run: (fn: (t: unknown) => unknown) => fn(trx) } as never,
    { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).productosConCache = () => Promise.resolve(new Map());
  return svc;
}

const semana = [{ canal: 'preventa', sku: '09003', warehouse_code: '01', primera: new Date('2026-11-10T00:00:00Z') }];
const venta = (vendor: string, nombre: string, qty: number, wh = '01') =>
  ({ warehouse_code: wh, vendor_code: vendor, vendor_name: nombre, sku: '09003', qty, descripciones: [] });
const ligada = (codigo: string, nombre: string, dias: number, sucursal = '01') => ({ sucursal, codigo, etiqueta: 'RUTA VECINAL', nombre, dias });
const porEtiqueta = (etiqueta: string, nombre: string, dias: number) => ({ sucursal: null, codigo: null, etiqueta, nombre, dias });
// Una camioneta que vendió el código esta semana (push).
const camioneta = (ruta: string, qty: number, wh = '06') =>
  ({ warehouse_code: wh, vendor_code: `ruta:${ruta}`, vendor_name: `Ruta ${ruta}`, sku: '09003', qty, descripciones: [] });
const primeraCamioneta = (wh = '06') => ({ canal: 'ruta', sku: '09003', warehouse_code: wh, primera: new Date('2026-11-10T00:00:00Z'), en_ventana: true });

describe('[MKT.28] vendedorDeRuta: a quién se nombra por una ruta', () => {
  it('la persona con más días; las demás como apoyo', () => {
    expect(vendedorDeRuta([{ nombre: 'APOYO B', dias: 1 }, { nombre: 'TITULAR A', dias: 6 }]))
      .toEqual({ principal: 'TITULAR A', otros: ['APOYO B'] });
  });
  it('empate: por nombre, para que no cambie entre consultas', () => {
    expect(vendedorDeRuta([{ nombre: 'ZETA', dias: 3 }, { nombre: 'ALFA', dias: 3 }])?.principal).toBe('ALFA');
  });
  it('[negativa] nadie asignado (o sólo nombres vacíos) → null, no un nombre inventado', () => {
    expect(vendedorDeRuta([])).toBeNull();
    expect(vendedorDeRuta([{ nombre: '  ', dias: 6 }])).toBeNull();
  });
});

describe('[MKT.28] el ranking de Vecinal nombra a la persona, no a la ruta', () => {
  it('⭐ ruta ligada: el nombre es el de la persona asignada, con la ruta y el apoyo aparte', async () => {
    const { trx } = fakeTrx({
      semana, ventas: [venta('01:1V001', 'RUTA VECINAL CENTRO', 12)],
      asignados: [ligada('1V001', 'VENDEDORA DEMO', 6), ligada('1V001', 'APOYO DEMO', 1)],
    });
    const r = await svcCon(trx).ranking('2026-11-09', 'preventa');
    const p = r.participantes[0];
    expect(p.nombre).toBe('VENDEDORA DEMO');
    expect(p.vendedor_fuente).toBe('asignacion');
    expect(p.ruta).toBe('1V001');
    expect(p.otros_vendedores).toEqual(['APOYO DEMO']);
    expect(r.criterio).toContain('Kepler guarda la RUTA, no a la persona');
  });

  it('[MKT.29] con chofer en la comisión, manda la comisión y la persona asignada distinta SE VE', async () => {
    const { trx } = fakeTrx({
      semana, ventas: [venta('01:1V002', 'RUTA VECINAL NORTE', 4)],
      comision: [{ ruta: '1V002', nombre: 'CHOFER COMISION' }],
      asignados: [ligada('1V002', 'OTRA PERSONA', 6)],
    });
    const p = (await svcCon(trx).ranking('2026-11-09', 'preventa')).participantes[0];
    expect(p.nombre).toBe('CHOFER COMISION');
    expect(p.vendedor_fuente).toBe('comision');
    expect(p.otros_vendedores).toEqual(['OTRA PERSONA']);
  });

  it('[negativa] ruta sin ligar: queda el nombre de Kepler y lo DICE (fuente kepler), no se inventa persona', async () => {
    const { trx } = fakeTrx({ semana, ventas: [venta('01:30001', 'VENTA RUTA GENERAL', 5)], asignados: [] });
    const r = await svcCon(trx).ranking('2026-11-09', 'preventa');
    expect(r.participantes[0].nombre).toBe('VENTA RUTA GENERAL');
    expect(r.participantes[0].vendedor_fuente).toBe('kepler');
    expect(r.participantes[0].otros_vendedores).toEqual([]);
  });

  it('[negativa] si la asignación no se puede leer, el ranking sale igual con el nombre de Kepler', async () => {
    const { trx } = fakeTrx({ semana, ventas: [venta('01:1V001', 'RUTA VECINAL CENTRO', 12)], asignacionTruena: true });
    const r = await svcCon(trx).ranking('2026-11-09', 'preventa');
    expect(r.participantes[0].nombre).toBe('RUTA VECINAL CENTRO');
    expect(r.participantes[0].vendedor_fuente).toBe('kepler');
  });

  it('[negativa] una clave de Kepler «01:21» NO toma a la persona de la camioneta «RUTA 21» (liga por etiqueta)', async () => {
    const { trx } = fakeTrx({
      semana, ventas: [venta('01:21', 'VENDEDOR 21 KEPLER', 3)],
      asignados: [porEtiqueta('RUTA 21', 'CHOFER CAMIONETA', 6)],
    });
    const p = (await svcCon(trx).ranking('2026-11-09', 'preventa')).participantes[0];
    expect(p.nombre).toBe('VENDEDOR 21 KEPLER');
    expect(p.vendedor_fuente).toBe('kepler');
  });

  it('[control] en mostrador no se consulta quién trabaja las rutas ni las camionetas, y no hay ruta', async () => {
    const { trx, consultas } = fakeTrx({ semana: [{ ...semana[0], canal: 'mostrador' }], ventas: [] });
    const r = await svcCon(trx).ranking('2026-11-09', 'mostrador');
    expect(consultas.some((s) => /daily_assignments|commission_route_config/.test(s))).toBe(false);
    expect(consultas.some((s) => /v_route_sales_lines/.test(s))).toBe(false);
    expect(r.participantes.every((p) => p.ruta === null && p.vendedor_fuente === null)).toBe(true);
  });
});

describe('[MKT.29] Rutas: cada camioneta de ruta directa, con su venta y su chofer', () => {
  const rutas = { ...semana[0], canal: 'ruta', warehouse_code: '06' };

  it('⭐ cada camioneta es un participante con su venta del push; la clave de Kepler 06:30001 sigue (se suma, no se reemplaza)', async () => {
    const { trx } = fakeTrx({
      semana: [rutas], ventas: [venta('06:30001', 'SUCURSAL CANINDO PISO', 7, '06')],
      camionetasPrimera: [primeraCamioneta()],
      camionetasVenta: [camioneta('501', 9), camioneta('502', 2)],
      comision: [{ ruta: '501', nombre: 'CHOFER 501' }],
      asignados: [porEtiqueta('RUTA 502', 'CHOFER 502', 6)],
    });
    const r = await svcCon(trx).ranking('2026-11-09', 'ruta');
    const de = (clave: string) => r.participantes.find((p) => p.vendor_code === clave)!;
    expect(r.participantes.map((p) => p.vendor_code).sort()).toEqual(['06:30001', 'ruta:501', 'ruta:502']);
    expect(de('ruta:501')).toMatchObject({ nombre: 'CHOFER 501', vendedor_fuente: 'comision', ruta: '501', warehouse_code: '06' });
    expect(de('ruta:501').promos[0].venta).toBe(9);
    expect(de('ruta:502')).toMatchObject({ nombre: 'CHOFER 502', vendedor_fuente: 'asignacion', ruta: '502' });
    expect(de('06:30001')).toMatchObject({ nombre: 'SUCURSAL CANINDO PISO', vendedor_fuente: 'kepler' });
    expect(r.criterio).toContain('cada camioneta de ruta directa');
  });

  it('[negativa] camioneta sin chofer en la comisión ni en la Suite: «Ruta N» y lo DICE (sin_dato), no un nombre inventado', async () => {
    const { trx } = fakeTrx({ semana: [rutas], camionetasPrimera: [primeraCamioneta()], camionetasVenta: [camioneta('503', 4)] });
    const p = (await svcCon(trx).ranking('2026-11-09', 'ruta')).participantes[0];
    expect(p).toMatchObject({ nombre: 'Ruta 503', vendedor_fuente: 'sin_dato', ruta: '503', otros_vendedores: [] });
  });

  it('una promo que SÓLO vendieron las camionetas entra a Rutas (antes no existía para el ranking)', async () => {
    const { trx } = fakeTrx({ semana: [], camionetasPrimera: [primeraCamioneta('01')], camionetasVenta: [camioneta('21', 5, '01')] });
    const r = await svcCon(trx).ranking('2026-11-09', 'ruta');
    expect(r.promos_vigentes).toBe(1);
    expect(r.participantes[0]).toMatchObject({ vendor_code: 'ruta:21', warehouse_code: '01' });
  });

  it('el objetivo dinámico de una camioneta sale de SU historia del push (4 semanas previas)', async () => {
    const { trx } = fakeTrx({
      semana: [],
      camionetasPrimera: [{ ...primeraCamioneta(), primera: new Date('2026-10-20T00:00:00Z') }],
      camionetasVenta: [camioneta('504', 3)],
      camionetasHistoria: [
        { semana: '2026-10-19', warehouse_code: '06', canal: 'ruta', vendor_code: 'ruta:504', sku: '09003', qty: 4, vendor_name: 'Ruta 504' },
        { semana: '2026-10-26', warehouse_code: '06', canal: 'ruta', vendor_code: 'ruta:504', sku: '09003', qty: 6, vendor_name: 'Ruta 504' },
        { semana: '2026-11-02', warehouse_code: '06', canal: 'ruta', vendor_code: 'ruta:504', sku: '09003', qty: 8, vendor_name: 'Ruta 504' },
      ],
    });
    const p = (await svcCon(trx).ranking('2026-11-09', 'ruta')).participantes[0];
    expect(p.promos[0]).toMatchObject({ objetivo: 6, objetivo_fuente: 'dinamico', venta: 3 });
  });

  it('[control] Vecinal no lee las camionetas: el push es sólo de Rutas', async () => {
    const { trx, consultas } = fakeTrx({ semana, ventas: [venta('01:1V001', 'RUTA VECINAL CENTRO', 1)] });
    await svcCon(trx).ranking('2026-11-09', 'preventa');
    expect(consultas.some((s) => /v_route_sales_lines/.test(s))).toBe(false);
  });
});

describe('[MKT.28] el canal de mayoreo se llama Telemarketing', () => {
  it('como en el resto de la Suite', () => {
    expect(CANAL_TEXTO.mayoreo).toBe('Telemarketing (mayoreo)');
  });
});
