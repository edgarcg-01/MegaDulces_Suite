import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * `[CC.20]`–`[CC.20.2]` La página del enlace, en el celular del cliente (Pixel 7), con el bundle real.
 *
 *   · saluda por nombre, el botón de subir va primero y el PDF de su estado de cuenta debajo, con SU token;
 *   · tocar «Descargar mi estado de cuenta (PDF)» pide exactamente `GET finance/deposito/<token>/estado-de-cuenta.pdf`
 *     y abre el PDF (sin sesión: es un `<a>`);
 *   · subir una foto → la lectura llena monto y fecha → «Enviar» manda UNA vez lo que el cliente ve;
 *   · ⛔ un enlace reemplazado dice por qué y no ofrece ni formulario ni PDF.
 *
 * ⛔ La API es toda de la prueba: lo que no se contesta se aborta y se reclama en `afterEach`.
 */

const TOKEN = 'eyJ0ZXN0IjoxfQ.e2e.firma';
const CTX = {
  cliente: 'BOLSAS DE PRUEBA', sucursal: 'Padre Hidalgo',
  fichas: [{ id: 'f2', status: 'validado', motivo_rechazo: null, monto: 1500, fecha: '2026-11-08', enviado: '2026-11-08T10:00:00Z', aplicado: true }],
};
// Un PDF mínimo válido: lo que importa es que el navegador lo reciba como PDF.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const FOTO = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

let fugas: string[] = [];
let pdfPedidos: string[] = [];
let envios: unknown[] = [];

async function abrir(page: Page, o: { contexto?: (r: Route) => Promise<void> } = {}) {
  const json = (r: Route, status: number, body: unknown) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.routeWebSocket(/socket\.io/, (ws) => ws.close());
  await page.route(/\/socket\.io\//, (r) => r.abort());
  await page.route('**/api/**', (r) => {
    const req = r.request();
    const ruta = new URL(req.url()).pathname.replace(/^\/api\//, '');
    const t = encodeURIComponent(TOKEN);
    if (req.method() === 'GET' && ruta === `finance/deposito/${t}`) return o.contexto ? o.contexto(r) : json(r, 200, CTX);
    if (req.method() === 'GET' && ruta === `finance/deposito/${t}/estado-de-cuenta.pdf`) {
      pdfPedidos.push(ruta);
      return r.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'Content-Disposition': 'inline; filename="estado-de-cuenta-C1093.pdf"' }, body: PDF });
    }
    if (req.method() === 'POST' && ruta === `finance/deposito/${t}/subir`) return json(r, 201, { url: 'finance/t/customer-deposits/a.jpg', kind: 'image' });
    if (req.method() === 'POST' && ruta === `finance/deposito/${t}/leer`) return json(r, 201, { monto: 12500, fecha: '2026-11-15', banco: 'BBVA', referencia: '123', ocr_status: 'ok', sha256: 'HUELLA' });
    if (req.method() === 'POST' && ruta === `finance/deposito/${t}`) { envios.push(req.postDataJSON()); return json(r, 201, { id: 'n1', status: 'recibido', ya_estaba: false }); }
    if (req.method() === 'POST' && ruta === 'telemetry/suite') return r.fulfill({ status: 204 });
    fugas.push(`${req.method()} ${ruta}`);
    return r.abort();
  });
  await page.goto(`/deposito/${TOKEN}`);
}

test.beforeEach(() => { fugas = []; pdfPedidos = []; envios = []; });
test.afterEach(() => {
  expect(fugas, '⛔ la página pidió algo que la prueba no contesta (en local eso iría a PROD)').toEqual([]);
});

test.describe('[CC.20.2] el enlace del cliente, en su celular', () => {
  test('saluda, el botón de subir va primero y el PDF de su estado de cuenta está debajo con SU token', async ({ page }) => {
    await abrir(page);
    await expect(page.getByRole('heading', { name: 'Hola, BOLSAS DE PRUEBA' })).toBeVisible({ timeout: 45_000 });
    const pdf = page.getByTestId('estado-cuenta-pdf');
    await expect(pdf).toHaveText(/Descargar mi estado de cuenta \(PDF\)/);
    expect(await pdf.getAttribute('href')).toMatch(new RegExp(`/finance/deposito/${encodeURIComponent(TOKEN).replace(/\./g, '\\.')}/estado-de-cuenta\\.pdf$`));
    // El acto principal (subir) va antes que el PDF.
    const subir = await page.locator('.dc-btn-main').first().boundingBox();
    const caja = await pdf.boundingBox();
    expect(subir && caja && subir.y < caja.y).toBeTruthy();
    // Se alcanza con el dedo: 44 px o más.
    expect((caja?.height ?? 0) >= 44).toBeTruthy();
    await expect(page.getByText('Aplicada')).toBeVisible();
    await page.screenshot({ path: `${__dirname}/.resultados/cliente-celular.png`, fullPage: true });
  });

  test('tocar el PDF lo pide con su token y lo abre, sin sesión', async ({ page, context }) => {
    await abrir(page);
    const pdf = page.getByTestId('estado-cuenta-pdf');
    await expect(pdf).toBeVisible({ timeout: 45_000 });
    // La pestaña nueva hereda las rutas del CONTEXTO, no las de la página: se contestan ahí también.
    await context.route('**/api/finance/deposito/**/estado-de-cuenta.pdf', (r) => {
      pdfPedidos.push(new URL(r.request().url()).pathname);
      return r.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
    });
    // En el celular Chrome DESCARGA el PDF (no tiene visor); en otros abre pestaña. Vale cualquiera de los dos: lo que
    // se afirma es que el PDF se pidió con SU token y llegó como PDF.
    const evento = Promise.race([
      context.waitForEvent('page', { timeout: 20_000 }).then((p) => ({ tipo: 'pestaña', url: p.url() })),
      page.waitForEvent('download', { timeout: 20_000 }).then((d) => ({ tipo: 'descarga', url: d.url(), nombre: d.suggestedFilename() })),
    ]);
    await pdf.click();
    const llego = await evento;
    test.info().annotations.push({ type: 'cómo llegó el PDF', description: JSON.stringify(llego) });
    expect(llego.url).toContain(`/finance/deposito/${encodeURIComponent(TOKEN)}/estado-de-cuenta.pdf`);
    if (llego.tipo === 'descarga') expect((llego as { nombre?: string }).nombre).toMatch(/\.pdf$/);
    else expect(pdfPedidos.length, 'se pidió el PDF').toBeGreaterThanOrEqual(1);
  });

  test('subir una foto, la lectura llena los campos y «Enviar» manda UNA vez', async ({ page }) => {
    await abrir(page);
    await expect(page.getByRole('heading', { name: 'Hola, BOLSAS DE PRUEBA' })).toBeVisible({ timeout: 45_000 });
    await page.locator('input.dc-file').setInputFiles({ name: 'ficha.jpg', mimeType: 'image/jpeg', buffer: FOTO });
    await expect(page.getByText('Leímos tu ficha. Revisa que esté bien.')).toBeVisible({ timeout: 20_000 });
    const enviar = page.getByRole('button', { name: /Enviar/ });
    await expect(enviar).toBeEnabled();
    await enviar.dblclick();
    await expect.poll(() => envios.length).toBe(1);
    const b = envios[0] as { monto: number | string; fecha: string; files: unknown[] };
    expect(Number(b.monto)).toBe(12500);
    expect(b.fecha).toBe('2026-11-15');
    expect(b.files).toHaveLength(1);
  });

  test('⛔ un enlace reemplazado dice por qué, sin formulario ni PDF', async ({ page }) => {
    await abrir(page, { contexto: (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: 403, message: 'Este enlace fue reemplazado por uno nuevo. Usa el último que te mandamos.' }) }) });
    await expect(page.getByText('Este enlace fue reemplazado por uno nuevo')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('estado-cuenta-pdf')).toHaveCount(0);
    await expect(page.locator('input.dc-file')).toHaveCount(0);
    expect(pdfPedidos).toEqual([]);
  });
});
