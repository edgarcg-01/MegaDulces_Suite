import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, blindar } from './comun';

/**
 * `[GP.RF.30]` «Salir» de Surtir regresa a la pantalla de donde se llegó.
 *
 * Lo encontró Edgar en prod el 2026-11-17: *«este botón no sirve, te arroja al inicio directo»*. Iba
 * fijo a `/almacen`, que brinca a la primera pantalla del área. Mientras prod no traiga el arreglo,
 * esta prueba sale ROJA, y ése es su «antes». Sólo lectura: Surtir intenta tomar trabajo al abrirse,
 * y esa escritura se detiene.
 */
const RES = path.join(__dirname, '.resultados');

test.describe('GP.RF.30 · Salir de Surtir', () => {
  test.use({ actionTimeout: 15_000 });
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('del Tablero a Surtir, y «Salir» regresa al Tablero', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await contexto(browser, s.token);
    const page = await ctx.newPage();
    await blindar(page);
    await page.goto('/almacen/pedidos');
    await page.getByRole('heading', { name: 'Pedidos', level: 1 }).waitFor({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Surtir', exact: true }).click();
    await page.waitForURL('**/almacen/surtir', { timeout: 30_000 });
    await page.getByRole('button', { name: /Salir/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/almacen/surtir'), { timeout: 30_000 });
    const llego = new URL(page.url()).pathname;
    fs.mkdirSync(RES, { recursive: true });
    fs.writeFileSync(path.join(RES, 'salir-foco.json'), JSON.stringify({ medido_at: new Date().toISOString(), rol: s.rol, salio_a: llego }, null, 2));
    await ctx.close();
    expect(llego, 'Salir regresa a la pantalla de donde se llegó').toBe('/almacen/pedidos');
  });
});
