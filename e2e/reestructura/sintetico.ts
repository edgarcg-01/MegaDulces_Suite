import type { Page, Request } from '@playwright/test';

/**
 * `[GP.RF.38]` Surtir con una API SINTÉTICA: ninguna petición sale del navegador (ni a prod ni al
 * backend local). Sirve para medir COMPORTAMIENTO de la pantalla (foco, historial, barras fijas,
 * teclado, alto contraste) sin sesión real y sin datos del negocio — el repo es público.
 *
 * Todo es inventado: «Sucursal de prueba», «Vendedora Prueba Uno», «Abarrotes Prueba 01»…
 * La FORMA sí es la de los contratos (`libs/contracts/src/http/presale-picking.contract.ts`).
 *
 * Lo que este modo NO puede decir: tiempos de red, volúmenes reales, ni si prod manda tal campo.
 */

const YO = 'u-prueba';
const B64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Un JWT sin firma válida: el frontend lo decodifica, no lo verifica; ningún servidor lo ve. */
export function tokenSintetico(): string {
  const ahora = Math.floor(Date.now() / 1000);
  return `${B64({ alg: 'HS256', typ: 'JWT' })}.${B64({ sub: YO, role_name: 'superadmin', rol: 'superadmin', name: 'Surtidor de prueba', iat: ahora, exp: ahora + 86_400 })}.sin-firma`;
}

export const ALMACEN_SINTETICO = 'w-prueba-1';

const hoyMx = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const masDias = (iso: string, n: number): string => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const VENDEDORES = ['Vendedora Prueba Uno', 'Vendedor Prueba Dos', 'Vendedora Prueba Tres', 'Vendedor Prueba Cuatro', 'Vendedora Prueba Cinco'];

function bandeja() {
  const hoy = hoyMx();
  const data: Array<Record<string, unknown>> = [];
  let k = 0;
  const pedido = (bucket: string, dias_atraso: number, fecha: string, extra: Record<string, unknown> = {}) => {
    k++;
    data.push({
      order_id: `o-prueba-${String(k).padStart(2, '0')}`, code: `PV-PRUEBA-${String(k).padStart(3, '0')}`,
      customer_name: `Abarrotes Prueba ${String(k).padStart(2, '0')}`, seller_name: VENDEDORES[k % VENDEDORES.length],
      warehouse_id: ALMACEN_SINTETICO, warehouse_name: 'Sucursal de prueba Norte', requested_delivery_date: fecha, bucket,
      days_late: dias_atraso, arrived_at: new Date(Date.now() - (60 - k) * 60_000).toISOString(), lines: 3 + ((k * 7) % 14),
      total: 500 + ((k * 1379) % 9000), state: 'nuevo', started: null, finished: null, unseen: false, instructions: null, ...extra,
    });
  };
  for (let i = 0; i < 16; i++) pedido('hoy', 0, hoy, i === 3 ? { instructions: 'Entregar por la puerta de atrás.' } : {});
  // Uno que YA estoy surtiendo y uno que surte otra persona.
  data[0] = { ...data[0], state: 'surtiendo', started: { user_id: YO, name: 'Surtidor de prueba', at: new Date().toISOString() } };
  data[1] = { ...data[1], state: 'surtiendo', started: { user_id: 'u-otro', name: 'Otra Persona', at: new Date().toISOString() } };
  for (let d = 1; d <= 4; d++) pedido('hoy', d, masDias(hoy, -d));
  for (let i = 0; i < 3; i++) pedido('manana', 0, masDias(hoy, 1));
  for (let i = 0; i < 2; i++) pedido('proximos', 0, masDias(hoy, 3));
  const counts: Record<string, number> = {};
  for (const p of data) counts[p['bucket'] as string] = (counts[p['bucket'] as string] ?? 0) + 1;
  return { today: hoy, counts, data, scope: 'todos' };
}

function detalle(orderId: string) {
  const fila = bandeja().data.find((p) => p['order_id'] === orderId) ?? bandeja().data[2];
  const lines = Array.from({ length: 14 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const caja = i % 3 !== 2;
    return {
      line_id: `l-${orderId}-${n}`, product_id: `p-prueba-${n}`, sku: `PR-0${n}`, barcode: `75000000000${n}`,
      product_name: `Producto de prueba ${n} ${caja ? 'caja con 24 piezas' : 'pieza suelta'}`,
      qty: 1 + (i % 5), unit: caja ? 'CJA' : 'PZA', factor: caja ? 24 : 1, picked: null,
      presentaciones: [{ unit: caja ? 'CJA' : 'PZA', codigos: [`75000000000${n}`] }],
      ubicacion: i === 5 ? null : { code: `BA0${n}`, orden: i + 1 },
    };
  });
  return { order: { ...fila, state: 'surtiendo', started: { user_id: YO, name: 'Surtidor de prueba', at: new Date().toISOString() } }, lines, justifications: [] };
}

/** [GP.RF.16][GP.RF.21] El Tablero de pedidos: 3 de Kepler y 2 de preventa, con sus conteos por origen. */
function tablero(origen: string | null) {
  const hoy = hoyMx();
  const fila = (n: number, o: Record<string, unknown>) => ({
    clave: `01-1-000${n}`, sucursal: '01', sucursal_nombre: 'Sucursal de prueba Norte', serie: 1, folio: `000${n}`, documento: `UD4001-000${n}`,
    fecha: hoy, hora: '10:15', origen: 'TELEMARK', estatus: 'AUTORIZADO', estatus_kepler: 'AUTORIZADO', cliente_code: `C${n}`,
    destino_nombre: `Abarrotes Prueba ${n}`, destino_ciudad: 'Ciudad de prueba', vendedor_code: '00021', vendedor_nombre: 'Vendedor Prueba Dos',
    renglones: 4 + n, volumen: [{ unidad: 'CJA', cantidad: 3 + n }], importe: 1000 + n * 37, guia: null, transporte: null, chofer: null,
    resp_surtido: null, resp_checado: null, resp_embarque: null, horas_abierto: 5, etapa: 'autorizado', etapa_fuente: 'kepler', desfase: null, order_id: null, ...o,
  });
  const todas = [fila(1, {}), fila(2, { origen: 'SUCURSAL' }), fila(3, {}),
    fila(4, { clave: '01-PD-PD-000004', folio: 'PD-000004', documento: 'PD-000004', origen: 'PREVENTA', estatus: null, estatus_kepler: null, etapa: 'surtiendo', order_id: 'o-prueba-04' }),
    fila(5, { clave: '01-PD-PD-000005', folio: 'PD-000005', documento: 'PD-000005', origen: 'PREVENTA', estatus: null, estatus_kepler: null, etapa: 'autorizado', order_id: 'o-prueba-05' })];
  const items = origen ? todas.filter((x) => x.origen === origen) : todas;
  return {
    periodo: { from: hoy.slice(0, 8) + '01', to: hoy }, alcance: { todas: true, sucursales: [] },
    filtros: { estatus: [], etapa: [], origen, sucursal: null, q: null, preventa: true },
    conteos: [{ estatus: 'AUTORIZADO', pedidos: 2, renglones: 12, mas_antiguo_horas: 5 }, { estatus: 'SURTIDO', pedidos: 0, renglones: 0, mas_antiguo_horas: null }],
    conteos_etapa: [{ etapa: 'autorizado', pedidos: 4, con_desfase: 0 }, { etapa: 'surtiendo', pedidos: 1, con_desfase: 0 }],
    conteos_origen: [{ origen: 'PREVENTA', pedidos: 2 }, { origen: 'SUCURSAL', pedidos: 1 }, { origen: 'TELEMARK', pedidos: 2 }],
    totales: { pedidos: items.length, renglones: 30, importe: 5500, mas_antiguo_horas: 5 },
    items, truncado: false, pagina: { offset: 0, limit: 50, total: items.length }, sucursales_periodo: [{ codigo: '01', nombre: 'Sucursal de prueba Norte' }],
    generado_en: new Date().toISOString(),
  };
}
const ATORADOS_SINTETICOS = {
  ventana_desde: masDias(hoyMx(), -7), hasta: masDias(hoyMx(), -8), pedidos: 396, desde: '2025-11-29',
  sucursales: [{ codigo: '05', nombre: 'Zamora Centro', pedidos: 288, desde: '2026-03-19' }, { codigo: '06', nombre: 'Canindo', pedidos: 59, desde: '2026-08-15' }, { codigo: '02', nombre: 'Morelia Abastos', pedidos: 49, desde: '2025-11-29' }],
};

/** [GP.RF.12] Revisión en caja de la preventa: 5 pedidos por revisar y su detalle (completos, con faltante y con sobrante). */
function revisionBandeja() {
  const hoy = hoyMx();
  const data = [1, 2, 3, 4, 5].map((k) => ({
    order_id: `o-rev-${k}`, code: `PV-REV-00${k}`, customer_name: `Abarrotes Revisión ${k}`, seller_name: VENDEDORES[k % VENDEDORES.length],
    warehouse_name: 'Sucursal de prueba Norte', requested_delivery_date: hoy, lines: 4 + k, total: 900 + k * 211,
    finished: { user_id: 'u-surt', name: 'Surtidor de prueba', at: new Date(Date.now() - k * 600_000).toISOString() },
    pick_outcome: k % 2 ? 'con_faltantes' : 'completo', state: 'por_revisar', reviewed: null, group_code: null, instructions: k === 2 ? 'Entregar antes de las 10.' : null,
  }));
  return { today: hoy, pending: data.length, truncated: false, data, scope: 'todos' };
}
function revisionDetalle(orderId: string) {
  const fila = revisionBandeja().data.find((x) => x.order_id === orderId) ?? revisionBandeja().data[0];
  const linea = (n: number, ordered: number, picked: number) => ({
    key: `k-${n}`, product_id: `p-rev-${n}`, product_name: `Producto de revisión ${n} caja con 24 piezas`, sku: `RV-0${n}`, unit: 'CJA', factor: 24,
    ordered, picked, restorable: picked < ordered, stock: { state: 'ok', qty: 12, checked_at: new Date().toISOString() }, substitutes_for: null,
  });
  return { order: fila, lines: [linea(1, 5, 5), linea(2, 3, 1), linea(3, 2, 2), linea(4, 4, 0), linea(5, 1, 2)], justifications: [] };
}

export type RegistroSintetico = { servidas: number; abortadas: string[]; desconocidas: string[]; salieron: string[] };

/** Contesta TODA la API desde aquí. Control: cualquier /api que no pasó por aquí queda en `salieron`. */
export async function servirSintetico(page: Page): Promise<RegistroSintetico> {
  const reg: RegistroSintetico = { servidas: 0, abortadas: [], desconocidas: [], salieron: [] };
  const atendidas = new WeakSet<Request>();
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async (r) => {
    const q = r.request(); atendidas.add(q);
    const u = new URL(q.url()); const p = u.pathname.replace(/^.*?\/api\//, '/');
    if (q.method() === 'POST' && /^\/warehouse\/presale-picking\/[^/]+\/start$/.test(p)) {
      reg.servidas++; return r.fulfill(json({ ...bandeja().data[2], state: 'surtiendo' }));
    }
    if (q.method() !== 'GET') { reg.abortadas.push(`${q.method()} ${p}`); return r.abort('blockedbyclient'); }
    reg.servidas++;
    if (p === '/reparto/surtido/almacenes') return r.fulfill(json([
      { id: ALMACEN_SINTETICO, code: '91', nombre: 'Sucursal de prueba Norte' },
      { id: 'w-prueba-2', code: '92', nombre: 'Sucursal de prueba Sur' },
    ]));
    if (p === '/warehouse/presale-picking') return r.fulfill(json(bandeja()));
    if (p === '/warehouse/presale-picking/routes') return r.fulfill(json({ today: hoyMx(), scope: 'todos', data: [] }));
    const m = /^\/warehouse\/presale-picking\/([^/]+)$/.exec(p);
    if (m) return r.fulfill(json(detalle(m[1])));
    if (p === '/reparto/surtido/waves/mine') return r.fulfill(json([]));
    if (p === '/warehouse/new-customers/summary') return r.fulfill(json({ scope: 'todos', customers: 12, order_ids: ['o-prueba-05'], truncated: false }));
    if (p === '/users/me/access') return r.fulfill(json({ permissions: {} }));
    if (p === '/warehouse/orders') return r.fulfill(json(tablero(u.searchParams.get('origin'))));
    if (p === '/warehouse/orders/atorados') return r.fulfill(json(ATORADOS_SINTETICOS));
    if (p === '/warehouse/presale-review') return r.fulfill(json(revisionBandeja()));
    const rv = /^\/warehouse\/presale-review\/([^/]+)$/.exec(p);
    if (rv && rv[1] !== 'search') return r.fulfill(json(revisionDetalle(rv[1])));
    reg.desconocidas.push(p);
    return r.fulfill(json({ data: [] }));
  });
  await page.route('**/socket.io/**', (r) => { atendidas.add(r.request()); reg.abortadas.push('WS'); return r.abort('blockedbyclient'); });
  const revisar = (q: Request) => { if (!atendidas.has(q) && /\/(api|socket\.io)\//.test(new URL(q.url()).pathname)) reg.salieron.push(`${q.method()} ${new URL(q.url()).pathname}`); };
  page.on('requestfinished', revisar);
  page.on('requestfailed', revisar);
  return reg;
}
