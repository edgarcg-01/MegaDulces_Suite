import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * 🏦 CAJA GENERAL · LA VENTANILLA — cómo se va a trabajar, recorrido de punta a punta.
 *
 * Fase LE, ADR-112, `docs/IMPLEMENTACION/FASES/FASE_LE_LIBRO_DE_EFECTIVO.md` §5.2–5.3. Cada `test`
 * es una de las cinco situaciones del día (pagar, por explicar, ruta, custodia, cierre) y afirma
 * la regla V1–V9 que la gobierna. Cada regla lleva su PRUEBA NEGATIVA: el camino que la rompería
 * se intenta y se verifica que NO pasa.
 *
 * Corre sobre el PROTOTIPO estático (`ventanilla.html`, por `file://`), no sobre la app: `CLAUDE.md`
 * prohíbe levantar el front o el back en local, y la pantalla real no existe todavía (E6 espera 5
 * cierres limpios del libro). Esto es el contrato que la pantalla real tendrá que cumplir.
 *
 * La máquina CAOS no vive en la pantalla: `window.__caos.entrega(codigo, monto, usuario)` simula
 * lo que en producción llega por evento desde el equipo.
 *
 *   npx playwright test -c e2e/ventanilla/playwright.config.ts
 */

const PAGINA = pathToFileURL(process.env.VENTANILLA_PROTOTIPO || resolve(__dirname, 'ventanilla.html')).href;

const kpi = (p: Page, id: 'maquina' | 'cajon') => p.locator(`#kpi-${id}`);
const entrega = (p: Page, codigo: string | null, monto: number, usuario = 'Usuario 003') =>
  p.evaluate(([c, m, u]) => (window as any).__caos.entrega(c, m, u), [codigo, monto, usuario] as const);
const pieza = (p: Page, grupo: string, denom: number | string, n: number) =>
  p.fill(`[data-grupo="${grupo}"][data-denom="${denom}"]`, String(n));
const verComo = (p: Page, rol: 'cajera' | 'tesoreria') => p.click(`[data-rol="${rol}"]`);
const libro = (p: Page) => p.getByTestId('asiento');

test.beforeEach(async ({ page }) => { await page.goto(PAGINA); });

test.describe('1 · Pagar: pagar ES registrar, en un solo acto (V2, V3, V4)', () => {
  test('con vale aprobado: código → la máquina entrega → piezas del cajón → firma de quien recibe', async ({ page }) => {
    await page.getByTestId('pagar-p1').getByRole('button', { name: 'Pagar' }).click();
    const codigo = (await page.getByTestId('codigo').textContent())!.trim();
    expect(codigo).toMatch(/^[A-Z2-9]{4}-\d$/);
    const registrar = page.locator('#btn-registrar');
    await expect(registrar, 'sin la máquina, no se registra').toBeDisabled();

    await entrega(page, codigo, 780);                       // $796.50 → $780 de billetes de la máquina
    await expect(page.getByTestId('maquina-ok')).toBeVisible();
    for (const [d, n] of [[10, 1], [5, 1], [1, 1], [0.5, 1]] as const) await pieza(page, 'pago', d, n);  // $16.50 del cajón
    await expect(registrar, '[negativa] sin la firma de quien recibe, no se registra').toBeDisabled();

    await page.fill('#firma-recibe', 'Encargado de nómina CEDIS');
    await expect(registrar).toBeEnabled();
    await registrar.click();

    await expect(page.getByTestId('pagar-p1'), 'el documento sale de «Por pagar»').toHaveCount(0);
    await expect(libro(page).first(), 'queda en el libro con su código: nadie lo copia después').toContainText(codigo);
    await expect(kpi(page, 'maquina')).toHaveText('$411,520.00');
    await expect(kpi(page, 'cajon')).toHaveText('$31,733.50');
  });

  test('[negativa] las piezas del cajón tienen que sumar exacto lo que toca', async ({ page }) => {
    await page.getByTestId('pagar-p1').getByRole('button', { name: 'Pagar' }).click();
    const codigo = (await page.getByTestId('codigo').textContent())!.trim();
    await entrega(page, codigo, 780);
    await pieza(page, 'pago', 10, 2);                       // $20 en vez de $16.50
    await page.fill('#firma-recibe', 'Encargado');
    await expect(page.locator('#btn-registrar')).toBeDisabled();
  });

  test('sin vale aprobado: el código no sale hasta que Tesorería firma, y la cajera no puede firmar', async ({ page }) => {
    await page.getByTestId('pagar-p2').getByRole('button', { name: 'Pagar' }).click();
    await expect(page.getByTestId('espera-firma')).toBeVisible();
    await expect(page.getByTestId('codigo'), '[negativa] sin firma no hay código').toHaveCount(0);
    await expect(page.locator('#vista-cajera [data-acc="firmar"]'), '[negativa] la cajera no tiene botón de firmar (V9)').toHaveCount(0);

    await verComo(page, 'tesoreria');
    await page.getByTestId('cola-firmar').getByRole('button', { name: 'Firmar' }).click();
    await verComo(page, 'cajera');
    await expect(page.getByTestId('codigo')).toBeVisible();
  });
});

test.describe('2 · Por explicar: lo que sale sin orden se ve en segundos y con nombre (V2)', () => {
  test('un retiro sin código cae a nombre de quien lo sacó, avisa a Tesorería y se explica en la fila', async ({ page }) => {
    await page.click('#sim-retiro-sin-codigo');
    const fila = page.getByTestId('cola-explicar').locator('tr[data-testid^="explicar-"]');
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText('Usuario 002');
    await expect(fila).toContainText('$8,000.00');
    await expect(kpi(page, 'maquina'), 'la máquina se cuenta sola: el dinero ya no está').toHaveText('$404,300.00');

    await verComo(page, 'tesoreria');
    await expect(page.getByTestId('aviso').first()).toContainText('Retiro sin código');
    await verComo(page, 'cajera');

    await fila.getByRole('button', { name: 'Explicar' }).click();
    await page.fill('#exp-persona', 'Compras');
    await page.fill('#exp-motivo', 'Compra urgente de empaque');
    await page.click('#btn-exp-custodia');
    await expect(fila).toHaveCount(0);
    await expect(page.getByTestId('cola-custodias')).toContainText('Compras');
  });

  test('[negativa] un código usado por MÁS de lo ordenado también cae a Por explicar', async ({ page }) => {
    await page.getByTestId('pagar-p3').getByRole('button', { name: 'Pagar' }).click();
    const codigo = (await page.getByTestId('codigo').textContent())!.trim();
    await entrega(page, codigo, 5000);                      // la orden era por $3,240
    await expect(page.getByTestId('cola-explicar').locator('tr[data-testid^="explicar-"]')).toHaveCount(1);
    await expect(page.getByTestId('maquina-ok'), 'la orden no se da por cumplida').toHaveCount(0);
  });
});

test.describe('2b · Tesorería: firma, no opera (V9)', () => {
  test('[negativa] Tesorería no ve el panel de operar ni «Cerrar el día»; su aviso lleva al retiro', async ({ page }) => {
    await page.click('#sim-retiro-sin-codigo');
    await verComo(page, 'tesoreria');
    await expect(page.locator('#btn-cerrar')).toBeHidden();
    await expect(page.getByTestId('panel')).toBeHidden();
    await page.getByTestId('aviso').first().getByRole('button', { name: 'Ver' }).click();
    await expect(page.getByTestId('panel')).toContainText('Explicar un retiro sin código');
    await expect(page.getByTestId('panel')).toContainText('$8,000.00');
  });
});

test.describe('3 · Cobro de ruta: el depósito se empareja solo (V5)', () => {
  test('el depósito que cuadra con Kepler se recibe con un clic', async ({ page }) => {
    const fila = page.getByTestId('ruta-r22');
    await expect(fila).toContainText('cuadra con Kepler');
    await fila.getByRole('button', { name: 'Recibir' }).click();
    await page.click('#btn-recibir');
    await expect(fila).toHaveCount(0);
    await expect(libro(page).first()).toContainText('Ruta 22');
  });

  test('lo que la ruta dejó en el cajón se cuenta por pieza en la fila de esa ruta', async ({ page }) => {
    await page.getByTestId('ruta-r27').getByRole('button', { name: 'Contar cajón' }).click();
    for (const [d, n] of [[20, 2], [5, 1], [2, 1], [1, 1]] as const) await pieza(page, 'ruta', d, n);   // $48
    await page.click('#btn-recibir');
    await expect(libro(page).first()).not.toContainText('pendiente');
    await expect(kpi(page, 'cajon')).toHaveText('$31,798.00');
  });

  test('[negativa] lo que falta queda pendiente a nombre de la ruta, no se absorbe', async ({ page }) => {
    await page.getByTestId('ruta-r27').getByRole('button', { name: 'Contar cajón' }).click();
    await pieza(page, 'ruta', 20, 2);                       // $40 de $48
    await page.click('#btn-recibir');
    await expect(libro(page).first()).toContainText('pendiente a nombre de Ruta 27 $8.00');
  });
});

test.describe('4 · Custodia: dinero sin documento = custodia con nombre (V6, D3, D14)', () => {
  const pedir = async (p: Page, persona: string, billetesDe500: number) => {
    await p.click('#btn-nueva-custodia');
    await p.fill('#cus-persona', persona);
    await p.fill('#cus-motivo', 'Compra urgente');
    await pieza(p, 'cus', 500, billetesDe500);
    await p.click('#btn-cus-pedir');
  };

  test('debajo del umbral sale el código; al usarlo, la custodia queda abierta a su nombre', async ({ page }) => {
    await pedir(page, 'Compras', 12);                       // $6,000
    const codigo = (await page.getByTestId('codigo').textContent())!.trim();
    await expect(page.getByTestId('espera-firma')).toHaveCount(0);
    await entrega(page, codigo, 6000);
    await expect(page.getByTestId('cola-custodias')).toContainText('Compras');
    await expect(page.getByTestId('cola-custodias')).toContainText('$6,000.00');
  });

  test('[negativa] desde $10,000 pide la firma de Tesorería antes del código', async ({ page }) => {
    await pedir(page, 'Compras', 24);                       // $12,000
    await expect(page.getByTestId('espera-firma')).toBeVisible();
    await expect(page.getByTestId('codigo')).toHaveCount(0);
  });

  test('[negativa] dos de $6,000 el mismo día a la misma persona: la segunda pide firma (contra el fraccionamiento)', async ({ page }) => {
    await pedir(page, 'Compras', 12);
    await entrega(page, (await page.getByTestId('codigo').textContent())!.trim(), 6000);
    await pedir(page, 'Compras', 12);
    await expect(page.getByTestId('espera-firma')).toContainText('suma $12,000.00');
    await expect(page.getByTestId('codigo')).toHaveCount(0);
  });

  test('rendir cierra la custodia sólo si comprobantes + regreso = lo que se llevó', async ({ page }) => {
    await page.getByTestId('custodia-c1').getByRole('button', { name: 'Rendir' }).click();
    await page.fill('#ren-comprobado', '4500');
    await expect(page.locator('#btn-rendir'), '[negativa] faltan $500 por explicar').toBeDisabled();
    await pieza(page, 'ren', 500, 1);
    await page.click('#btn-rendir');
    await expect(page.getByTestId('custodia-c1')).toHaveCount(0);
  });
});

test.describe('5 · Cierre: testigos, no una resta (V7, V8, V9, LE.0.7)', () => {
  const contarExacto = async (p: Page, ajuste: Record<string, number> = {}, ajusteUsd: Record<string, number> = {}) => {
    const { cajon, usd } = await p.evaluate(() => (window as any).__caos.estado() as { cajon: Record<string, number>; usd: Record<string, number> });
    for (const [d, n] of Object.entries(cajon)) await pieza(p, 'cierre', d, n + (ajuste[d] || 0));
    for (const [d, n] of Object.entries(usd)) await pieza(p, 'cierre-usd', d, n + (ajusteUsd[d] || 0));
  };

  test('[negativa] los dólares también se cuentan a ciegas, y su diferencia queda en dólares con nombre', async ({ page }) => {
    await expect(kpi(page, 'usd' as any)).toContainText('US$');
    await page.click('#btn-cerrar');
    await expect(page.locator('#kpi-usd'), 'mientras se cuenta, tampoco se ven los dólares').toHaveText('contando a ciegas');
    await contarExacto(page, {}, { 100: -1 });
    await page.click('#btn-contar');
    await expect(page.getByTestId('pendientes')).toContainText('Diferencia de dólares US$-100.00');
  });

  test('[negativa] mientras se cuenta, el esperado NO se ve (conteo ciego)', async ({ page }) => {
    await page.click('#btn-cerrar');
    await expect(page.locator('[data-grupo="cierre"]').first()).toBeVisible();
    await expect(page.getByTestId('esperado')).toHaveCount(0);
    // Y tampoco por otra puerta: el saldo del cajón en el encabezado ES el esperado.
    await expect(kpi(page, 'cajon')).not.toContainText('$');
    await expect(page.locator('body')).not.toContainText('$31,750.00');
  });

  test('ningún efectivo se teclea como importe: todo es por pieza (V7)', async ({ page }) => {
    await page.click('#btn-cerrar');
    await expect(page.locator('#panel input:not([data-denom])'), 'el cierre no tiene campo de importe').toHaveCount(0);
    await page.click('#btn-nueva-custodia');
    await expect(page.locator('#panel input[type="number"]:not([data-denom])'), 'la custodia tampoco').toHaveCount(0);
  });

  test('cada diferencia queda pendiente con su responsable, y el retiro sin explicar también', async ({ page }) => {
    await page.click('#sim-retiro-sin-codigo');
    await page.click('#btn-cerrar');
    await contarExacto(page, { 10: -1 });                   // falta una moneda de $10
    await page.click('#btn-contar');
    const pend = page.getByTestId('pendientes');
    await expect(pend).toContainText('Diferencia del cajón');
    await expect(pend).toContainText('a nombre de la cajera');
    await expect(pend).toContainText('a nombre de Usuario 002');
  });

  test('cuadrado y firmado por Tesorería, el día cerrado ya no recibe movimientos', async ({ page }) => {
    await page.click('#btn-cerrar');
    await contarExacto(page);
    await page.click('#btn-contar');
    await expect(page.getByTestId('pendientes')).toContainText('el día cuadra');
    await page.click('#btn-pedir-cierre');
    await expect(page.locator('#vista-cajera [data-acc="firmar"]'), '[negativa] la cajera no firma su cierre').toHaveCount(0);
    await verComo(page, 'tesoreria');
    await page.getByTestId('cola-firmar').getByRole('button', { name: 'Firmar' }).click();
    await verComo(page, 'cajera');
    await expect(page.locator('#banda-cerrado')).toBeVisible();
    await expect(page.getByTestId('pagar-p1').getByRole('button', { name: 'Pagar' }), '[negativa] no se paga en un día cerrado').toBeDisabled();
    await expect(page.locator('#btn-nueva-custodia')).toBeDisabled();
  });

  test('[negativa] un cajón arriba del tope se señala para depositar el excedente (V1)', async ({ page }) => {
    await page.click('#btn-cerrar');
    await contarExacto(page, { 500: 40 });                  // +$20,000 → $51,750
    await page.click('#btn-contar');
    await expect(page.getByTestId('pendientes')).toContainText('arriba del tope');
  });
});

test.describe('6 · Con el volumen de un día real (26 pagos, 47 atrasados, 7 mal fechados)', () => {
  test('lo de hoy y lo atrasado NO se mezclan: los 47 de octubre se abren aparte y se concilian, no se pagan', async ({ page }) => {
    await expect(page.locator('#n-pagar')).toHaveText('26');
    await expect(page.locator('#n-atrasados')).toHaveText('47');
    await expect(page.locator('[data-testid^="atrasado-"]'), '[negativa] cerrados por defecto').toHaveCount(0);
    await page.click('#btn-atrasados');
    await expect(page.locator('[data-testid^="atrasado-"]')).toHaveCount(47);
    await page.getByTestId('atrasado-a1').getByRole('button', { name: 'Conciliar' }).click();
    await expect(page.locator('#n-atrasados')).toHaveText('46');
    await expect(libro(page).first()).toContainText('atrasado de octubre');
    await expect(page.getByTestId('mal-fechados'), 'los mal fechados se declaran, con su importe').toContainText('7 documentos');
  });

  test('una sola búsqueda para todas las listas, sin acentos y con el importe como se escriba', async ({ page }) => {
    const buscar = page.locator('#buscar');
    await buscar.fill('$12,480');
    await expect(page.getByTestId('pagar-p2')).toBeVisible();
    await expect(page.locator('#n-pagar')).toHaveText(/^1 de 26$/);
    await buscar.fill('padre hidalgo');
    await expect(page.locator('[data-testid^="ruta-"]')).toHaveCount(2);
    await buscar.fill('PAPELERIA');
    await expect(page.getByTestId('pagar-p2'), 'sin acento encuentra «Papelería»').toBeVisible();
    await buscar.fill('0023110');
    await expect(page.getByTestId('atrasado-a1'), 'si lo buscado está en los atrasados, se abren solos').toBeVisible();
    await buscar.fill('zzzz');
    await expect(page.getByTestId('cola-pagar')).toContainText('Nada coincide con la búsqueda');
  });

  test('[negativa] un documento sin su cuenta de Kepler no se paga, y la fila dice por qué', async ({ page }) => {
    await expect(page.getByTestId('pagar-p7').getByRole('button', { name: 'Pagar' })).toBeDisabled();
    await expect(page.getByTestId('pagar-p7').getByTestId('sin-cuenta')).toHaveText('falta su cuenta de Kepler');
    await expect(page.getByTestId('pagar-p1').getByRole('button', { name: 'Pagar' })).toBeEnabled();
  });

  test('[negativa] en las listas no hay botones naranjas: la única primaria es la del panel', async ({ page }) => {
    await expect(page.locator('#vista-cajera .cola .btn.primario')).toHaveCount(0);
    await page.getByTestId('pagar-p1').getByRole('button', { name: 'Pagar' }).click();
    await expect(page.locator('#panel .btn.primario')).toHaveCount(1);
  });

  test('el cheque que dejó la ruta cubre su parte, anotado con banco y número', async ({ page }) => {
    await page.getByTestId('ruta-r27').getByRole('button', { name: 'Contar cajón' }).click();
    await page.fill('#chq-banco', 'Banco del Bajío');
    await page.fill('#chq-numero', '004512');
    await page.fill('#chq-monto', '48');
    await page.click('#btn-recibir');
    await expect(page.getByTestId('ruta-r27')).toHaveCount(0);
    await expect(libro(page).first()).toContainText('cheque Banco del Bajío 004512');
    await expect(libro(page).first()).not.toContainText('pendiente');
  });

  test('[negativa] un cheque sin número no se anota, y la ruta no se da por recibida', async ({ page }) => {
    await page.getByTestId('ruta-r27').getByRole('button', { name: 'Contar cajón' }).click();
    await page.fill('#chq-banco', 'Banco del Bajío');
    await page.fill('#chq-monto', '48');
    await page.click('#btn-recibir');
    await expect(page.locator('#chq-error')).toBeVisible();
    await expect(page.getByTestId('ruta-r27')).toHaveCount(1);
  });
});

test.describe('7 · Lo que toca hoy, contado antes de las listas (Q.1)', () => {
  test('el resumen cuenta cada lista y lleva a ella aunque quede fuera de la vista', async ({ page }) => {
    await expect(page.getByTestId('ir-pagar')).toContainText('26');
    await expect(page.getByTestId('ir-rutas')).toContainText('2');
    await expect(page.getByTestId('cola-rutas'), 'con 26 pagos, las rutas quedan abajo').not.toBeInViewport();
    await page.getByTestId('ir-rutas').click();
    await expect(page.getByTestId('cola-rutas')).toBeInViewport();
  });

  test('[negativa] un retiro sin código sube al resumen en rojo en cuanto pasa', async ({ page }) => {
    await expect(page.getByTestId('ir-explicar')).not.toHaveClass(/alerta/);
    await page.click('#sim-retiro-sin-codigo');
    await expect(page.getByTestId('ir-explicar')).toHaveClass(/alerta/);
    await expect(page.getByTestId('ir-explicar')).toContainText('1');
  });
});

test.describe('8 · Fondo de monedas: se junta por pieza y se cambia por billetes con rastro', () => {
  const abrir = async (p: Page, con = 'Banco', nombre = 'Banco del Bajío') => {
    await p.click('#btn-cambiar-monedas');
    await p.selectOption('#mon-con', con);
    await p.fill('#mon-nombre', nombre);
  };

  test('el fondo se cuenta por pieza y avisa cuando conviene cambiarlo (desde $5,000)', async ({ page }) => {
    await expect(page.locator('#n-monedas')).toHaveText('$3,250.00');
    await expect(page.locator('#monedas-aviso')).toContainText('cuando pasen de $5,000.00');
    await page.evaluate(() => { const s = (window as any).__caos.estado(); s.cajon[10] += 200; (window as any).__caos.render(); });   // +$2,000 que dejó una ruta
    await expect(page.locator('#monedas-aviso')).toContainText('Conviene cambiarlas');
    await expect(page.getByTestId('ir-monedas')).toHaveClass(/alerta/);
  });

  test('en el acto: salen monedas y entran billetes por el mismo importe; el cajón no cambia de total', async ({ page }) => {
    await abrir(page);
    await pieza(page, 'mon-sale', 10, 100);              // $1,000 en monedas de $10
    await pieza(page, 'mon-entra', 500, 2);              // $1,000 en billetes
    await page.click('#btn-mon');
    await expect(page.locator('#n-monedas')).toHaveText('$2,250.00');
    await expect(kpi(page, 'cajon')).toHaveText('$31,750.00');
    await expect(libro(page).first()).toContainText('Monedas por billetes con Banco · Banco del Bajío');
  });

  test('[negativa] si los billetes no suman lo que salió, no se registra; la comisión se declara aparte', async ({ page }) => {
    await abrir(page);
    await pieza(page, 'mon-sale', 10, 100);
    await pieza(page, 'mon-entra', 500, 1); await pieza(page, 'mon-entra', 200, 2); await pieza(page, 'mon-entra', 50, 1); await pieza(page, 'mon-entra', 20, 1);   // $970
    await expect(page.locator('#btn-mon')).toBeDisabled();
    await expect(page.locator('#mon-cuadre')).toContainText('Faltan por explicar $30.00');
    await page.fill('#mon-comision', '30');
    await expect(page.locator('#btn-mon')).toBeEnabled();
    await page.click('#btn-mon');
    await expect(libro(page).first()).toContainText('Comisión por el cambio de monedas');
    await expect(kpi(page, 'cajon')).toHaveText('$31,720.00');
  });

  test('[negativa] no se pueden cambiar más monedas de las que hay en el cajón', async ({ page }) => {
    await abrir(page);
    await pieza(page, 'mon-sale', 2, 101);               // sólo hay 100 de $2
    await pieza(page, 'mon-entra', 200, 1);
    await expect(page.locator('#mon-cuadre')).toContainText('No hay tantas monedas');
    await expect(page.locator('#btn-mon')).toBeDisabled();
  });

  test('[negativa] cambiar de modo no borra lo ya capturado', async ({ page }) => {
    await abrir(page);
    await pieza(page, 'mon-sale', 5, 7);
    await page.click('[data-modo="lleva"]');
    await expect(page.locator('#mon-con')).toHaveValue('Banco');
    await expect(page.locator('#mon-nombre')).toHaveValue('Banco del Bajío');
    await expect(page.locator('[data-grupo="mon-sale"][data-denom="5"]')).toHaveValue('7');
  });

  test('si se las lleva una persona, quedan en custodia a su nombre hasta que regresa con los billetes', async ({ page }) => {
    await abrir(page);
    await page.click('[data-modo="lleva"]');
    await pieza(page, 'mon-sale', 5, 200);               // $1,000 en monedas de $5
    await page.fill('#mon-persona', 'Chofer Ruta 5');
    await page.click('#btn-mon');
    const custodia = page.getByTestId('cola-custodias').locator('tr', { hasText: 'Monedas para cambio' });
    await expect(custodia).toContainText('Chofer Ruta 5');
    await expect(custodia).toContainText('$1,000.00');
    await custodia.getByRole('button', { name: 'Rendir' }).click();
    await page.fill('#ren-comprobado', '0');
    await pieza(page, 'ren', 500, 2);                    // regresa $1,000 en billetes
    await page.click('#btn-rendir');
    await expect(page.getByTestId('cola-custodias').locator('tr', { hasText: 'Monedas para cambio' })).toHaveCount(0);
    await expect(kpi(page, 'cajon')).toHaveText('$31,750.00');
  });
});
