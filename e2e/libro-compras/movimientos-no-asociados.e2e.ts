import { test, expect, request, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * `[LC.18.3]` — e2e de /contabilidad/movimientos-no-asociados, en navegador real y contra PROD.
 *
 * Nace del e2e manual del 2026-10-21 (FASE_LC §LC.18.1), que encontró 7 defectos que ninguna
 * prueba de servicio veía — el peor, que el TXT de octubre salía SIN UUID porque la pantalla
 * desmarcaba la casilla sola. Cada defecto tiene acá su prueba, con el número del hallazgo.
 *
 * ⭐ El principio: **lo que pinta la pantalla se cruza contra lo que responde la API**, no contra
 * una cifra escrita a mano. Una cifra a mano envejece con el mes; dos implementaciones que dejan
 * de coincidir son un defecto en una de las dos.
 *
 * Dos bloques:
 *   · LECTURA (siempre). No escribe nada.
 *   · ESCRITURA (sólo con `E2E_ESCRIBIR=1`). Mueve el trámite de `E2E_MES_ESCRITURA` (default
 *     2026-10): genera, entrega y CANCELA. Deja el mes como lo encontró —pendiente, con una
 *     corrida cancelada— y nunca lo marca aplicado (aplicado es terminal).
 */

const MES = process.env.E2E_MES || '2026-10';
const MES_ESCRITURA = process.env.E2E_MES_ESCRITURA || '2026-10';
const LEGADO = '2026-07'; // TXT guardado con el formato de antes del 8-oct
const SIN_ARCHIVO = '2026-06'; // firma sin contenido
const RUTA = '/contabilidad/movimientos-no-asociados';
const API = '/api/finance/purchase-book/no-asociados';

const token = (() => {
  const f = process.env.MD_TOKEN_FILE;
  if (!f) return null;
  try { return readFileSync(f, 'utf8').replace(/^"|"$/g, '').trim(); } catch { return null; }
})();

test.skip(!token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión (la suite corre contra prod con un usuario real)');

// ── Tipos mínimos de lo que responde la API ─────────────────────────────────────────────
interface Factura {
  uuid: string; emisor_nombre: string; total: number; base_exenta: number; subtotal16: number;
  iva: number; ieps: number; incluida: boolean; account_suffix: string | null; cuenta_existe: boolean;
  en_libro_reciente: boolean; prueba_certeza: 'exacta' | 'por_importe' | null; estatus_sat: string;
  motivo_exclusion: string | null; cuenta_sugerida?: { cuenta: string } | null;
  estatus_verificado_at?: string | null;
}
interface Mes {
  mes: string; run: Record<string, unknown> | null; facturas: Factura[];
  resumen: { incluidas: number; total: number; sin_verificar_sat?: number }; avisos: string[];
  cuentas_impuesto?: { iva: { cuenta: string }; ieps: { cuenta: string }; desde: string | null };
}

let api: APIRequestContext;
test.beforeAll(async ({ baseURL }) => {
  api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
});
test.afterAll(async () => { await api?.dispose(); });

const getMes = async (mes: string): Promise<Mes> => {
  const r = await api.get(`${API}/${mes}`);
  expect(r.status(), `GET ${mes}`).toBe(200);
  return r.json();
};

/** El mismo criterio de grupos que la pantalla (`grupo()` del componente), escrito aparte. */
const grupoDe = (f: Factura) =>
  f.prueba_certeza === 'exacta' ? 'ya_libro'
    : f.estatus_sat === 'cancelado' || f.prueba_certeza === 'por_importe' ? 'revisar'
      : !f.account_suffix || !f.cuenta_existe ? 'sin_cuenta'
        : !f.en_libro_reciente ? 'sin_historial' : 'entran';

const r2 = (n: number) => Math.round(n * 100) / 100;
const pesos = (s: string) => Number(s.replace(/[^0-9.-]/g, ''));

/** LC.19.6: lo que responde `preparar` cuando no se le deja hacer nada (la suite de lectura no escribe). */
const PREPARAR_VACIO = {
  mes: '', aplicado: { hecho: false, motivo: null }, cuentas_asignadas: [], sat: null,
  generado: { hecho: false, motivo: null }, restantes: 0,
};

async function abrir(page: Page, mes: string, opts: { preparar?: boolean } = {}) {
  // LC.19.6: abrir el mes lo PREPARA (verifica en el SAT, asigna cuentas, marca aplicado): eso
  // escribe. Fuera del bloque de escritura se intercepta y se responde «nada que hacer».
  if (!opts.preparar) {
    await page.route('**/no-asociados/*/preparar', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREPARAR_VACIO) }));
  }
  await page.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* */ } }, token);
  await page.goto(`${RUTA}?mes=${mes}`);
  await expect(page.locator('.lc-veredicto')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.na-chip').first()).toBeVisible();
}

const chips = async (page: Page) => {
  const out: Record<string, number> = {};
  for (const t of await page.locator('.na-chip').allInnerTexts()) {
    const m = t.replace(/\s+/g, ' ').trim().match(/^(.*?)\s*(\d+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
};

const tarjeta = (page: Page, mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  const nombre = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)));
  return page.getByRole('complementary', { name: /Meses con movimientos/ })
    .getByRole('button', { name: new RegExp(nombre.replace(/^./, (c) => c.toUpperCase()), 'i') });
};

// ════════════════════════════════════════════════════════════════════════════════════
test.describe('lectura — lo que pinta la pantalla = lo que dice la API', () => {
  test(`${MES}: chips, pie y carátula cuadran contra la API`, async ({ page }) => {
    const errores: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
    const d = await getMes(MES);
    await abrir(page, MES);

    // Los chips: mismo criterio escrito dos veces (pantalla y esta prueba).
    const esperado: Record<string, number> = { entran: 0, sin_historial: 0, sin_cuenta: 0, revisar: 0, ya_libro: 0 };
    for (const f of d.facturas) { const g = grupoDe(f); if (g !== 'entran') esperado[g]++; if (f.incluida) esperado.entran++; }
    const c = await chips(page);
    expect(c['Entran al TXT'], 'chip «Entran al TXT» = resumen.incluidas').toBe(d.resumen.incluidas);
    expect(c['Sin libro reciente']).toBe(esperado.sin_historial);
    expect(c['Sin cuenta']).toBe(esperado.sin_cuenta);
    expect(c['Revisar']).toBe(esperado.revisar);
    expect(c['Ya en el libro']).toBe(esperado.ya_libro);
    expect(c['Todas']).toBe(d.facturas.length);

    // El pie: 0% + c/IVA + IEPS + IVA = total, y el total = lo que entra según la API.
    const pie = (await page.locator('.na-tot td').allInnerTexts()).map((t) => t.trim()).filter((t) => t.startsWith('$'));
    expect(pie.length, 'el pie trae 5 importes').toBe(5);
    const [exento, gravado, ieps, iva, total] = pie.map(pesos);
    expect(r2(exento + gravado + ieps + iva), 'el pie cuadra de izquierda a derecha').toBe(r2(total));
    expect(total, 'el pie de «Entran al TXT» = resumen.total').toBe(r2(d.resumen.total));

    // Cuentas de impuesto: las del último libro, dichas en pantalla.
    if (d.cuentas_impuesto) {
      await expect(page.locator('.na-ctas-imp')).toContainText(d.cuentas_impuesto.iva.cuenta);
      await expect(page.locator('.na-ctas-imp')).toContainText(d.cuentas_impuesto.ieps.cuenta);
    }

    // [#1] el folio que dice la carátula es el que va a usar el servidor.
    const folio = d.run ? Number(d.run['folio_poliza']) : null;
    const textoFolio = await page.locator('.lc-cuadre').innerText();
    if (folio) expect(textoFolio, '#1 la carátula dice el folio de la corrida').toContain(`Póliza ${folio} del Diario`);

    // [#5] la casilla del UUID: marcada salvo que un archivo VIGENTE se haya generado sin él.
    const vigente = d.run && ['generado', 'entregado', 'aplicado'].includes(String(d.run['estado']));
    const esperadoUuid = vigente ? d.run!['incluye_uuid'] !== false : true;
    expect(await page.locator('#na-uuid').isChecked(), '#5 la casilla «Poner el UUID» no se desmarca sola').toBe(esperadoUuid);

    expect(errores, 'errores en la consola').toEqual([]);
  });

  test(`${MES}: la tarjeta del rail no dice «Cancelado» en rojo (#7)`, async ({ page }) => {
    await abrir(page, MES);
    const t = (await tarjeta(page, MES).innerText()).replace(/\s+/g, ' ');
    expect(t, '#7 una entrega cancelada deja el mes PENDIENTE').not.toMatch(/Cancelado/);
  });

  test(`${LEGADO}: un TXT de formato viejo no se ofrece (y el aviso no se repite, #2)`, async ({ page }) => {
    const d = await getMes(LEGADO);
    test.skip(!d.run || d.run['archivo_vigente'] !== false, `${LEGADO} ya no tiene un archivo vencido: se regeneró`);
    await abrir(page, LEGADO);
    const v = page.locator('.lc-veredicto');
    await expect(v).toContainText('El archivo guardado ya no sirve');
    const acciones = await page.locator('.lc-acciones button').allInnerTexts();
    expect(acciones.join('|'), 'ni descargar ni entregar un archivo que ContPAQi rechaza').not.toMatch(/Descargar TXT|Marcar entregado/);
    expect(await v.innerText(), '#2 el motivo no se repite').not.toMatch(/generarlo de nuevo\.?\s*Vuelve a generarlo/);
  });

  test(`${SIN_ARCHIVO}: firma sin archivo, sin botones que den 404`, async ({ page }) => {
    const d = await getMes(SIN_ARCHIVO);
    test.skip(!d.run || d.run['archivo_vigente'] !== false, `${SIN_ARCHIVO} ya no está así`);
    await abrir(page, SIN_ARCHIVO);
    const acciones = await page.locator('.lc-acciones button').allInnerTexts();
    expect(acciones.join('|')).not.toMatch(/Descargar TXT|Respaldo en Excel|CSV del asociador/);
  });

  test(`${MES}: «Sin libro reciente» no entra sola y dice por qué`, async ({ page }) => {
    const d = await getMes(MES);
    const sinHist = d.facturas.filter((f) => grupoDe(f) === 'sin_historial');
    test.skip(!sinHist.length, 'el mes no tiene facturas sin libro reciente');
    await abrir(page, MES);
    await page.locator('.na-chip', { hasText: 'Sin libro reciente' }).click();
    const filas = page.locator('.lc-tablewrap tbody tr');
    await expect(filas.first()).toBeVisible();
    const n = Math.min(await filas.count(), 20);
    for (let i = 0; i < n; i++) {
      const fila = filas.nth(i);
      await expect(fila.getByText('Sin libro reciente')).toBeVisible();
      if (!(await fila.locator('input[type=checkbox]').isChecked())) {
        await expect(fila).toContainText('no entró al libro en los últimos 6 meses');
      }
    }
  });

  test(`${MES}: «Asignar» sólo donde hay una cuenta sugerida (#3)`, async ({ page }) => {
    const d = await getMes(MES);
    const sinCuenta = d.facturas.filter((f) => !f.account_suffix);
    test.skip(!sinCuenta.length, 'el mes no tiene facturas sin cuenta');
    const conSug = sinCuenta.filter((f) => f.cuenta_sugerida);
    expect('cuenta_sugerida' in sinCuenta[0], '#3 la API manda la sugerencia por fila (¿está desplegado LC.18.1?)').toBe(true);
    await abrir(page, MES);
    await page.locator('.na-chip', { hasText: 'Sin cuenta' }).click();
    const destacados = page.locator('.lc-tablewrap tbody button.na-link:not(.na-link-sutil)');
    // La tabla pagina de a 100: se cuenta lo de la primera página contra lo que la API pone en ella.
    const visibles = Math.min(sinCuenta.length, 100);
    const esperadosPag = sinCuenta.slice(0, visibles).filter((f) => f.cuenta_sugerida).length;
    await expect(destacados, `#3 sólo ${esperadosPag} destacados en la 1.ª página (${conSug.length} en el mes)`).toHaveCount(esperadosPag);
    for (const t of await destacados.allInnerTexts()) expect(t).toMatch(/Asignar 212\d{7}/);
  });

  test('cambiar de mes rápido deja el último, con sus filas (B5)', async ({ page }) => {
    await abrir(page, MES);
    for (const m of ['2026-09', '2026-08', '2026-07', MES]) await tarjeta(page, m).click();
    await expect(page).toHaveURL(new RegExp(`mes=${MES}`));
    await page.waitForTimeout(2500);
    const d = await getMes(MES);
    expect((await chips(page))['Todas'], 'la tabla es la del último mes pedido').toBe(d.facturas.length);
  });

  test('tiempos de la API, desde el navegador', async ({ page }) => {
    await abrir(page, MES);
    await page.reload();
    await expect(page.locator('.na-chip').first()).toBeVisible();
    const t = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((e) => /purchase-book\/no-asociados/.test(e.name))
      .map((e) => ({ url: e.name.replace(/^.*no-asociados/, '') || '/', ms: Math.round((e as PerformanceResourceTiming).responseEnd - e.startTime) })));
    test.info().annotations.push({ type: 'tiempos', description: t.map((x) => `${x.url} ${x.ms} ms`).join(' · ') });
    const mes = t.find((x) => x.url === `/${MES}`);
    expect(mes, 'se pidió el mes').toBeTruthy();
    expect(mes!.ms, 'abrir el mes < 500 ms (regla dura de la suite)').toBeLessThan(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════
test.describe('escritura — generar, entregar y cancelar el mes', () => {
  test.skip(process.env.E2E_ESCRIBIR !== '1', 'NO MEDIDO: el bloque que escribe se pide con E2E_ESCRIBIR=1');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Si una corrida anterior quedó entregada, se cancela primero: el bloque empieza desde pendiente.
    const d = await getMes(MES_ESCRITURA);
    if (d.run && d.run['estado'] === 'entregado') {
      await api.post(`${API}/${MES_ESCRITURA}/estado`, { data: { estado: 'cancelado', notas: 'e2e LC.18.3: limpieza previa' } });
    }
    const otra = await getMes(MES_ESCRITURA);
    expect(otra.run?.['estado'], 'el mes no puede estar aplicado: es terminal').not.toBe('aplicado');
  });

  test('preparar al abrir: verifica en el SAT SOLO; sin verificar no se genera (LC.19.1, LC.19.6)', async ({ page }) => {
    test.setTimeout(360_000); // ~350 facturas a ~4 por segundo, en lotes de 100
    const antes = await getMes(MES_ESCRITURA);
    test.skip(!antes.resumen.incluidas, 'no hay nada que generar en el mes');
    const generarBtn = page.locator('.lc-acciones button', { hasText: 'Generar TXT' });
    if ((antes.resumen.sin_verificar_sat ?? 0) > 0) {
      // La negativa, antes de abrir (abrir dispara la verificación).
      const g = await api.post(`${API}/${MES_ESCRITURA}/generar`, { data: { impuestos: 'global', uuid: true } });
      expect(g.status(), '⛔ con marcadas sin verificar, el servidor no genera aunque alguien llame directo').toBe(400);
      expect(await g.text()).toContain('sin verificar ante el SAT');
      await abrir(page, MES_ESCRITURA, { preparar: true });
      await expect(page.locator('.na-prep'), 'sin clic: el mes dice que se está preparando').toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.p-toast-message', { hasText: 'El mes se preparó solo' })).toBeVisible({ timeout: 330_000 });
    } else {
      await abrir(page, MES_ESCRITURA, { preparar: true });
    }
    const despues = await getMes(MES_ESCRITURA);
    const pendientes = despues.facturas.filter((f) => f.incluida && f.estatus_sat !== 'vigente');
    expect(pendientes.every((f) => !!f.estatus_verificado_at), 'toda marcada no vigente fue CONSULTADA (no se saltó)').toBe(true);
    test.skip(pendientes.length > 0, `NO MEDIDO el resto: ${pendientes.length} marcadas no salieron vigentes ante el SAT — hay que revisarlas a mano`);
    expect(despues.resumen.sin_verificar_sat ?? 0).toBe(0);
    await page.reload();
    await expect(generarBtn, 'con todo vigente, Generar se enciende').toBeEnabled({ timeout: 20_000 });
  });

  test('generar: folio y nombre del libro, con UUID en cada renglón (#4, #5)', async ({ page }) => {
    const antes = await getMes(MES_ESCRITURA);
    test.skip(!antes.resumen.incluidas, 'no hay nada que generar en el mes');
    test.skip((antes.resumen.sin_verificar_sat ?? 0) > 0, 'NO MEDIDO: quedan marcadas sin verificar ante el SAT');
    await abrir(page, MES_ESCRITURA);
    await expect(page.locator('#na-uuid'), '#5 la casilla del UUID arranca marcada').toBeChecked();
    await page.locator('.lc-acciones button', { hasText: 'Generar TXT' }).click();
    const toast = page.locator('.p-toast-message');
    await expect(toast).toContainText(/generado/, { timeout: 20_000 });
    const folio = Number(((await toast.innerText()).match(/póliza (\d+)/) || [])[1]);
    await expect(toast).toContainText(`${antes.resumen.incluidas} facturas`);

    const r = await api.get(`${API}/${MES_ESCRITURA}/archivo`);
    expect(r.status()).toBe(200);
    const nombre = (r.headers()['content-disposition'] || '').match(/filename="([^"]+)"/)?.[1];
    if (folio === 1) expect(nombre, '#4 el libro del mes se llama poliza-compras-*').toBe(`poliza-compras-${MES_ESCRITURA}.txt`);
    const txt = Buffer.from(await r.body()).toString('latin1');
    const lineas = txt.split('\r\n').filter(Boolean);
    expect(new Set(lineas.map((l) => `${l[0]}:${l.length}`)), 'formato real de ContPAQi: P=185 / M=272')
      .toEqual(new Set(['P:185', 'M:272']));
    const movsProveedor = lineas.filter((l) => l.startsWith('M1 212'));
    const conUuid = movsProveedor.filter((l) => /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/.test(l));
    expect(conUuid.length, '#5 cada abono a proveedor lleva el UUID de su CFDI').toBe(movsProveedor.length);
  });

  test('aplicado sin ContPAQi se rechaza; entregado ya no es un paso de la pantalla (#6, LC.19.6)', async ({ page }) => {
    await abrir(page, MES_ESCRITURA);
    await expect(page.locator('.lc-acciones button', { hasText: 'Marcar entregado' }), 'LC.19.6: «Marcar entregado» ya no está').toHaveCount(0);
    // ⛔ Sólo se intenta si CONSTA que ContPAQi no tiene el folio: si lo tuviera, la llamada marcaría
    // el mes aplicado DE VERDAD, y aplicado es terminal.
    const cu = await (await api.get(`${API}/${MES_ESCRITURA}/cuadre`)).json();
    if (cu.comparable && !cu.existe_en_contpaqi) {
      const ap = await api.post(`${API}/${MES_ESCRITURA}/estado`, { data: { estado: 'aplicado' } });
      expect(ap.status(), '⛔ generado → aplicado sin que ContPAQi tenga el folio se rechaza').toBe(400);
      expect(await ap.text()).toContain('ContPAQi todavía no tiene el folio');
    } else {
      test.info().annotations.push({ type: 'NO MEDIDO', description: `aplicado sin evidencia: el cuadre no permite afirmar que ContPAQi no tiene el folio (${cu.motivo || 'existe'})` });
    }
    // El estado «entregado» sigue existiendo en el servidor; la prueba lo pone por API para
    // ejercer #6 (entregado ⇒ nada por entrar) y dejar el mes listo para «Cancelar entrega».
    const en = await api.post(`${API}/${MES_ESCRITURA}/estado`, { data: { estado: 'entregado', entregado_a: 'e2e LC.19.6 (no se sube)' } });
    expect(en.status()).toBe(201);
    await page.reload();
    await expect(page.locator('.lc-veredicto')).toContainText('Entregado', { timeout: 15_000 });
    await expect(page.locator('.lc-acciones button', { hasText: 'Generar TXT' })).toBeDisabled();
    const c = await chips(page);
    expect(c['Entran al TXT'], '#6 entregado el mes, no queda nada por entrar').toBe(0);
    const d = await getMes(MES_ESCRITURA);
    expect(c['Ya en el libro']).toBe(d.facturas.filter((f) => f.prueba_certeza === 'exacta').length);
    const otra = await api.post(`${API}/${MES_ESCRITURA}/generar`, { data: { impuestos: 'global', uuid: true } });
    expect(otra.status(), 'regenerar encima de una entrega se rechaza').toBe(400);
  });

  test('cancelar: el mes vuelve a pendiente, sin archivo (#7)', async ({ page }) => {
    await abrir(page, MES_ESCRITURA);
    await page.locator('.lc-acciones button', { hasText: 'Cancelar entrega' }).click();
    const dlg = page.getByRole('dialog', { name: 'Cancelar la entrega' });
    const boton = dlg.getByRole('button', { name: 'Cancelar entrega' });
    await expect(boton, 'sin motivo no se cancela').toBeDisabled();
    await dlg.locator('input').fill('e2e LC.18.3: prueba, no se subió a ContPAQi');
    await boton.click();
    await expect(page.locator('.p-toast-message')).toContainText('cancelado', { timeout: 15_000 });
    expect((await api.get(`${API}/${MES_ESCRITURA}/archivo`)).status(), 'una cancelada no sirve archivo').toBe(404);
    await page.reload();
    await expect(page.locator('.na-chip').first()).toBeVisible();
    expect((await tarjeta(page, MES_ESCRITURA).innerText()), '#7 la tarjeta dice Pendiente').toMatch(/Pendiente/);
  });
});
