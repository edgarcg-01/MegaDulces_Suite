import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { sesion, contexto, blindar, quieta } from './comun';

/**
 * `[GP.RF]` Paso 2 de la auditoría de interfaces: SURTIR, en el celular (390 × 844, táctil).
 *
 * Los surtidores trabajan casi todo en «Surtir preventa» (30 días: 1,056 pedidos empezados, 925 cierres,
 * 84 rechazados); «Surtir» (Kepler) casi no se usa (66 tomas). Se miden las dos.
 *
 * SÓLO LECTURA: «Empezar a surtir», «Tomar siguiente» y «Terminar» escriben, así que no se tocan. Para
 * ver los controles de un renglón se abre un pedido que OTRO surtidor ya está surtiendo: marcar es
 * local hasta «Terminar», que no se toca. Con superadmin la bandeja trae todas las sucursales; con el
 * puesto de surtidor trae la suya (P-RF.1): lo que dependa de eso se declara.
 */

const RES = path.join(__dirname, '.resultados');
const SHOTS = path.join(RES, 'paso2');
const TAP = 44;

/** Controles visibles por encima de `limite` y los que no llegan a 44 px en algún eje. */
async function controles(page: Page, limite: number | null) {
  return page.evaluate(({ limite, TAP }) => {
    const sel = 'button, a[href], input:not([type=hidden]), [role=radio], [role=button], select';
    const vis = Array.from(document.querySelectorAll(sel)).filter((e) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(e as HTMLElement);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    });
    const arriba = limite == null ? vis : vis.filter((e) => (e as HTMLElement).getBoundingClientRect().top < limite);
    const chicos = vis
      .map((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return { t: ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.w < TAP || x.h < TAP);
    return { visibles: vis.length, antes_de_la_lista: arriba.length, chicos: chicos.length, ejemplos_chicos: chicos.slice(0, 8) };
  }, { limite, TAP });
}

test.describe('Paso 2 · Surtir en el celular', () => {
  test.use({ actionTimeout: 10_000 });
  const s = sesion();
  test.skip(!s.token, 'NO MEDIDO: sin MD_TOKEN_FILE no hay sesión');

  test('línea base: bandeja de preventa, un pedido en curso y Surtir (Kepler)', async ({ browser }) => {
    test.setTimeout(240_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const ctx = await contexto(browser, s.token, true);
    const page = await ctx.newPage();
    const { abortadas } = await blindar(page);
    const salida: Record<string, unknown> = { medido_at: new Date().toISOString(), rol: s.rol, viewport: '390x844 táctil' };

    // ── A. La bandeja de preventa ──
    let t0 = Date.now();
    await page.goto('/almacen/surtir-preventa');
    await page.getByRole('heading', { name: 'Pedidos de preventa', level: 1 }).waitFor({ timeout: 30_000 });
    const qA = await quieta(page, t0);
    const primera = page.locator('.sp-card').first();
    const hayTarjetas = await primera.count();
    const topPrimera = hayTarjetas ? Math.round((await primera.boundingBox())!.y) : null;
    salida['bandeja'] = {
      quieta_ms: qA.ms, seguia_cargando: qA.seguia_cargando,
      tarjetas: await page.locator('.sp-card').count(), grupos: await page.locator('.sp-grupo').count(),
      en_curso: await page.locator('.sp-card', { hasText: 'en curso' }).count(),
      primera_tarjeta_px: topPrimera,
      ...(await controles(page, topPrimera)),
    };
    await page.screenshot({ path: path.join(SHOTS, '01-bandeja.png'), fullPage: false });

    // ── B. Un pedido que otro surtidor está surtiendo: los controles del renglón ──
    const enCurso = page.locator('.sp-card', { hasText: 'en curso' }).first();
    if (await enCurso.count()) {
      t0 = Date.now();
      await enCurso.click();
      await page.getByRole('button', { name: 'Volver a la bandeja' }).waitFor({ timeout: 20_000 });
      const qB = await quieta(page, t0);
      const renglones = page.locator('.sp-ren-edit');
      const n = await renglones.count();
      const b: Record<string, unknown> = { abrir_ms: qB.ms, renglones: n, editable: n > 0 };
      if (n > 0) {
        const ok = page.locator('.sp-ok').first();
        const menos = page.locator('.sp-step button').first();
        const bo = await ok.boundingBox();
        const bm = await menos.boundingBox();
        b['boton_completo_px'] = bo ? { w: Math.round(bo.width), h: Math.round(bo.height) } : null;
        b['boton_menos_px'] = bm ? { w: Math.round(bm.width), h: Math.round(bm.height) } : null;
        b['alto_renglon_px'] = Math.round((await renglones.first().boundingBox())?.height ?? 0);
        b['renglones_por_pantalla'] = Math.floor(844 / Math.max(1, b['alto_renglon_px'] as number));
        await page.screenshot({ path: path.join(SHOTS, '02-pedido-sin-marcar.png') });
        // «No hubo» del primer renglón: cuántos toques de «−» hasta 0 (marcar es local).
        let toquesNoHubo = 0;
        for (let i = 0; i < 80; i++) {
          const leyenda = (await renglones.first().locator('.sp-ctrl-l').innerText()).trim();
          if (leyenda === 'no hubo') break;
          await menos.click();
          toquesNoHubo++;
        }
        b['toques_no_hubo_primer_renglon'] = toquesNoHubo;
        b['primer_renglon_pide'] = (await renglones.first().locator('.sp-ren-pedido').innerText()).replace(/\s+/g, ' ').trim();
        b['aparece_motivo'] = await page.locator('app-motivo-chips').count();
        await page.screenshot({ path: path.join(SHOTS, '03-no-hubo.png') });
        // Los demás, «Completo»: un toque por renglón.
        for (let i = 1; i < n; i++) await page.locator('.sp-ok').nth(i).click();
        const pie = page.locator('.sp-pie .sp-btn').last();
        b['boton_final'] = (await pie.innerText()).replace(/\s+/g, ' ').trim();
        b['boton_final_habilitado'] = await pie.isEnabled();
        b['toques_hasta_el_final'] = { abrir: 1, empezar: 1, renglones: n - 1 + toquesNoHubo, terminar: 1 };
        b['controles'] = await controles(page, null);
        await page.screenshot({ path: path.join(SHOTS, '04-listo-para-enviar.png'), fullPage: true });
      }
      salida['pedido_en_curso'] = b;
      await page.getByRole('button', { name: 'Volver a la bandeja' }).click();
    } else {
      salida['pedido_en_curso'] = 'NO MEDIDO: hoy no hay ningún pedido en curso en la bandeja';
    }

    fs.writeFileSync(path.join(RES, 'paso2-antes.json'), JSON.stringify(salida, null, 2));

    // ── C. Surtir (pedidos de Kepler) ──
    // No tiene <h1> (el título es un <strong>): se espera a su selector de almacén. Al ABRIR intenta
    // tomar trabajo (una escritura): se registra qué intentó, separado de lo de antes.
    const antesDeC = abortadas.length;
    t0 = Date.now();
    await page.goto('/almacen/surtir');
    // [GP.RF.41] El selector se nombra por su rótulo visible «Almacén» (antes aria-label «Almacén donde surtes»).
    await page.getByRole('combobox', { name: /^Almacén/ }).or(page.getByRole('button', { name: /Tomar siguiente/ })).first().waitFor({ timeout: 30_000 });
    const qC = await quieta(page, t0);
    salida['surtir_kepler'] = {
      quieta_ms: qC.ms, seguia_cargando: qC.seguia_cargando,
      tiene_h1: await page.locator('main h1').count(),
      select_nativo: await page.locator('main select').count(),
      opciones_almacen: await page.locator('main select option').allInnerTexts(),
      avisos: (await page.locator('main [role=alert], main [role=status]').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean),
      tomar_siguiente: await page.getByRole('button', { name: /Tomar siguiente/ }).count(),
      escrituras_al_abrir: abortadas.slice(antesDeC),
      ...(await controles(page, null)),
    };
    await page.screenshot({ path: path.join(SHOTS, '05-surtir-kepler.png') });

    salida['escrituras_abortadas'] = abortadas;
    fs.writeFileSync(path.join(RES, 'paso2-antes.json'), JSON.stringify(salida, null, 2));
    await ctx.close();
    // Nada salió: todo lo que no es GET se detuvo en el navegador (el blindaje). Lo que la pantalla
    // INTENTÓ escribir queda en `escrituras_abortadas` y es parte del hallazgo, no una falla.
    expect(salida['bandeja']).toBeTruthy();
  });
});
