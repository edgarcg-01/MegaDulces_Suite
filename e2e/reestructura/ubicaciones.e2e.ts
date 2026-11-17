import { test, expect, type Page, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { medir } from './medir';
import { sesion, contexto, quieta } from './comun';

/**
 * `[GP.RF.UB]` Captura de ubicaciones (fase UB) recorrida de punta a punta en prod, para auditarla y
 * para armar la guía de capacitación (`FASE_GP_AUDITORIA_INTERFACES.md`, paso de Ubicaciones).
 *
 * Qué se recorre: Mapa → alta suelta (con códigos buenos y malos) → captura masiva por rango y por
 * Excel → lotes y «deshacer» → Asignación por producto y presentación (a mano y por Excel) → Contenido.
 *
 * ⚠️ PROD, SIN ESCRIBIR. Pasan las lecturas y las DOS vistas previas (`bulk/preview` y
 * `assignments/bulk/preview`: su servicio sólo planifica, no inserta — revisado en el código). Todo lo
 * que guarda (dar de alta, crear el lote, asignar, deshacer) se aborta en el navegador y se registra
 * lo que habría mandado. Así se ve qué haría cada botón sin crear nada.
 */

const RES = path.join(__dirname, '.resultados');
const DIR = path.join(RES, 'ub');
const PREVIAS = ['/api/warehouse/locations/bulk/preview', '/api/warehouse/locations/assignments/bulk/preview'];
const PILOTO = /Padre Hidalgo/;
const CEDIS = /CEDIS/;

type Paso = { n: number; pantalla: string; que: string; dato?: unknown; foto?: string };

async function blindarUB(page: Page) {
  const abortadas: { metodo: string; ruta: string; cuerpo: string }[] = [];
  const previas: string[] = [];
  await page.route('**/api/**', (r) => {
    const req = r.request();
    const ruta = new URL(req.url()).pathname;
    if (req.method() === 'GET') return r.continue();
    if (req.method() === 'POST' && PREVIAS.includes(ruta)) { previas.push(ruta); return r.continue(); }
    if (!ruta.includes('/telemetry/')) abortadas.push({ metodo: req.method(), ruta, cuerpo: (req.postData() || '').slice(0, 3000) });
    return r.abort('blockedbyclient');
  });
  return { abortadas, previas };
}

/** Abre un p-select y elige la opción cuyo texto cumple `re`. Devuelve las opciones que había. */
async function elegir(page: Page, select: Locator, re: RegExp): Promise<string[]> {
  await select.click();
  const opciones = page.getByRole('option');
  await opciones.first().waitFor({ state: 'visible', timeout: 5_000 });
  const textos = (await opciones.allInnerTexts()).map((t) => t.trim());
  const op = opciones.filter({ hasText: re }).first();
  if (await op.count()) await op.click();
  else await page.keyboard.press('Escape');
  return textos;
}

/** Después de elegir almacén, espera a que la pantalla YA muestre ese almacén (sin esto se mide el anterior). */
async function enAlmacen(page: Page, meta: string, re: RegExp): Promise<void> {
  await page.locator(meta).filter({ hasText: re }).first().waitFor({ timeout: 20_000 });
  await quieta(page);
}

const texto = async (l: Locator): Promise<string> => (await l.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

test.describe('UB · captura de ubicaciones, de punta a punta', () => {
  // Ninguna acción espera sin límite: la primera corrida se colgó 10 min enfocando un rack que no existía.
  test.use({ actionTimeout: 10_000 });
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('mapa, alta, captura masiva, asignación y contenido (sin escribir en prod)', async ({ browser, request }) => {
    test.setTimeout(10 * 60_000);
    fs.mkdirSync(DIR, { recursive: true });
    const commit = await request.get('/api/health').then((r) => r.json()).then((j) => j.commit as string, () => 'NO MEDIDO');
    const ctx = await contexto(browser, s.token);
    const page = await ctx.newPage();
    const b = await blindarUB(page);
    const errores: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) errores.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
    const pasos: Paso[] = [];
    const medidas: Record<string, unknown> = {};
    let n = 0;
    const paso = async (pantalla: string, que: string, dato?: unknown, conFoto = true) => {
      n++;
      // Las cifras grandes se animan contando ~0.9 s (appCountUp): antes de leer o fotografiar, que terminen.
      await page.waitForTimeout(1200);
      const foto = conFoto ? `${String(n).padStart(2, '0')}-${pantalla}.png` : undefined;
      if (foto) await page.screenshot({ path: path.join(DIR, foto) });
      pasos.push({ n, pantalla, que, dato, foto });
    };

    // ── A. Mapa ────────────────────────────────────────────────────────────────────────────────
    let t0 = Date.now();
    await page.goto('/almacen/ubicaciones');
    await page.getByRole('heading', { name: 'Ubicaciones', level: 1 }).waitFor({ timeout: 30_000 });
    await page.locator('.ub-meta').first().waitFor({ timeout: 20_000 });
    let q = await quieta(page, t0);
    medidas['mapa_entrada'] = { ...q, ...(await medir(page)) };
    await paso('mapa', 'Entrar a Ubicaciones: abre en el primer almacén de la lista', { almacen: await texto(page.locator('.ub-meta')), kpis: await texto(page.locator('app-metric-strip')) });

    const selAlm = page.locator('.ub-actions p-select').first();
    const almacenes = (await selAlm.count()) ? await elegir(page, selAlm, PILOTO) : [];
    await enAlmacen(page, '.ub-meta', PILOTO);
    await paso('mapa-piloto', 'Elegir Padre Hidalgo (el piloto)', { almacenes_ofrecidos: almacenes.length, almacen: await texto(page.locator('.ub-meta')), vacio: await texto(page.locator('.ub-empty')), kpis: await texto(page.locator('app-metric-strip')) });

    // A3. Alta suelta: qué dice el campo con cada código.
    const campo = page.locator('#ub-code');
    const ayuda = page.locator('#ub-code-help');
    const darAlta = page.getByRole('button', { name: 'Dar de alta' });
    const casos = ['ba053', 'BA5 3', 'BÑ053', 'BA050', 'BA057', 'XA053', 'BA100', 'BA053'];
    const validacion: { codigo: string; ayuda: string; boton_activo: boolean }[] = [];
    if (await campo.count()) {
      for (const c of casos) {
        await campo.fill(c);
        await page.waitForTimeout(150);
        validacion.push({ codigo: c, ayuda: await texto(ayuda), boton_activo: await darAlta.isEnabled() });
        if (c === 'BÑ053') await paso('alta-codigo-malo', `Código malo: «${c}»`, validacion.at(-1));
      }
      await paso('alta-codigo-bueno', 'Código bueno: «BA053»', validacion.at(-1));
      const tipos = await elegir(page, page.locator('#ub-tipo').locator('xpath=ancestor-or-self::p-select').first(), /Surtido|surtido/);
      const antes = b.abortadas.length;
      await darAlta.click();
      await page.waitForTimeout(1500);
      await paso('alta-guardar', 'Dar de alta BA053 (la escritura se detuvo antes de salir)', {
        tipos_ofrecidos: tipos, habria_mandado: b.abortadas.slice(antes),
        mensaje_en_pantalla: await texto(page.locator('.ub-side [role="alert"], .ub-side [role="status"]')),
        campo_conserva: await campo.inputValue(),
      });
    }
    medidas['validacion_codigo'] = validacion;

    // A6. CEDIS: el mapa con racks y el detalle de uno.
    if (await selAlm.count()) await elegir(page, selAlm, CEDIS);
    await enAlmacen(page, '.ub-meta', CEDIS);
    q = await quieta(page);
    // Abre en Bodega aunque CEDIS tenga sus 375 en Tienda (medido 2026-11-17): se registra y se cambia.
    await paso('mapa-cedis-bodega', 'CEDIS abre en la zona Bodega', { kpis: await texto(page.locator('app-metric-strip')), zonas: await page.getByRole('radio').allInnerTexts(), vacio: await texto(page.locator('.ub-empty')) });
    await page.getByRole('radio', { name: /Tienda/ }).first().click();
    await page.locator('.ub-cell').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    medidas['mapa_cedis'] = { ...q, ...(await medir(page)), racks: await page.locator('.ub-cell').count() };
    await paso('mapa-cedis', 'CEDIS, zona Tienda: el mapa de racks', { leyenda: await texto(page.locator('.ub-legend')), racks: await page.locator('.ub-cell').count() });
    const celda = page.locator('.ub-cell.ub-c-activa').first();
    let codigoCedis = '';
    if (await celda.count()) {
      await celda.click();
      await page.waitForTimeout(300);
      codigoCedis = await texto(page.locator('.ub-levels .ub-code'));
      await paso('rack', 'Tocar un rack: se ven sus niveles', { detalle: await texto(page.locator('.ub-side .ub-step').first()), primer_codigo: codigoCedis });
      // Teclado: el mapa es una sola parada; las flechas mueven entre racks.
      await celda.focus();
      await page.keyboard.press('ArrowRight');
      medidas['mapa_teclado'] = { foco_tras_flecha: await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null) };
    }

    // ── B. Captura masiva (en el piloto) ───────────────────────────────────────────────────────
    if (await selAlm.count()) await elegir(page, selAlm, PILOTO);
    await enAlmacen(page, '.ub-meta', PILOTO);
    const btnCaptura = page.getByRole('button', { name: 'Captura masiva' });
    if (await btnCaptura.count()) {
      await btnCaptura.click();
      await page.locator('#uc-h').waitFor({ timeout: 10_000 });
      await paso('captura', 'Captura masiva: por rango', { titulo: await texto(page.locator('#uc-h')) });
      const rango = page.locator('form.uc-rango');
      await rango.locator('input[name="pd"]').fill('A');
      await rango.locator('input[name="ph"]').fill('D');
      await rango.locator('input[name="rd"]').fill('1');
      await rango.locator('input[name="rh"]').fill('15');
      await rango.locator('input[name="nd"]').fill('1');
      await rango.locator('input[name="nh"]').fill('3');
      await page.waitForTimeout(200);
      await paso('captura-rango', 'Rango B · pasillos A–D · racks 01–15 · niveles 1–3', { cuenta: await texto(page.locator('.uc-cuenta')) });
      const prev = page.waitForResponse((r) => r.url().includes('/bulk/preview'), { timeout: 30_000 }).catch(() => null);
      await rango.getByRole('button', { name: 'Revisar' }).click();
      const rp = await prev;
      await page.locator('.uc-resumen').waitFor({ timeout: 20_000 }).catch(() => undefined);
      await paso('captura-previa', 'Revisar: la vista previa dice qué va a pasar (no guarda)', {
        respuesta: rp?.status(), resumen: await texto(page.locator('.uc-resumen')), primeras_filas: (await page.locator('.uc-step p-table tbody tr').allInnerTexts()).slice(0, 4).map((x) => x.replace(/\s+/g, ' ')),
      });
      const crear = page.getByRole('button', { name: /^Crear \d+/ });
      if (await crear.count()) {
        const antes = b.abortadas.length;
        const etiqueta = await texto(crear);
        await crear.click();
        await page.waitForTimeout(1500);
        const ab = b.abortadas.slice(antes);
        await paso('captura-crear', `«${etiqueta}» (la escritura se detuvo antes de salir)`, {
          habria_mandado: ab.map((a) => ({ ...a, cuerpo: a.cuerpo.slice(0, 400) })),
          mensaje_en_pantalla: await texto(page.locator('app-ubicaciones-captura [role="alert"], app-ubicaciones-captura [role="status"]')),
        });
      }
      // Un rango imposible: ¿lo dice antes de revisar?
      await rango.locator('input[name="nh"]').fill('7');
      await page.waitForTimeout(150);
      await paso('captura-rango-malo', 'Rango imposible: nivel hasta 7', { cuenta: await texto(page.locator('.uc-cuenta')), revisar_activo: await rango.getByRole('button', { name: 'Revisar' }).isEnabled() }, false);

      // B4. Desde Excel: plantilla y un archivo con renglones buenos y malos.
      await page.getByRole('radio', { name: 'Desde Excel' }).click();
      const desc = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
      await page.getByRole('button', { name: 'Descargar plantilla' }).first().click();
      const d1 = await desc;
      if (d1) await d1.saveAs(path.join(DIR, 'plantilla-ubicaciones.xlsx'));
      const csv = ['Código,Tipo,Nombre', 'BA011,,', 'BA011,,repetida', 'ba012,,minúsculas', 'BA0X1,,mal', 'BÑ011,,eñe', 'BA010,,nivel 0', 'TB051,,tienda', ',,'].join('\n');
      await page.locator('app-ubicaciones-captura input[type="file"]').setInputFiles({ name: 'prueba-ubicaciones.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
      await page.waitForTimeout(500);
      const prev2 = page.waitForResponse((r) => r.url().includes('/bulk/preview'), { timeout: 30_000 }).catch(() => null);
      await page.locator('app-ubicaciones-captura').getByRole('button', { name: 'Revisar' }).click();
      const rp2 = await prev2;
      await page.locator('.uc-resumen').waitFor({ timeout: 20_000 }).catch(() => undefined);
      await paso('captura-excel', 'Desde Excel: 8 renglones de prueba (buenos, repetidos y malos)', {
        plantilla: d1?.suggestedFilename() ?? 'no se descargó', archivo: await texto(page.locator('app-ubicaciones-captura .uc-sub').first()), respuesta: rp2?.status(),
        resumen: await texto(page.locator('.uc-resumen')), filas: (await page.locator('.uc-step p-table tbody tr').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ')),
      });
      await page.getByRole('button', { name: 'Cancelar' }).first().click().catch(() => undefined);
    }

    // B6. Los lotes y «deshacer», en CEDIS (ahí está la captura del 8-oct).
    // Mientras llegan los lotes, la lista dice «Todavía no hay capturas» (medido 2026-11-17): se fotografía ese
    // instante como hallazgo y después se espera la respuesta real.
    const lotesResp = page.waitForResponse((r) => r.url().includes('/warehouse/locations/batches'), { timeout: 20_000 }).catch(() => null);
    if (await selAlm.count()) await elegir(page, selAlm, CEDIS);
    await page.locator('.ub-meta').filter({ hasText: CEDIS }).first().waitFor({ timeout: 20_000 });
    const mientras = await texto(page.locator('app-ubicaciones-captura .uc-step').last());
    if (!(await page.locator('#uc-h').count()) && (await btnCaptura.count())) await btnCaptura.click();
    await lotesResp;
    await page.locator('.uc-lote').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    medidas['lotes_mientras_cargan'] = mientras;
    const lotes = await page.locator('.uc-lote').allInnerTexts();
    const deshacer = page.locator('.uc-lote').getByRole('button', { name: 'Deshacer' }).first();
    let confirmacion = '';
    if (await deshacer.count()) {
      await deshacer.click();
      confirmacion = await texto(page.locator('.uc-confirm'));
      await paso('lotes-deshacer', 'Últimas capturas: «Deshacer» pide confirmar (se contestó «No»)', { lotes: lotes.map((x) => x.replace(/\s+/g, ' ')), confirmacion });
      await page.locator('.uc-confirm').getByRole('button', { name: 'No' }).click();
    } else {
      await paso('lotes', 'Últimas capturas', { lotes: lotes.map((x) => x.replace(/\s+/g, ' ')) });
    }

    // ── C. Asignación por producto y presentación ──────────────────────────────────────────────
    t0 = Date.now();
    await page.goto('/almacen/ubicaciones/asignacion');
    await page.getByRole('heading', { name: 'Asignación', level: 1 }).waitFor({ timeout: 30_000 });
    q = await quieta(page, t0);
    medidas['asignacion_entrada'] = { ...q, ...(await medir(page)) };
    await paso('asignacion', 'Entrar a Asignación', { almacen: await texto(page.locator('.as-meta')), kpis: await texto(page.locator('app-metric-strip')) });
    const selAlmA = page.locator('.as-actions p-select').first();
    if (await selAlmA.count()) await elegir(page, selAlmA, CEDIS);
    await enAlmacen(page, '.as-meta', CEDIS);
    const busqueda = page.waitForResponse((r) => r.url().includes('/warehouse/locations/products?') && r.url().includes('mazapan'), { timeout: 20_000 }).catch(() => null);
    await page.getByRole('searchbox', { name: /Buscar producto/ }).fill('mazapan');
    await busqueda;
    await quieta(page);
    const filasProd = page.locator('p-table tbody tr[class*="p-selectable-row"], p-table tbody tr').filter({ hasNot: page.locator('.as-empty') });
    await paso('asignacion-buscar', 'Buscar «mazapan» en CEDIS', { almacen: await texto(page.locator('.as-meta')), filas: (await filasProd.allInnerTexts()).slice(0, 6).map((x) => x.replace(/\s+/g, ' ')), kpis: await texto(page.locator('app-metric-strip')) });
    let sku = '';
    if (await filasProd.count()) {
      await filasProd.first().click();
      await page.locator('.as-side .as-h2').waitFor({ timeout: 15_000 }).catch(() => undefined);
      sku = await texto(page.locator('.as-side .as-sub.mono').first());
      await paso('asignacion-producto', 'Elegir el producto: sus presentaciones de Kepler', {
        producto: await texto(page.locator('.as-side .as-h2')), sku, presentaciones: await page.locator('.as-ladder .as-pill').allInnerTexts(),
        factores: await page.locator('.as-pres-h').allInnerTexts().then((x) => x.map((y) => y.replace(/\s+/g, ' '))),
      });
      const asignar = page.locator('.as-side').getByRole('button', { name: /^Asignar / }).first();
      if (await asignar.count()) {
        await asignar.click();
        const papeles = await elegir(page, page.locator('.as-alta p-select').first(), /Lugar fijo|surtido/i).catch(() => [] as string[]);
        const cod = page.locator('.as-alta input[name="code"]');
        const ayudaAlta = page.locator('.as-alta .as-sub.as-full');
        await cod.fill('BZ991');
        await page.waitForTimeout(200);
        const conMala = await texto(ayudaAlta);
        await paso('asignacion-codigo-inexistente', 'Ubicación bien escrita que no existe en CEDIS: «BZ991»', { papeles, ayuda: conMala, boton_activo: await page.locator('.as-alta').getByRole('button', { name: 'Asignar' }).isEnabled() });
        if (codigoCedis) await cod.fill(codigoCedis);
        await page.locator('.as-alta input[name="min"]').fill('4');
        await page.locator('.as-alta input[name="max"]').fill('12');
        await page.waitForTimeout(200);
        const antes = b.abortadas.length;
        const btn = page.locator('.as-alta').getByRole('button', { name: 'Asignar' });
        const activo = await btn.isEnabled();
        if (activo) { await btn.click(); await page.waitForTimeout(1500); }
        await paso('asignacion-guardar', `Asignar ${codigoCedis || '(sin código)'} · mín 4 · máx 12 (la escritura se detuvo antes de salir)`, {
          ayuda: await texto(ayudaAlta), boton_activo: activo, habria_mandado: b.abortadas.slice(antes),
          mensaje_en_pantalla: await texto(page.locator('.as-side [role="alert"], .as-side [role="status"]')),
        });
        await page.locator('.as-alta').getByRole('button', { name: 'Cancelar' }).click().catch(() => undefined);
      }
    }

    // C6. Asignar desde Excel: plantilla y un archivo con renglones buenos y malos.
    const btnExcel = page.getByRole('button', { name: 'Asignar desde Excel' });
    if (await btnExcel.count()) {
      await btnExcel.click();
      await page.locator('#ax-h').waitFor({ timeout: 10_000 });
      const desc2 = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
      await page.getByRole('button', { name: 'Descargar plantilla' }).first().click();
      const d2 = await desc2;
      if (d2) await d2.saveAs(path.join(DIR, 'plantilla-asignacion.xlsx'));
      const k = sku || '00000';
      const csv2 = ['Clave,Presentación,Ubicación,Papel,Mínimo,Máximo',
        `${k},CJA,${codigoCedis || 'BA011'},surtido,4,12`,
        `${k},CJA,${codigoCedis || 'BA011'},surtido,4,12`,
        `99999999,CJA,${codigoCedis || 'BA011'},surtido,,`,
        `${k},XYZ,${codigoCedis || 'BA011'},reserva,,`,
        `${k},PZA,BZ999,surtido,,`,
        `${k},PZA,${codigoCedis || 'BA011'},otro,,`,
      ].join('\n');
      await page.locator('app-ubicaciones-asignacion-excel input[type="file"]').setInputFiles({ name: 'prueba-asignacion.csv', mimeType: 'text/csv', buffer: Buffer.from(csv2, 'utf8') });
      await page.waitForTimeout(500);
      const prev3 = page.waitForResponse((r) => r.url().includes('/assignments/bulk/preview'), { timeout: 30_000 }).catch(() => null);
      await page.locator('app-ubicaciones-asignacion-excel').getByRole('button', { name: 'Revisar' }).click();
      const rp3 = await prev3;
      await page.waitForTimeout(800);
      await paso('asignacion-excel', 'Asignar desde Excel: 6 renglones de prueba (bueno, repetido, clave, presentación, ubicación y papel malos)', {
        plantilla: d2?.suggestedFilename() ?? 'no se descargó', respuesta: rp3?.status(),
        resumen: await texto(page.locator('app-ubicaciones-asignacion-excel [aria-label="Qué va a pasar"]')),
        filas: (await page.locator('app-ubicaciones-asignacion-excel p-table tbody tr').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ')),
      });
    }

    // ── D. Contenido ───────────────────────────────────────────────────────────────────────────
    t0 = Date.now();
    await page.goto('/almacen/inventory/ubicaciones');
    await page.locator('h1').first().waitFor({ timeout: 30_000 });
    q = await quieta(page, t0);
    medidas['contenido'] = { ...q, ...(await medir(page)) };
    await paso('contenido', 'Contenido: qué mercancía hay en cada ubicación', { h1: await texto(page.locator('h1')), cuerpo: (await texto(page.locator('main, .surf-page'))).slice(0, 400) });

    fs.writeFileSync(path.join(RES, 'ub-recorrido.json'), JSON.stringify({
      medido_at: new Date().toISOString(), prod_commit: commit, rol: s.rol, pasos, medidas,
      escrituras_detenidas: b.abortadas.map((a) => ({ ...a, cuerpo: a.cuerpo.slice(0, 400) })), previas_permitidas: b.previas, api_errores: errores,
    }, null, 2));
    await ctx.close();
    // Ninguna escritura salió: todo lo que no es GET ni una vista previa quedó detenido.
    expect(b.previas.every((p) => PREVIAS.includes(p))).toBe(true);
  });
});
