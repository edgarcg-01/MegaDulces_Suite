import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * `[LE.6.19]` La hoja de zona se paga en Caja General › Reposición, en un acto, y TODO lo que sale
 * del cajón se cuenta por pieza antes de pagar (PM, 2026-11-06).
 *
 * Lo que se afirma, en el navegador y con el bundle real de la pantalla:
 *   · la abierta es un renglón con «Pagar <zona>», sin cerrar ni aprobar aparte;
 *   · el pico que el cajón pone al retiro se CUENTA: sin conteo no sale la petición;
 *   · el retiro exacto paga directo, sin arqueo;
 *   · del cajón entero se cuenta el total;
 *   · lo que espera su aprobación no suma y lleva a Aprobación de gastos;
 *   · un 5xx reintenta con la MISMA llave (idempotencia), un 4xx no;
 *   · la ruta vieja `/finanzas/hoja-gastos` lleva a Caja General.
 *
 * ⛔ La API es toda de la prueba (ver `playwright.config.ts`): lo que no se contesta aquí se
 * aborta y se reclama en `afterEach`. Ningún byte llega al backend local, que apunta a prod.
 */

// ── La sesión: un JWT que sólo lee el front (nadie lo valida: la API es de la prueba) ─────────────
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const sesion = (permisos: Record<string, boolean>) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: 'u-e2e', username: 'e2e', rol: 'finanzas', tenant_id: '00000000-0000-0000-0000-00000000d01c',
    exp: 4102444800, permissions: permisos,
  })}.firma-de-prueba`;
const GESTIONA = { FINANCE_CAJA_VER: true, FINANCE_CAJA_GESTIONAR: true };

// ── Lo que contesta la API (espejo de `HojasDeGastos` / `ReposicionSucursales` / `PagoHojaResultado`) ──
const RENGLON = {
  origen_ref: '08|X-D-26|0000700|0011', sucursal: '08', doc_tipo: 'X-D-26', folio: '0000700', fecha_pago: '2026-10-29',
  fecha_captura: '2026-10-29', beneficiario: 'BOTANAS PAU', clave: 'CB013', centro: '007', clase: 'proveedor', importe: 83981.89,
};
const RETIRO = { device: 'AST700-19758', external_id: 1830, ref: 'gnf morelia', total: 83980, dia: '2026-10-30', cajon: 1.89 };
const ABIERTA = (extra: Record<string, unknown> = {}) => ({
  zona: 'morelia', nombre: 'Zona Morelia', desde: '2026-10-29', renglones: [RENGLON], total: 83981.89,
  por_sucursal: [], por_clase: [], fuera: [], pagados_aparte: [],
  instruccion: { retiro: 83980, cajon: 1.89, deposito: 83981.89, referencia: null }, datos_al: '2026-11-06T15:00:00Z',
  pagado_en_control: [], control_medido: true, detenidos: [], retiros_que_cuadran: [RETIRO],
  ya_repuestos: [], sin_deposito: [], banco: { cuenta: '1604', cargado_hasta: '2026-10-30' }, ...extra,
});
const HOJAS = (abiertas: unknown[]) => ({ abiertas, cerradas: [], instalada: true, datos_al: '2026-11-06T15:00:00Z', caos_al: '2026-11-06T15:00:00Z' });
const REPOSICION = {
  desde: '2026-10-30', hasta: '2026-11-06', grupos: [], retiros: [],
  datos_al: '2026-11-06T15:00:00Z', caos_al: '2026-11-06T15:00:00Z',
  universo: { sucursales: [], sin_documentos: [], excluidas: [] },
};
const PAGADA = {
  hoja: {
    id: 'h9', numero: 9, folio: 'HG-9', zona: 'morelia', nombre_zona: 'Zona Morelia', venta_del_dia: '2026-11-06', estado: 'pagada',
    total: 83981.89, renglones: [RENGLON], por_sucursal: [], cerrada_por: 'u-e2e', cerrada_por_nombre: 'e2e', cerrada_at: '2026-11-06T16:00:00Z',
    aprobada_por: null, aprobada_por_nombre: null, aprobada_at: null, resuelta_por_nombre: null, resuelta_at: null, motivo: null,
    instruccion: { retiro: 83980, cajon: 1.89, deposito: 83981.89, referencia: 'HG-9' }, retiros_que_cuadran: [], pago: null,
  },
  ligados: 0, capturados: 1, sin_capturar: [],
};

// ── La API de la prueba ───────────────────────────────────────────────────────────────────────
interface Pago { zona: string; body: { origen_refs: string[]; client_key: string; pago: Record<string, unknown> } }
let fugas: string[] = [];
let pagos: Pago[] = [];

/**
 * `hojas` es lo que devuelve `GET hoja-gastos` (se puede cambiar a media prueba: tras pagar, la abierta
 * ya no está); `alPagar` decide la respuesta de cada POST de pago.
 */
async function abrir(page: Page, o: { hojas: () => unknown; alPagar?: (n: number) => { status: number; body: unknown }; permisos?: Record<string, boolean> }) {
  const json = (r: Route, status: number, body: unknown) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  // El socket de alertas va al backend local por otra ruta: se corta antes de salir.
  await page.routeWebSocket(/socket\.io/, (ws) => ws.close());
  await page.route(/\/socket\.io\//, (r) => r.abort());
  await page.route('**/api/**', (r) => {
    const req = r.request();
    const ruta = new URL(req.url()).pathname.replace(/^\/api\//, '');
    if (req.method() === 'GET') {
      if (ruta === 'users/me/access') return json(r, 200, { permissions: o.permisos ?? GESTIONA });
      if (ruta === 'finance/hoja-gastos') return json(r, 200, o.hojas());
      if (ruta === 'finance/caja-reposicion') return json(r, 200, REPOSICION);
      // El resto de Caja General no es de esta prueba: se declara «no se pudo leer», no se inventa.
      return json(r, 404, {});
    }
    // La telemetría de uso (`analytics.ui_usage`) se contesta aquí: en local se escribiría en prod.
    if (req.method() === 'POST' && ruta === 'telemetry/suite') return r.fulfill({ status: 204 });
    const m = ruta.match(/^finance\/hoja-gastos\/abierta\/([^/]+)\/pagar$/);
    if (req.method() === 'POST' && m && o.alPagar) {
      pagos.push({ zona: decodeURIComponent(m[1]), body: req.postDataJSON() });
      const x = o.alPagar(pagos.length);
      return json(r, x.status, x.body);
    }
    fugas.push(`${req.method()} ${ruta}`);
    return r.abort();
  });
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t); } catch { /* */ } }, sesion(o.permisos ?? GESTIONA));
  await page.goto('/finanzas/caja-general');
}

/** Abre la ventana de Reposición desde su botón en la barra, como lo hace la persona. */
async function ventana(page: Page) {
  const boton = page.locator('.cg-repo-btn');
  await expect(boton).toBeVisible({ timeout: 30_000 });
  await boton.click();
  const v = page.locator('app-caja-reposicion .rp');
  await expect(v).toBeVisible();
  return v;
}
const dialogoConteo = (page: Page) => page.getByRole('dialog', { name: /arqueo de lo que sale del cajón/ });
const pieza = (page: Page, key: string) => page.locator(`[id="cc-${key}"]`);

test.beforeEach(() => { fugas = []; pagos = []; });
test.afterEach(() => {
  expect(fugas, '⛔ la pantalla pidió algo que la prueba no contesta (en local eso iría a PROD)').toEqual([]);
});

test.describe('[LE.6.19] la hoja de zona se paga en Reposición, en un acto', () => {
  test('la abierta es un renglón con «Pagar Zona Morelia» y el retiro que cuadra ya elegido', async ({ page }) => {
    await abrir(page, { hojas: () => HOJAS([ABIERTA()]) });
    await expect(page.locator('.cg-repo-btn')).toContainText('1 por resolver', { timeout: 30_000 });
    const v = await ventana(page);
    await expect(v).toContainText('Zona Morelia');
    await expect(v).toContainText('$83,981.89');
    await expect(v).toContainText('Cuadra «gnf morelia» del 30/10/26; el cajón pone $1.89 y se cuenta al pagar.');
    await expect(v.getByRole('button', { name: 'Pagar Zona Morelia' })).toBeEnabled();
    // Nadie la cierra ni la aprueba aparte.
    await expect(v).not.toContainText('la cierra la zona');
    await expect(v.getByRole('button', { name: /Aprobar|Cerrar la hoja/ })).toHaveCount(0);
  });

  test('⭐ el pico del cajón se CUENTA antes de pagar: sin conteo no sale la petición', async ({ page }) => {
    let estado = HOJAS([ABIERTA()]);
    await abrir(page, { hojas: () => estado, alPagar: () => { estado = HOJAS([]); return { status: 201, body: PAGADA }; } });
    const v = await ventana(page);
    await v.getByRole('button', { name: 'Pagar Zona Morelia' }).click();

    const d = dialogoConteo(page);
    await expect(d).toBeVisible();
    await expect(d).toContainText('$1.89');
    const pagar = d.getByRole('button', { name: 'Pagar Zona Morelia' });
    await expect(pagar, 'con el conteo vacío no se puede pagar').toBeDisabled();
    expect(pagos).toHaveLength(0);

    // Un conteo que no cuadra tampoco paga.
    await pieza(page, '1').fill('2');
    await pieza(page, '1').blur();
    await expect(pagar, 'contó $2 y salen $1.89: no debe dejar pagar').toBeDisabled();

    await pieza(page, '1').fill('1');
    await pieza(page, '0.5').fill('1');
    await page.locator('[id="cc-morralla"]').fill('0.39');
    await page.locator('[id="cc-morralla"]').blur();
    await expect(pagar).toBeEnabled();
    await pagar.click();

    await expect.poll(() => pagos.length).toBe(1);
    expect(pagos[0].zona).toBe('morelia');
    expect(pagos[0].body.origen_refs).toEqual(['08|X-D-26|0000700|0011']);
    expect(pagos[0].body.client_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(pagos[0].body.pago).toEqual({
      medio: 'caos', device: 'AST700-19758', external_id: 1830,
      conteo: { piezas: { '1': 1, '0.5': 1 }, morralla: 0.39 },
    });
    await expect(d).toBeHidden();
    await expect(page.getByText('Zona Morelia: HG-9 pagada')).toBeVisible();
    // Releyó: la hoja pagada ya no está por resolver.
    await expect(v.getByRole('button', { name: 'Pagar Zona Morelia' })).toHaveCount(0);
  });

  test('si el retiro la cubre entera no hay nada que contar: paga directo', async ({ page }) => {
    const exacto = { ...RETIRO, total: 83981.89, cajon: 0 };
    await abrir(page, { hojas: () => HOJAS([ABIERTA({ retiros_que_cuadran: [exacto] })]), alPagar: () => ({ status: 201, body: PAGADA }) });
    const v = await ventana(page);
    await expect(v).toContainText('Cuadra «gnf morelia» del 30/10/26.');
    await v.getByRole('button', { name: 'Pagar Zona Morelia' }).click();
    await expect.poll(() => pagos.length).toBe(1);
    await expect(dialogoConteo(page)).toHaveCount(0);
    expect(pagos[0].body.pago).toEqual({ medio: 'caos', device: 'AST700-19758', external_id: 1830 });
  });

  test('del cajón entero: se cuenta el TOTAL, y el pago va como medio cajón con su conteo', async ({ page }) => {
    const chica = ABIERTA({ renglones: [{ ...RENGLON, importe: 650 }], total: 650, retiros_que_cuadran: [],
      instruccion: { retiro: 650, cajon: 0, deposito: 650, referencia: null } });
    await abrir(page, { hojas: () => HOJAS([chica]), alPagar: () => ({ status: 201, body: PAGADA }) });
    const v = await ventana(page);
    await expect(v).toContainText('Ningún retiro libre cuadra');
    const pagar = v.getByRole('button', { name: 'Pagar Zona Morelia' });
    await expect(pagar, 'sin retiro elegido no se paga').toBeDisabled();

    await v.getByRole('combobox', { name: 'Con qué se paga la reposición de Zona Morelia' }).click();
    await page.getByRole('option', { name: 'Del cajón entero (sin retiro)' }).click();
    await pagar.click();

    const d = dialogoConteo(page);
    await expect(d).toContainText('$650.00');
    await pieza(page, '500').fill('1');
    await pieza(page, '100').fill('1');
    await pieza(page, '50').fill('1');
    await pieza(page, '50').blur();
    await d.getByRole('button', { name: 'Pagar Zona Morelia' }).click();
    await expect.poll(() => pagos.length).toBe(1);
    expect(pagos[0].body.pago).toEqual({ medio: 'cajon', conteo: { piezas: { '500': 1, '100': 1, '50': 1 }, morralla: 0 } });
  });

  test('lo que espera su aprobación no suma, se ve con su motivo y lleva a Aprobación de gastos', async ({ page }) => {
    const detenido = { ...RENGLON, origen_ref: '08|X-D-26|0000701|0011', folio: '0000701', importe: 480, motivo: 'El gasto todavía no lo aprueba nadie' };
    await abrir(page, { hojas: () => HOJAS([ABIERTA({ detenidos: [detenido] })]), permisos: { ...GESTIONA, FINANCE_EXPENSES_COMPROBAR: true } });
    const v = await ventana(page);
    const enlace = v.getByRole('link', { name: /1 pago espera su aprobación/ });
    await expect(enlace).toHaveAttribute('href', '/finanzas/aprobacion-gastos');
    // El total por resolver es el de lo autorizado: el detenido ($480) no se suma.
    await expect(v.locator('.rp-cifra').first()).toContainText('$83,981.89');

    await v.getByRole('button', { name: 'Ver el desglose de la reposición de Zona Morelia' }).click();
    const tabla = v.getByTestId('rp-detenidos');
    await expect(tabla).toContainText('X-D-26 0000701');
    await expect(tabla).toContainText('El gasto todavía no lo aprueba nadie');

    await enlace.click();
    await expect(page).toHaveURL(/\/finanzas\/aprobacion-gastos/);
  });

  // `[LE.6.20]` Un enlace afirma que la otra pantalla se puede abrir: quien no aprueba gastos caía en «sin acceso».
  test('⛔ sin permiso de aprobar gastos no hay enlace a Aprobación: se dice en texto', async ({ page }) => {
    const detenido = { ...RENGLON, origen_ref: '08|X-D-26|0000701|0011', folio: '0000701', importe: 480, motivo: 'El gasto todavía no lo aprueba nadie' };
    await abrir(page, { hojas: () => HOJAS([ABIERTA({ detenidos: [detenido] })]) });
    const v = await ventana(page);
    await expect(v).toContainText('1 pago espera su aprobación en Aprobación de gastos y no entra.');
    await expect(v.getByRole('link', { name: /Aprobación de gastos/ })).toHaveCount(0);
  });

  test('sin permiso de gestionar la caja: se ve, pero no se paga', async ({ page }) => {
    await abrir(page, { hojas: () => HOJAS([ABIERTA()]), permisos: { FINANCE_CAJA_VER: true } });
    const v = await ventana(page);
    await expect(v).toContainText('La paga quien gestiona la caja.');
    await expect(v.getByRole('button', { name: 'Pagar Zona Morelia' })).toHaveCount(0);
  });
});

test.describe('[LE.6.19] el reintento no paga dos veces', () => {
  test('un 5xx reintenta con la MISMA llave; el servidor es el que deduplica', async ({ page }) => {
    const exacto = { ...RETIRO, total: 83981.89, cajon: 0 };
    await abrir(page, {
      hojas: () => HOJAS([ABIERTA({ retiros_que_cuadran: [exacto] })]),
      alPagar: (n) => (n === 1 ? { status: 503, body: { message: 'se cayó a media escritura' } } : { status: 201, body: PAGADA }),
    });
    const v = await ventana(page);
    const pagar = v.getByRole('button', { name: 'Pagar Zona Morelia' });
    await pagar.click();
    await expect(page.getByText('No se pagó la reposición de Zona Morelia')).toBeVisible();
    await pagar.click();
    await expect.poll(() => pagos.length).toBe(2);
    expect(pagos[1].body.client_key, 'un 5xx pudo haber pagado: el reintento lleva la misma llave').toBe(pagos[0].body.client_key);
  });

  test('un 4xx no pagó nada: el siguiente intento es otro, con otra llave', async ({ page }) => {
    const exacto = { ...RETIRO, total: 83981.89, cajon: 0 };
    await abrir(page, {
      hojas: () => HOJAS([ABIERTA({ retiros_que_cuadran: [exacto] })]),
      alPagar: (n) => (n === 1 ? { status: 409, body: { message: 'La reposición cambió: vuelve a leer' } } : { status: 201, body: PAGADA }),
    });
    const v = await ventana(page);
    const pagar = v.getByRole('button', { name: 'Pagar Zona Morelia' });
    await pagar.click();
    await expect(page.getByText('La reposición cambió: vuelve a leer')).toBeVisible();
    await pagar.click();
    await expect.poll(() => pagos.length).toBe(2);
    expect(pagos[1].body.client_key).not.toBe(pagos[0].body.client_key);
  });
});

test.describe('[LE.6.20] lo que ya se repuso no se repone otra vez', () => {
  test('lo ya repuesto y lo sin depósito se ven con su testigo, desplegables; «Pagar» sólo lleva lo por reponer', async ({ page }) => {
    const sin = { ...RENGLON, origen_ref: '08|X-D-26|0000650|0011', folio: '0000650', fecha_pago: '2026-10-21', importe: 194570.19,
      motivo: 'Ningún depósito en la 1604 lo repone: si es gasto normal, se paga en la cola' };
    const ya = [{ desde: '2026-10-16', hasta: '2026-10-16', renglones: 12, total: 92606.73, como: 'deposito', testigo: 'depósito del 22/10 por $92,606.73' }];
    const exacto = { ...RETIRO, total: 83981.89, cajon: 0 };
    await abrir(page, { hojas: () => HOJAS([ABIERTA({ ya_repuestos: ya, sin_deposito: [sin], retiros_que_cuadran: [exacto] })]),
      alPagar: () => ({ status: 201, body: PAGADA }) });
    const v = await ventana(page);
    const bloque = v.getByTestId('rp-repuesto');
    await expect(bloque).toContainText('1 tramo ya repuesto ($92,606.73)');
    await expect(bloque).toContainText('1 pago sin depósito ($194,570.19)');
    // Cerrado por omisión: el detalle se abre con el teclado, sin mouse.
    await expect(bloque.getByTestId('rp-sin-deposito')).toBeHidden();
    await bloque.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(bloque.getByTestId('rp-sin-deposito')).toContainText('si es gasto normal, se paga en la cola');
    await expect(bloque).toContainText('depósito del 22/10 por $92,606.73');
    await v.getByRole('button', { name: 'Pagar Zona Morelia' }).click();
    await expect.poll(() => pagos.length).toBe(1);
    expect(pagos[0].body.origen_refs, 'el pago no lleva lo ya repuesto ni lo sin depósito').toEqual(['08|X-D-26|0000700|0011']);
  });
});

test('[LE.6.19] la ruta vieja /finanzas/hoja-gastos lleva a Caja General', async ({ page }) => {
  await abrir(page, { hojas: () => HOJAS([]) });
  await page.goto('/finanzas/hoja-gastos');
  await expect(page).toHaveURL(/\/finanzas\/caja-general$/);
  await expect(page.locator('.cg-repo-btn')).toBeVisible({ timeout: 30_000 });
});
