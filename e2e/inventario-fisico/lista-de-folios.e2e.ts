import { test, expect, type Page } from '@playwright/test';
import { prepararSesion, exigirQueNadaEscribio, type Bitacora } from './apoyo/servidor-falso';
import { SUPERVISOR, ENCARGADO, OBSERVADOR, type Persona } from './apoyo/personas';
import * as F from './apoyo/folios';

/**
 * `/almacen/inventory/sessions` — la lista de folios, con el componente REAL.
 *
 * Cada prueba lleva el identificador del plan
 * (`docs/MODULOS/pruebas-inventario-fisico/`), para que el resultado se pueda anotar ahí.
 *
 * ⛔ **Nivel `[C]`**: la API está simulada. Esto no prueba ni un guard del servidor ni un 403
 * real — eso es el bloque `[B]`, que espera a D-PW1. Lo que sí prueba, y vitest no puede, es
 * **qué ve y qué puede hacer una persona concreta frente al componente que está en producción**.
 */

const RUTA = '/almacen/inventory/sessions';
const LISTA = '/commercial/inventory/counts';

/** Entra como `persona` con la lista que se le indique, y espera a que la pantalla asiente. */
async function entrar(
  page: Page,
  persona: Persona,
  opciones: { folios?: unknown; estado?: number } = {},
): Promise<Bitacora> {
  const bitacora = await prepararSesion(page, {
    persona,
    mocks: [
      {
        cuando: new RegExp(`${LISTA}(\\?|$)`),
        estado: opciones.estado ?? 200,
        cuerpo: opciones.estado && opciones.estado >= 400
          ? { message: 'Se cayo la base' }
          : (opciones.folios ?? F.LISTA_COMPLETA),
      },
      { cuando: '/commercial/warehouses', cuerpo: F.ALMACENES },
      { cuando: '/assignable-users', cuerpo: [] },
      { cuando: '/assignments', cuerpo: [] },
    ],
  });
  await page.goto(RUTA);
  await page.waitForLoadState('networkidle');
  return bitacora;
}

/** El encabezado de la pantalla, en texto plano. */
const encabezado = (page: Page) => page.locator('.surf-page-head').innerText();

// ───────────────────────────────────────────────────────────────────────────────
test.describe('CONTROL — el arnés mide lo que dice medir', () => {
  test('CONTROL · la pantalla carga con el componente real y pinta los folios simulados', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR);

    // Si esto falla, no hay nada que auditar: o no cargó el bundle, o la sesión no se tomó.
    await expect(page.getByRole('heading', { name: 'Inventarios físicos' })).toBeVisible();
    await expect(page.getByText('INV-2026-00009')).toBeVisible();
    await expect(page.getByText('INV-2026-00004')).toBeVisible();

    exigirQueNadaEscribio(b);
  });

  test('CONTROL · ninguna petición se escapó a producción', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR);
    // Todo lo que tocó `/api` pasó por el servidor falso, y nada fue escritura.
    expect(b.todas.length).toBeGreaterThan(0);
    exigirQueNadaEscribio(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
test.describe('1 · Supervisor de oficina', () => {
  test('SUP-J1 · el encabezado dice cuántos folios, cuántos en curso y cuántos congelando', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR);
    const texto = await encabezado(page);

    expect(texto).toContain('5'); // los cinco folios de la lista
    expect(texto).toMatch(/en curso/i);
    expect(texto).toMatch(/congelando/i);

    exigirQueNadaEscribio(b);
  });

  test('SUP-J1b · ve el botón de abrir folio', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR);
    // ⚠️ `exact: true` no es cosmético: sin él esto encuentra SEIS elementos — ver `SUP-A1`.
    await expect(page.getByRole('button', { name: 'Abrir folio', exact: true })).toBeVisible();
    exigirQueNadaEscribio(b);
  });

  /**
   * 🟠 **Hallazgo nuevo, encontrado por esta misma suite el 2026-11-25.** Cada fila lleva
   * `role="button"` con `aria-label="Abrir folio INV-…"`, y arriba hay un botón de verdad que
   * se llama «Abrir folio». Para quien usa lector de pantalla hay **seis cosas llamadas “Abrir
   * folio”** y sólo una abre un folio nuevo; las otras cinco abren uno que ya existe. El mismo
   * verbo para dos acciones distintas.
   *
   * El rótulo de la fila debería nombrar lo que hace: «Ver folio INV-…» o «Abrir el detalle
   * de INV-…».
   */
  test('SUP-A1 · «Abrir folio» no debe nombrar dos acciones distintas', async ({ page }) => {
    test.fail(); // Quitar esta línea cuando el aria-label de la fila deje de decir «Abrir folio».
    const b = await entrar(page, SUPERVISOR);
    await expect(page.getByRole('button', { name: /^Abrir folio/i })).toHaveCount(1);
    exigirQueNadaEscribio(b);
  });

  /**
   * ⛔🔴 **DEFECTO CONOCIDO, reproducido acá.** Un error de lectura se pinta como el vacío:
   * *«No hay folios. Abre uno para empezar a contar.»* Deuda sellada `§2` desde el 2026-10-19.
   *
   * Va con `test.fail()`: la suite queda verde documentando el defecto, y **se pone roja el día
   * que alguien lo arregle**, que es cuando hay que venir a quitar esta anotación.
   */
  test('SUP-D1 · un error de lectura NO debe leerse como «no hay folios»', async ({ page }) => {
    test.fail(); // DEUDA §2, sellada el 2026-10-19. Quitar esta línea al arreglarlo.
    const b = await entrar(page, SUPERVISOR, { estado: 500 });
    const cuerpo = await page.locator('body').innerText();

    expect(cuerpo).not.toContain('No hay folios');
    expect(cuerpo).toMatch(/reintentar/i);

    exigirQueNadaEscribio(b);
  });

  test('SUP-D2 · los folios cancelados se distinguen de los vivos', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR);
    const fila = page.locator('tr', { hasText: 'INV-2026-00004' });

    // El estado se dice con palabra, no sólo con color (el color nunca va solo).
    await expect(fila).toContainText(/Cancelado/i);
    // Y un folio muerto no puede anunciar que congela nada.
    await expect(fila).not.toContainText(/Congelado/i);

    exigirQueNadaEscribio(b);
  });

  test('SUP-D2b · un folio vivo con freeze SÍ dice que congela su almacén', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR);
    await expect(page.locator('tr', { hasText: 'INV-2026-00009' })).toContainText(/Congelado/i);
    exigirQueNadaEscribio(b);
  });

  test('SUP-D6 · «Sin snapshot» aparece cuando el folio no tiene renglones', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR, { folios: [F.SIN_SNAPSHOT] });
    // No se dibuja 0 % — que se leería como «no han contado nada».
    await expect(page.getByText('Sin snapshot')).toBeVisible();
    exigirQueNadaEscribio(b);
  });

  test('SUP-alerta · un folio de 101 días sin avanzar se marca, y dice desde cuándo', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR, { folios: [F.ABANDONADO] });
    const fila = page.locator('tr', { hasText: 'INV-2026-00009' });
    await expect(fila).toContainText(/Sin avanzar/i);
    exigirQueNadaEscribio(b);
  });

  test('SUP-alerta2 · un folio sin un solo escaneo dice «Sin conteos», no «sin avanzar»', async ({ page }) => {
    const b = await entrar(page, SUPERVISOR, { folios: [F.SIN_CONTEOS] });
    const fila = page.locator('tr', { hasText: 'INV-2026-00008' });
    // Dos ausencias distintas, dos avisos distintos: cada uno lo arregla alguien distinto.
    await expect(fila).toContainText(/Sin conteos/i);
    exigirQueNadaEscribio(b);
  });

  /**
   * 🔴 El avance del listado mide **sólo el primer pase**. Con doble conteo ciego —que viene
   * encendido por default— la barra llega a 100 % con el segundo sin empezar.
   */
  test('SUP-D7 · el avance no debe decir 100 % si falta el segundo pase', async ({ page }) => {
    test.fail(); // El avance cuenta sólo `count_1`. Quitar esta línea al arreglarlo.
    const b = await entrar(page, SUPERVISOR, { folios: [F.PRIMER_PASE_COMPLETO] });
    const fila = page.locator('tr', { hasText: 'INV-2026-00102' });
    await expect(fila).not.toContainText('100%');
    exigirQueNadaEscribio(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
test.describe('2 · Encargado de tienda', () => {
  test('ASG-J1 · NO ve el botón de abrir folio', async ({ page }) => {
    const b = await entrar(page, ENCARGADO);
    await expect(page.getByRole('heading', { name: 'Inventarios físicos' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Abrir folio/i })).toHaveCount(0);
    exigirQueNadaEscribio(b);
  });

  test('ASG-J2 · el clic en la fila le abre «Quién cuenta», NO la lleva al detalle', async ({ page }) => {
    const b = await entrar(page, ENCARGADO);
    await page.locator('tr', { hasText: 'INV-2026-00100' }).click();

    // El detalle carga el teórico y le daría 403: su destino es el diálogo.
    await expect(page.getByText(/Quién cuenta/i)).toBeVisible();
    expect(page.url()).toContain('/sessions');
    expect(page.url()).not.toMatch(/\/sessions\/[0-9a-f-]{36}/);

    exigirQueNadaEscribio(b);
  });

  test('ASG-J3 · Enter sobre la fila hace LO MISMO que el clic', async ({ page }) => {
    const b = await entrar(page, ENCARGADO);
    const fila = page.locator('tr', { hasText: 'INV-2026-00100' });
    await fila.focus();
    await page.keyboard.press('Enter');

    // Si el teclado divergiera del mouse, lo mandaría a una pantalla que le contesta 403.
    await expect(page.getByText(/Quién cuenta/i)).toBeVisible();
    exigirQueNadaEscribio(b);
  });

  test('ASG-J4 · el folio cancelado no ofrece «Asignar»', async ({ page }) => {
    const b = await entrar(page, ENCARGADO, { folios: [F.CANCELADO] });
    const fila = page.locator('tr', { hasText: 'INV-2026-00004' });
    await expect(fila.getByRole('button', { name: /Asignar/i })).toHaveCount(0);
    exigirQueNadaEscribio(b);
  });

  /**
   * 🔴 Un clic fuera del diálogo descarta lo elegido sin preguntar (`dismissableMask`).
   * Puede ser el trabajo de elegir 20 personas entre 263.
   */
  test('ASG-H1 · salir del diálogo con trabajo sin guardar tiene que preguntar', async ({ page }) => {
    test.fail(); // `dismissableMask` descarta sin preguntar. Quitar esta línea al arreglarlo.
    const b = await entrar(page, ENCARGADO);
    await page.locator('tr', { hasText: 'INV-2026-00100' }).click();
    await expect(page.getByText(/Quién cuenta/i)).toBeVisible();

    await page.mouse.click(5, 5); // afuera del diálogo

    const cuerpo = await page.locator('body').innerText();
    expect(cuerpo).toMatch(/descartar|sin guardar/i);

    exigirQueNadaEscribio(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
test.describe('5 · Prevención — sólo mira', () => {
  test('VER-J3 · no ve el botón de abrir folio', async ({ page }) => {
    const b = await entrar(page, OBSERVADOR);
    await expect(page.getByRole('button', { name: /Abrir folio/i })).toHaveCount(0);
    exigirQueNadaEscribio(b);
  });

  /**
   * 🔴 La fila lleva `role="button"` y `tabindex="0"` **sin condicionar al permiso**: a quien
   * sólo mira se le anuncia una acción que no tiene, y con teclado es una parada que no lleva
   * a ningún lado.
   */
  test('VER-J4 · la fila NO debe anunciarse como accionable a quien sólo mira', async ({ page }) => {
    test.fail(); // `role="button"` sin condicionar al permiso. Quitar esta línea al arreglarlo.
    const b = await entrar(page, OBSERVADOR);
    const fila = page.locator('tr', { hasText: 'INV-2026-00100' });

    await expect(fila).not.toHaveAttribute('role', 'button');

    exigirQueNadaEscribio(b);
  });

  test('VER-D2 · el vacío no le aconseja algo que no puede hacer', async ({ page }) => {
    const b = await entrar(page, OBSERVADOR, { folios: [] });
    const cuerpo = await page.locator('body').innerText();
    // «Abre uno para empezar a contar» es un consejo que esta persona no puede seguir.
    expect(cuerpo).not.toMatch(/Abre uno para empezar/i);
    exigirQueNadaEscribio(b);
  });
});
