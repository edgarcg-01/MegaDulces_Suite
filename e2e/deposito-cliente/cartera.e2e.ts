import { test, expect, type Page, type Route, type BrowserContext } from '@playwright/test';

/**
 * `[CXC.44]` + `[CC.20.2]` El botón «Enviar estado de cuenta» de Cartera, en la computadora de Cobranza.
 *
 *   · CON enlace: abre `wa.me/52<teléfono>` con el mensaje que dice que el PDF está en su enlace (con el dominio
 *     público, nunca la IP de la oficina), NO descarga el PDF, lo dice, y deja constancia del contacto;
 *   · SIN enlace: el mensaje dice «Le adjuntamos el PDF» y el PDF se pide UNA vez aunque se dé doble clic.
 *
 * ⛔ La API es toda de la prueba; `wa.me` también (ninguna pestaña sale a internet).
 */

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const SESION = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  sub: 'u-e2e', username: 'e2e', rol: 'cobranza', tenant_id: '00000000-0000-0000-0000-00000000d01c',
  exp: 4102444800, permissions: { FINANCE_RECEIVABLES_VER: true },
})}.firma-de-prueba`;
const ENLACE = 'https://megadulcessuite.com/deposito/TOKEN-E2E';

const aging = { por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 885388.55 };
const CLI = {
  sucursal: '01', cliente_code: 'C1093', cliente_nombre: 'BOLSAS DE PRUEBA', rfc: null, vendedor: null,
  cuenta_kind: 'cliente_final', cuenta_kind_source: 'codigo', vendedor_nombre: null, grupo: null, zona: null,
  telefono: '3314855906', limite_credito: null, dias_credito: null, uso_linea: null, sobre_linea: false,
  saldo: 885388.55, vencido: 885388.55, n_partidas: 4, n_saldadas: 0, aging, sin_documento: 0, saldo_a_favor: 0,
  dias_pago_prom: null, n_pagos: 0,
};
const tipos = { cliente_final: { saldo: 885388.55, vencido: 885388.55, clientes: 1 }, interno: { saldo: 0, vencido: 0, clientes: 0 }, ruta: { saldo: 0, vencido: 0, clientes: 0 } };
const LISTA = {
  hoy: '2026-11-18',
  freshness: { status: 'fresh', stale: false, age_human: '1 min', data_as_of: '2026-11-18T12:00:00Z', inputs: [] },
  kpi: { total_saldo: 885388.55, total_vencido: 885388.55, n_clientes: 1, n_partidas: 4, n_sobre_linea: 0, total_a_favor: 0, n_a_favor: 0, aging, sin_documento: { monto: 0, clientes: 0 }, por_tipo: tipos },
  clientes: [CLI], total_clientes: 1,
  resumen: {
    hoy: '2026-11-18', saldo_total: 885388.55, vencido_total: 885388.55, pct_vencido: 100, dso: null, ventas_90d: 0, n_clientes: 1, pago: null,
    concentracion: { top10_pct: 0, top10: [] }, proyeccion: { vencido: 0, d0_7: 0, d8_15: 0, d16_30: 0, d30_plus: 0, sin_fecha: 0 },
    por_vendedor: [], por_zona: [], base_rollups: 'documento', sin_documento: { monto: 0, clientes: 0 },
  },
  filtros: { sucursales: [], grupos: [], zonas: [], vendedores: [], cuentas: [] },
};
const PARTIDA = { tipo: 'factura', folio_digital: '01UD0801-0001616', folio: '0001616', fecha: '2026-09-16', vence: '2026-10-17', importe: 221347.14, saldo: 221347.14, dias_vencido: 32, estado: 'vencida' };
const DETALLE = {
  hoy: '2026-11-18',
  cliente: { sucursal: '01', cliente_code: 'C1093', cliente_nombre: 'BOLSAS DE PRUEBA', rfc: null, vendedor: null, vendedor_nombre: null, grupo: null, zona: null, telefono: '3314855906', limite_credito: null, dias_credito: null },
  saldo: 885388.55, vencido: 885388.55, saldo_a_favor: 0, dias_pago_prom: null, n_pagos: 0, pagadas: 0, importe_pagado: 0,
  partidas: [PARTIDA], abonos: [], compromisos: [], cobranza: null, sin_documento: 0,
};
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

let fugas: string[] = [];
let pdfPedidos = 0;
let contactos: unknown[] = [];
let wa: string[] = [];

async function abrir(page: Page, context: BrowserContext, o: { enlace: boolean }) {
  const json = (r: Route, status: number, body: unknown) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  // WhatsApp no sale a internet: la pestaña se contesta aquí y se anota su URL.
  await context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) => { wa.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>wa</p>' }); });
  await page.routeWebSocket(/socket\.io/, (ws) => ws.close());
  await page.route(/\/socket\.io\//, (r) => r.abort());
  await page.route('**/api/**', (r) => {
    const req = r.request();
    const ruta = new URL(req.url()).pathname.replace(/^\/api\//, '');
    const m = req.method();
    if (m === 'GET') {
      if (ruta === 'users/me/access') return json(r, 200, { permissions: { FINANCE_RECEIVABLES_VER: true } });
      if (ruta === 'finance/receivables') return json(r, 200, LISTA);
      if (ruta === 'finance/receivables/01/C1093') return json(r, 200, DETALLE);
      if (ruta === 'finance/receivables/01/C1093/estado-de-cuenta.pdf') { pdfPedidos++; return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }); }
      // Lo demás de la pantalla (tendencia, filtros…) no es de esta prueba: se declara «no se pudo leer», no se inventa.
      return json(r, 404, {});
    }
    if (m === 'POST' && ruta === 'finance/collections/clientes/enlace') return o.enlace ? json(r, 201, { url: ENLACE }) : json(r, 500, { message: 'sin enlace' });
    if (m === 'POST' && ruta === 'finance/receivables/01/C1093/contact') { contactos.push(req.postDataJSON()); return json(r, 201, { id: 'k1', canal: 'whatsapp', contacted_at: '2026-11-18T18:00:00Z' }); }
    if (m === 'POST' && ruta === 'telemetry/suite') return r.fulfill({ status: 204 });
    fugas.push(`${m} ${ruta}`);
    return r.abort();
  });
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t); } catch { /* */ } }, SESION);
  await page.goto('/finanzas/cartera');
  const fila = page.locator('tr.ct-row', { hasText: 'BOLSAS DE PRUEBA' });
  await expect(fila).toBeVisible({ timeout: 45_000 });
  await fila.click();
  const boton = page.getByTestId('enviar-estado-cuenta');
  await expect(boton).toBeVisible();
  return boton;
}

test.beforeEach(() => { fugas = []; pdfPedidos = 0; contactos = []; wa = []; });
test.afterEach(() => {
  expect(fugas, '⛔ la pantalla pidió algo que la prueba no contesta (en local eso iría a PROD)').toEqual([]);
});

test.describe('[CC.20.2] «Enviar estado de cuenta» en Cartera', () => {
  test('CON enlace: el mensaje dice que el PDF está en su enlace (dominio público), no descarga nada y lo dice', async ({ page, context }) => {
    const boton = await abrir(page, context, { enlace: true });
    await expect(boton).toContainText('PDF y depósitos en su enlace');
    const href = decodeURIComponent((await boton.getAttribute('href')) || '');
    expect(href).toMatch(/^https:\/\/wa\.me\/523314855906\?text=/);
    expect(href).toContain('En su enlace personal puede descargar el PDF');
    expect(href).toContain(ENLACE);
    expect(href).not.toContain('192.168.');
    expect(href).not.toContain('Le adjuntamos');
    expect(href).not.toContain('le avisamos');
    const [chat] = await Promise.all([context.waitForEvent('page'), boton.click()]);
    await chat.waitForLoadState().catch(() => undefined);
    await expect(page.getByText('El estado de cuenta en PDF va en su enlace')).toBeVisible();
    await expect.poll(() => contactos.length).toBe(1);
    expect(pdfPedidos, 'con enlace no se descarga el PDF').toBe(0);
    expect(wa.some((u) => u.startsWith('https://wa.me/523314855906'))).toBeTruthy();
    await page.screenshot({ path: `${__dirname}/.resultados/cartera-con-enlace.png` });
  });

  test('SIN enlace: «Le adjuntamos el PDF» y el PDF se pide UNA vez aunque se dé doble clic', async ({ page, context }) => {
    const boton = await abrir(page, context, { enlace: false });
    await expect(boton).toContainText('con el PDF para adjuntar');
    const href = decodeURIComponent((await boton.getAttribute('href')) || '');
    expect(href).toContain('Le adjuntamos el PDF');
    await boton.dblclick();
    await expect(page.getByText('Se descargó el estado de cuenta')).toBeVisible({ timeout: 15_000 });
    expect(pdfPedidos).toBe(1);
  });
});
