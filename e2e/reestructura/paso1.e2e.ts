import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { medir } from './medir';
import { sesion, contexto, blindar, quieta, Recorrido } from './comun';

/**
 * `[GP.RF.1]` Paso 1 de la auditoría (`docs/IMPLEMENTACION/FASES/FASE_GP_AUDITORIA_INTERFACES.md` §5; los pasos, §6):
 * **Tablero + fila de surtido + detalle de un pedido de preventa**, desde la silla de quien coordina.
 *
 * La pregunta: ¿quien coordina ve en la primera pantalla qué pedido está atorado y qué sigue, sin
 * clic? Y ¿cuántos clics le cuesta pasar de «entro» a «prioricé», a «armé» y a «vi el pedido»?
 *
 * Recorre la versión que esté en prod y dice cuál es:
 *  - **antes** (sin GP.10.4): la fila vive en la pestaña «Consola de surtido» y la preventa en la
 *    pestaña «Preventa»;
 *  - **después** (con GP.10.4): las dos son vistas del Tablero.
 * Toda escritura se aborta en el navegador: «prioricé» y «armé» se cuentan hasta el clic que
 * ESCRIBIRÍA, que sale abortado y queda registrado.
 */

const RES = path.join(__dirname, '.resultados');

/** Lo que dice la primera pantalla sobre pedidos atorados, sin clic. */
async function avisosDeAtorado(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const alto = window.innerHeight;
    const out: string[] = [];
    const re = /atorad|vencid|desfase|Kepler aún|sigue autorizado|sin moverse/i;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const t = (n.textContent || '').trim();
      if (!t || !re.test(t)) continue;
      const el = n.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.top >= alto || r.bottom <= 0 || cs.visibility === 'hidden') continue;
      out.push(t.replace(/\s+/g, ' ').slice(0, 140));
    }
    return out;
  });
}

test.describe('1 · Tablero + fila de surtido + detalle de preventa (quien coordina)', () => {
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('recorrido: entro → veo lo atorado → priorizo → armo → abro un pedido de preventa', async ({ browser, request }) => {
    test.setTimeout(5 * 60_000);
    const commit = await request.get('/api/health').then((r) => r.json()).then((j) => j.commit as string, () => 'NO MEDIDO');
    const ctx = await contexto(browser, s.token);
    const page = await ctx.newPage();
    const b = await blindar(page);
    const fallidas: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) fallidas.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    const rec = new Recorrido(page);
    const pantallas: Record<string, Record<string, unknown>> = {};
    const foto = async (id: string) => page.screenshot({ path: path.join(RES, 'paso1', `${id}.png`) });
    fs.mkdirSync(path.join(RES, 'paso1'), { recursive: true });

    // ── Entro ────────────────────────────────────────────────────────────────────────────────
    const lista = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/warehouse/orders' && r.request().method() === 'GET', { timeout: 30_000 }).catch(() => null);
    let t0 = Date.now();
    await page.goto('/almacen/pedidos');
    let q = await quieta(page, t0);
    const resp = await lista;
    const cuerpo = resp ? await resp.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(cuerpo.toString('utf8')); } catch { /* sin cuerpo */ }
    const items = Array.isArray(json['items']) ? (json['items'] as unknown[]).length : null;
    const version = (await page.locator('nav.gp-vistas').count()) > 0 ? 'despues' : 'antes';
    pantallas['tablero'] = {
      ...q, url: page.url(), ...(await medir(page)),
      lista: { bytes: cuerpo.length, filas: items, llaves: Object.keys(json).slice(0, 12), topada_a_2000: items === 2000 },
      atorado_a_la_vista: await avisosDeAtorado(page),
    };
    await foto(`${version}-1-tablero`);
    const enTablero = rec.pasos.length;

    // ── A la fila de surtido ─────────────────────────────────────────────────────────────────
    t0 = Date.now();
    if (version === 'despues') await rec.clic(page.locator('nav.gp-vistas').getByRole('link', { name: 'Fila de surtido' }), 'navega', 'ir a la fila de surtido');
    else await rec.clic(page.getByRole('link', { name: 'Consola de surtido' }).first(), 'navega', 'pestaña «Consola de surtido»');
    // Una navegación de la SPA no mueve `networkidle`: sin esperar la ruta, se mide la pantalla anterior
    // (le pasó a la primera corrida, 2026-11-17).
    await page.waitForURL(version === 'despues' ? /vista=fila/ : /\/almacen\/surtido-consola/, { timeout: 15_000 });
    await page.locator('#gp-fila-h, .gp-empty').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    q = await quieta(page, t0);
    const filasOla = page.locator('table.gp-table tbody tr').filter({ has: page.getByRole('button', { name: /Marcar urgente|Quitar urgente/ }) });
    let olas = await filasOla.count();
    const almacenInicial = (await page.locator('.gp-meta').first().innerText().catch(() => '')).slice(0, 120);
    // Quien maneja varios almacenes ve el PRIMERO de la lista; si su fila está vacía, elige otro.
    // Se elige uno que la base dice que tiene surtidos sin terminar (Canindo, medido el 2026-11-17).
    let cambioDeAlmacen: Record<string, unknown> = { hizo_falta: false };
    const selector = page.locator('.gp-actions p-select').first();
    if (olas === 0 && (await selector.count())) {
      await rec.clic(selector, 'decide', 'abrir el selector de almacén (quien maneja varios)');
      const opcion = page.getByRole('option', { name: /Canindo/ }).first();
      // El desplegable se pinta un instante después del clic: contarlo en seco falla a veces (2026-11-17).
      if (await opcion.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) {
        await rec.clic(opcion, 'decide', 'elegir el almacén');
        await page.locator('#gp-fila-h, .gp-empty').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
        await quieta(page);
        olas = await filasOla.count();
      } else await page.keyboard.press('Escape');
      cambioDeAlmacen = { hizo_falta: true, de: almacenInicial, a: (await page.locator('.gp-meta').first().innerText().catch(() => '')).slice(0, 120), olas_tras_cambiar: olas };
    }
    const tiempos = await page.locator('table.gp-table td[data-label="Tiempo"]').allInnerTexts().catch(() => []);
    pantallas['fila'] = {
      ...q, url: page.url(), ...(await medir(page)),
      almacen_al_entrar: almacenInicial, cambio_de_almacen: cambioDeAlmacen,
      almacenes_en_selector: await page.locator('p-select[arialabel="Almacén"], p-select[ariaLabel="Almacén"]').count(),
      olas_en_fila: olas, tiempos_de_las_olas: tiempos.slice(0, 30),
      atorado_a_la_vista: await avisosDeAtorado(page),
    };
    await foto(`${version}-2-fila`);
    const enFila = rec.pasos.length;

    // ── Priorizo: marcar urgente el primero de la fila (la escritura sale abortada) ─────────────
    let priorizo: Record<string, unknown> = { posible: false, motivo: 'la fila de este almacén no tiene surtidos' };
    if (olas > 0) {
      await rec.clic(filasOla.first().getByRole('button', { name: 'Marcar urgente' }), 'decide', 'marcar urgente');
      await rec.teclea(page.locator('#gp-motivo'), 'auditoria GP.RF.1 (no se envia)', 'motivo de la urgencia');
      const antes = b.abortadas.length;
      await rec.clic(page.locator('#gp-confirm-ok'), 'confirma', 'confirmar «Sí, marcar urgente»');
      await page.waitForTimeout(1500);
      priorizo = { posible: true, escritura_abortada: b.abortadas.slice(antes), ...rec.cuenta(enFila) };
      // Cierra la confirmación si quedó abierta (no lo cuenta: es limpieza de la prueba).
      await page.getByRole('button', { name: 'Volver' }).first().click({ timeout: 2000 }).catch(() => undefined);
    }
    const trasPriorizar = rec.pasos.length;

    // ── Armo: «Armar surtidos ahora» (la escritura sale abortada) ─────────────────────────────
    const armarBtn = page.getByRole('button', { name: 'Armar surtidos ahora' });
    let armo: Record<string, unknown> = { posible: false, motivo: 'no hay botón de armar' };
    if (await armarBtn.count()) {
      if (await armarBtn.isDisabled()) armo = { posible: false, motivo: 'botón deshabilitado: no hay pedidos por armar' };
      else {
        const antes = b.abortadas.length;
        await rec.clic(armarBtn, 'decide', 'armar surtidos ahora');
        await page.waitForTimeout(1500);
        armo = { posible: true, escritura_abortada: b.abortadas.slice(antes), ...rec.cuenta(trasPriorizar) };
      }
    }
    const porArmarTexto = await page.locator('section[aria-labelledby="gp-arm-h"]').innerText().catch(() => '');
    pantallas['fila']['por_armar_texto'] = porArmarTexto.replace(/\s+/g, ' ').slice(0, 400);
    const trasArmar = rec.pasos.length;

    // ── Abro un pedido de preventa ───────────────────────────────────────────────────────────
    t0 = Date.now();
    if (version === 'despues') await rec.clic(page.locator('nav.gp-vistas').getByRole('link', { name: 'Pedidos' }), 'navega', 'volver a la lista de pedidos');
    else await rec.clic(page.getByRole('link', { name: 'Preventa', exact: true }).first(), 'navega', 'pestaña «Preventa»');
    if (version === 'despues') await page.waitForURL((u) => u.pathname === '/almacen/pedidos' && !u.search.includes('vista=fila'), { timeout: 15_000 });
    else await page.waitForURL(/\/almacen\/pedidos\/preventa/, { timeout: 15_000 });
    await page.locator('tbody tr').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    q = await quieta(page, t0);
    pantallas['lista_preventa'] = { ...q, url: page.url(), ...(await medir(page)), atorado_a_la_vista: await avisosDeAtorado(page) };
    await foto(`${version}-3-lista-preventa`);
    const filaPd = page.locator('tbody tr').filter({ hasText: /PD-/ }).first();
    // Con GP.10.4 la preventa vive en el Tablero, pero puede no estar en la primera página (la lista
    // va por fecha): quien la busca elige el origen «Preventa». Esos clics se cuentan.
    if (version === 'despues' && !(await filaPd.count())) {
      await rec.clic(page.locator('p-select[arialabel="Origen"], p-select[ariaLabel="Origen"]').first(), 'decide', 'abrir el filtro de origen');
      const pv = page.getByRole('option', { name: 'Preventa' }).first();
      if (await pv.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) {
        await rec.clic(pv, 'decide', 'elegir «Preventa»');
        await page.locator('tbody tr').filter({ hasText: /PD-/ }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await quieta(page);
      } else await page.keyboard.press('Escape');
    }
    let detalle: Record<string, unknown> = { posible: false, motivo: 'ninguna fila con PD- a la vista' };
    if (await filaPd.count()) {
      t0 = Date.now();
      await rec.clic(filaPd, 'abre', 'abrir el pedido de preventa');
      await page.locator('.p-drawer').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
      q = await quieta(page, t0);
      detalle = { posible: true, ...q, texto: (await page.locator('.p-drawer').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600), ...rec.cuenta(trasArmar) };
      await foto(`${version}-4-detalle-pd`);
    }

    // ── Veo los atorados que la fila cuenta (GP.RF.15) ──────────────────────────────────────────
    // Tarea aparte, con su propio contador: se entra directo a la fila del almacén ya elegido y se
    // sigue la liga. Cruce 1 en la pantalla viva: la cifra de la fila = la de la lista a la que lleva.
    const pAt = await ctx.newPage();
    const bAt = await blindar(pAt);
    await pAt.goto(version === 'despues' ? '/almacen/pedidos?vista=fila' : '/almacen/surtido-consola');
    await pAt.locator('#gp-fila-h, .gp-empty').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    await quieta(pAt);
    // La cifra se lee de ESTA página (el almacén puede no ser el del recorrido de arriba).
    const textoArmar = await pAt.locator('section[aria-labelledby="gp-arm-h"]').innerText().catch(() => '');
    const cifraFila = Number((/(\d+) pedidos? sigue[n]? autorizados?/.exec(textoArmar) || [])[1] ?? NaN);
    let atorados: Record<string, unknown> = { posible: false, cifra_fila: cifraFila, motivo: 'la fila no liga los atorados (versión sin GP.RF.15): «revísalos en Kepler»' };
    const ligaAt = pAt.locator('section[aria-labelledby="gp-arm-h"] a.gp-liga');
    if (await ligaAt.count()) {
      const recAt = new Recorrido(pAt);
      t0 = Date.now();
      await recAt.clic(ligaAt, 'abre', 'ver los atorados en el Tablero');
      await pAt.waitForURL(/kepler_status=AUTORIZADO/, { timeout: 15_000 });
      await pAt.getByText('Kepler sigue teniendo como').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      q = await quieta(pAt, t0);
      const todos = Number(((await pAt.locator('.gp-chip').first().innerText().catch(() => '')).match(/(\d[\d,]*)/) || [])[1]?.replace(/,/g, '') ?? NaN);
      atorados = {
        posible: true, ...q, url: pAt.url(), cifra_fila: cifraFila, cifra_tablero: todos, cuadra: todos === cifraFila,
        filas_pintadas: await pAt.locator('tbody tr').count(), ...recAt.cuenta(),
        nota: (await pAt.locator('.gp-note').filter({ hasText: 'Kepler sigue teniendo' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300),
      };
      await pAt.screenshot({ path: path.join(RES, 'paso1', `${version}-5-atorados.png`) });
    }
    b.abortadas.push(...bAt.abortadas);
    await pAt.close();

    const resultado = {
      medido_at: new Date().toISOString(), prod_commit: commit, version, rol: s.rol,
      clics: {
        entro_a_fila: rec.pasos.slice(enTablero, enFila),
        priorizo, armo, detalle_pd: detalle, atorados,
        total: rec.cuenta(), pasos: rec.pasos,
      },
      pantallas, escrituras_abortadas: b.abortadas, api_fallidas: fallidas,
    };
    fs.writeFileSync(path.join(RES, `paso1-${version}.json`), JSON.stringify(resultado, null, 2));
    await ctx.close();
    // La sesión sirvió y ninguna escritura salió a prod.
    expect(String(page.url())).not.toContain('/login');
    expect(b.abortadas.every((a) => !a.startsWith('GET'))).toBe(true);
  });
});
