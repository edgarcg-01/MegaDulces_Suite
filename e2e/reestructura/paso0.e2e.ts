import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { medir } from './medir';

/**
 * `[GP.RF.0]` Paso 0 de la auditoría de interfaces de la Fase GP
 * (`docs/IMPLEMENTACION/FASES/FASE_GP_AUDITORIA_INTERFACES.md`).
 *
 *  0.1 · el INSTRUMENTO acierta una página de control cuyas respuestas se conocen;
 *  0.2 · el BLINDAJE: contra prod, ninguna escritura sale del navegador (y el service worker no la cuela);
 *  0.3 · la LÍNEA BASE: cada pantalla del alcance, medida igual (pide MD_TOKEN_FILE; sin él, NO MEDIDO).
 */

const RES = path.join(__dirname, '.resultados');

/** Las interfaces del plan GP y las que tocó esta sesión, en el orden del recorrido del pedido. */
export const ALCANCE: { id: string; ruta: string; quien: string; movil?: boolean }[] = [
  { id: 'tablero', ruta: '/almacen/pedidos', quien: 'coordina y consulta' },
  { id: 'tablero-preventa', ruta: '/almacen/pedidos?origen=PREVENTA', quien: 'coordina y consulta' },
  { id: 'fila-surtido', ruta: '/almacen/pedidos?vista=fila', quien: 'coordina el surtido' },
  { id: 'surtir', ruta: '/almacen/surtir', quien: 'surtidor', movil: true },
  { id: 'surtir-preventa', ruta: '/almacen/surtir-preventa', quien: 'surtidor de sucursal', movil: true },
  { id: 'checar', ruta: '/almacen/checar', quien: 'checador', movil: true },
  { id: 'por-capturar', ruta: '/almacen/pedidos-por-capturar', quien: 'facturación' },
  { id: 'revision', ruta: '/almacen/pedidos/revision', quien: 'caja' },
  { id: 'guias', ruta: '/almacen/pedidos/guias', quien: 'caja' },
  { id: 'clientes-nuevos', ruta: '/almacen/clientes-nuevos', quien: 'encargado de sucursal' },
  { id: 'ubicaciones-mapa', ruta: '/almacen/ubicaciones', quien: 'almacén (fase UB, paso 1)' },
  { id: 'ubicaciones-contenido', ruta: '/almacen/inventory/ubicaciones', quien: 'almacén (fase UB, paso 2)' },
];

/** Sólo GET sale a la API; todo lo demás (incluida la telemetría de uso) se aborta y se cuenta. */
async function blindar(page: Page): Promise<{ abortadas: string[] }> {
  const abortadas: string[] = [];
  await page.route('**/api/**', (r) => {
    if (r.request().method() === 'GET') return r.continue();
    abortadas.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
    return r.abort('blockedbyclient');
  });
  return { abortadas };
}

test.describe('0.1 · control del instrumento', () => {
  test('acierta una página cuyas respuestas se conocen', async ({ page }) => {
    await page.setContent(`<!doctype html><html><head><style>
        body{margin:0;background:#fff;font-family:Arial} body *{font-size:14px} h1{font-size:24px!important;margin:0}
        td{font-size:12px!important} header{height:300px;overflow:hidden}
        button,input,a{display:inline-block;height:30px;vertical-align:top} #chico{height:16px;width:16px}
        table{border-collapse:collapse} td{padding:0}
      </style></head><body>
        <header><h1>Control</h1>
          <button>Guardar</button><button aria-label="Cerrar">x</button><button id="chico"></button>
          <a href="#x">Ver detalle</a><label for="a">Monto</label><input id="a"><input id="b">
          <p style="color:#777777">Gris claro</p>
          <p style="color:#000000">Negro $1,250.00 y 34 piezas, 12 %</p>
        </header>
        <table><tbody><tr><td>fila</td></tr></tbody></table>
        <div style="position:absolute;top:2000px"><button>Abajo</button><span>999</span></div>
      </body></html>`);
    const m = await medir(page);
    // Cada respuesta se conoce por construcción de la página:
    expect(m.controles, 'Guardar, Cerrar, el botón vacío, la liga y los dos campos (no «Abajo»)').toBe(6);
    expect(m.cifras, '$1,250.00 · 34 · 12 % (no el 999 de abajo)').toBe(3);
    expect(m.contraste_falla, '#777 sobre blanco = 4.48:1, la única bajo 4.5').toBe(1);
    expect(m.contraste_ejemplos[0].ratio).toBeCloseTo(4.48, 2);
    expect(m.tamanos_letra, '24 · 14 · 12').toBe(3);
    expect(m.letra_min_px).toBe(12);
    expect(m.marco_px, 'la primera fila empieza bajo un encabezado de 300 px').toBe(300);
    expect(m.h1).toEqual(['Control']);
    expect(m.objetivos_chicos, 'el botón de 16 px').toBe(1);
    expect(m.sin_nombre, 'el botón vacío y el campo sin etiqueta').toBe(2);
  });

  test('NEGATIVA: distingue 4.48:1 (falla) de 4.54:1 (pasa), y un botón con nombre no cuenta como sin nombre', async ({ page }) => {
    await page.setContent(`<!doctype html><body style="margin:0;background:#fff;font:14px Arial">
        <p style="color:#767676">Gris apenas suficiente</p><button>Con nombre</button></body>`);
    const m = await medir(page);
    expect(m.contraste_falla, '#767676 sobre blanco = 4.54:1 pasa AA').toBe(0);
    expect(m.sin_nombre).toBe(0);
  });
});

test.describe('0.2 · blindaje contra escrituras en prod', () => {
  test('una escritura no sale; una lectura sí; el service worker no controla la página', async ({ page }) => {
    const b = await blindar(page);
    await page.goto('/login');
    const r = await page.evaluate(async () => {
      const post = await fetch('/api/telemetry/suite', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
        .then((x) => `respondió ${x.status}`, () => 'abortada');
      const get = await fetch('/api/health').then((x) => x.status, () => -1);
      return { post, get, sw: navigator.serviceWorker?.controller ? 'controla' : 'ninguno' };
    });
    expect(r.post, 'el POST NO debe llegar al servidor').toBe('abortada');
    expect(b.abortadas).toContain('POST /api/telemetry/suite');
    expect(r.get, 'una lectura sí pasa (prueba de que el bloqueo es selectivo)').toBe(200);
    expect(r.sw).toBe('ninguno');
  });
});

test.describe('0.3 · línea base de las pantallas del alcance', () => {
  const archivo = process.env.MD_TOKEN_FILE;
  const token = archivo && fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8').trim() : '';
  test.skip(!token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión (la línea base se mide en prod con un usuario real)');

  test('cada pantalla, medida igual', async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    // Qué rol mide (sin imprimir el token): de eso depende lo que se ve.
    const carga = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8') || '{}');
    const filas: Record<string, unknown>[] = [];
    fs.mkdirSync(path.join(RES, 'paso0'), { recursive: true });
    for (const p of ALCANCE) {
      const ctx = await browser.newContext({
        viewport: p.movil ? { width: 390, height: 844 } : { width: 1366, height: 768 },
        serviceWorkers: 'block',
        ...(p.movil ? { hasTouch: true, isMobile: true } : {}),
      });
      await ctx.addInitScript((t) => { try { localStorage.setItem('auth_token', t as string); } catch { /* sin almacenamiento */ } }, token);
      const page = await ctx.newPage();
      const b = await blindar(page);
      const fallidas: string[] = [];
      const consola: string[] = [];
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) fallidas.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      page.on('console', (m) => { if (m.type() === 'error') consola.push(m.text().slice(0, 120)); });
      const t0 = Date.now();
      await page.goto(p.ruta);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
      const ms = Date.now() - t0;
      const url = new URL(page.url());
      const m = await medir(page);
      await page.screenshot({ path: path.join(RES, 'paso0', `${p.id}.png`) });
      filas.push({ ...p, url_final: url.pathname + url.search, ms_hasta_quieta: ms, ...m, api_fallidas: fallidas, escrituras_abortadas: b.abortadas, errores_consola: consola.length });
      await ctx.close();
    }
    fs.writeFileSync(path.join(RES, 'paso0-medicion.json'), JSON.stringify({ medido_at: new Date().toISOString(), rol: carga.role_name ?? carga.role ?? null, filas }, null, 2));
    // La sesión sirvió: ninguna pantalla rebotó al login.
    expect(filas.filter((f) => String(f.url_final).startsWith('/login')), 'el token no sirvió').toEqual([]);
  });
});
