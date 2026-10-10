// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RA.PM]` — El candado de la autopsia de la compra.
 *
 * ⚠️ **Qué NO afirma.** Un doble de Knex no ejecuta SQL y una matvista no se puede montar acá, así
 * que esto no comprueba cifras. Las cifras se midieron contra prod y viven, con fecha, en la
 * migración `20261009133029` y en `FASE_RA`. Lo que este archivo protege son las decisiones que,
 * si alguien las deshace, **no fallan: mienten**.
 */

const DIR = __dirname;
const SVC = readFileSync(join(DIR, 'commercial-replenishment.service.ts'), 'utf8');
const CTRL = readFileSync(join(DIR, 'commercial-replenishment.controller.ts'), 'utf8');
const MIG = readFileSync(
  join(DIR, '..', '..', '..', '..', '..', 'database', 'migrations-newdb', '20261009133029_postmortem_compras.js'),
  'utf8',
);

/** Quita comentarios: medir código, no redacción. Tercera vez que ese defecto rompe un candado acá. */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/^\s*--.*$/gm, ' ');
}

/** El SQL de la matvista, ya sin los comentarios de JS (los `--` de adentro SÍ se quitan aparte). */
const SQL = sinComentarios(MIG);

describe('[RA.PM] el arnés', () => {
  it('encuentra la migración y su matvista', () => {
    expect(MIG).toContain('CREATE MATERIALIZED VIEW');
    expect(MIG).toContain('mv_purchase_postmortem');
    expect(MIG.length).toBeGreaterThan(2000);
  });

  it('y el servicio la consume', () => {
    expect(SVC).toContain('analytics.mv_purchase_postmortem');
  });
});

describe('[RA.PM] el destino de la mercancía — el error que invirtió el resultado', () => {
  it('⭐⭐ usa `origen_warehouse_id`, NO `warehouse_id` a secas', () => {
    // Medido: difieren en 5,693 de 7,242 recibos (79%), $200 M de $344 M. Con `warehouse_id` salía
    // que el 78% de la compra entra por el CEDIS y que el 82% "nunca vendió" — las dos cosas
    // falsas, porque el `00` capturaba compras destinadas a OTRAS plazas (Fase DM.19 / PO).
    // ⚠️ Se verifica la ASIGNACIÓN, no que la cadena exista en algún lado: la misma expresión
    // aparece también en el `WHERE ... IS NOT NULL`, así que un `toContain` pelado seguía verde
    // con la columna del SELECT ya cambiada. Lo descubrió la prueba de mutación de abajo, que no
    // enrojeció a la primera — un candado que no se cae con la mutación no está midiendo nada.
    expect(SQL).toMatch(/COALESCE\(r\.origen_warehouse_id, r\.warehouse_id\)\s+AS warehouse_id/);
  });

  it('⛔ NEGATIVA: el SELECT NO asigna `r.warehouse_id` pelado como almacén', () => {
    expect(SQL).not.toMatch(/\n\s*r\.warehouse_id AS warehouse_id/);
  });

  it('⛔ y lo que el documento no atribuye se DECLARA, no se reparte', () => {
    expect(SQL).toContain('centro_no_dice_plaza');
    expect(SQL).toContain('comprado_sin_resolver');
  });

  it('⭐ `sin_resolver` gana al resto de los veredictos: no se puede juzgar lo que no se ubicó', () => {
    const iSin = SQL.indexOf(`THEN 'sin_resolver'`);
    const iNunca = SQL.indexOf(`THEN 'nunca_salio'`);
    expect(iSin).toBeGreaterThan(0);
    expect(iNunca).toBeGreaterThan(0);
    expect(iSin).toBeLessThan(iNunca);
  });
});

describe('[RA.PM] qué entra y qué no', () => {
  it('⛔ los SERVICIOS quedan fuera: $108 M que no son mercancía', () => {
    // 2,108 renglones con `unidad = SER`. No tienen desempeño de producto que medir; dejarlos
    // adentro metía una quinta parte del dinero en una autopsia que no les aplica.
    expect(SQL).toContain(`l.unidad <> 'SER'`);
  });

  it('⭐ se mide en PESOS, no en cantidades', () => {
    // Las cantidades vienen en PAQ (63,998) · PZA (26,769) · KG (5,232) y hasta gramajes crudos.
    // Sumarlas da un número que no está en ninguna unidad (ADR-055/057).
    expect(SQL).toContain('sum(l.importe)');
    expect(SQL).not.toMatch(/sum\(l\.cantidad\)/);
  });

  it('⛔ el CEDIS se mide contra su SALIDA, no contra la venta', () => {
    // No vende: traspasa. Medirlo con la venta lo condena entero por construcción — el mismo
    // error que `[RA.SOB]` encontró en el tramo "sin venta".
    expect(SQL).toContain(`'Traspaso a sucursal'`);
    expect(SQL).toContain('sells_to_public');
  });
});

describe('[RA.PM] por qué matvista, y por qué MATERIALIZED', () => {
  it('⭐⭐ los CTE pesados van MATERIALIZED', () => {
    // En PG12+ un CTE referenciado una sola vez se INLINEA, y eso mete las dos vistas derivadas
    // del ODS adentro del join: nested loop re-derivando los renglones por cada recibo. Medido:
    // con la palabra ~5 min; sin ella se pasó de 15 y hubo que cancelar.
    expect(SQL).toMatch(/WITH rec AS MATERIALIZED/);
    expect(SQL).toMatch(/lin AS MATERIALIZED/);
  });

  it('⛔ tiene índice ÚNICO, o el refresco bloquea la pantalla', () => {
    // Sin UNIQUE no se puede REFRESH CONCURRENTLY: el refresco toma ACCESS EXCLUSIVE y quien esté
    // mirando la pestaña se queda colgado mientras corre el nocturno.
    expect(MIG).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,120}tenant_id, warehouse_id, product_id/);
  });

  it('el `down` deshace exactamente lo que hizo el `up`', () => {
    expect(MIG).toMatch(/exports\.down[\s\S]*DROP MATERIALIZED VIEW IF EXISTS/);
  });
});

describe('[RA.PM] el refresco late, y con umbral', () => {
  const REF = readFileSync(join(DIR, '..', 'commercial-analytics', 'analytics-refresh.service.ts'), 'utf8');
  const HEALTH = readFileSync(
    join(DIR, '..', '..', '..', '..', '..', 'apps', 'api', 'src', 'modules', 'db-health', 'db-health.service.ts'),
    'utf8',
  );

  it('está registrada en el lote nocturno', () => {
    expect(REF).toContain('analytics.mv_purchase_postmortem');
    expect(REF).toContain('analytics_refresh_purchase_postmortem');
  });

  it('⛔⛔ y tiene UMBRAL en CRON_JOBS — sin él una MV parada se ve VERDE', () => {
    // `cfg ? classify : 'ok'`: el sensor da verde incondicional a lo que no tiene fila. Lo midió
    // la Fase VP sobre 3 matvistas del sell-out. Acá parada no vacía la pantalla: la deja
    // publicando la foto de ayer, que se lee con la misma confianza que la de hoy.
    expect(HEALTH).toContain('analytics_refresh_purchase_postmortem');
  });
});

describe('[RA.PM] la ruta y el filtro por defecto', () => {
  it('existe y pide el permiso del Pedido', () => {
    const i = CTRL.indexOf(`@Get('postmortem')`);
    expect(i).toBeGreaterThan(0);
    expect(CTRL.slice(i, i + 300)).toContain('COMPRAS_PEDIDO_VER');
  });

  it('⚠️ el booleano del query se lee con el helper, no con Boolean()', () => {
    const i = CTRL.indexOf(`@Get('postmortem')`);
    expect(CTRL.slice(i, i + 1400)).toContain('parseSoloQuedado(solo_venden)');
  });

  it('⭐ por default deja fuera los almacenes que no venden', () => {
    // Si entraran, el CEDIS —por donde pasa la mayor parte de la compra— arrastraría el veredicto
    // de toda la red, porque su salida son traspasos y no ventas.
    expect(SVC).toContain(`q.solo_venden !== false`);
    expect(SVC).toContain('pm.no_vende IS NOT TRUE');
  });
});

describe('[RA.PM] lo que no se midió no se dibuja', () => {
  it('⛔ la frescura viaja, y `null` NO se cae a hoy', () => {
    expect(SVC).toContain('computed_on');
    expect(SVC).toMatch(/computed_on:\s*\(tot\['computed_on'\] as string\) \?\? null/);
  });

  it('⭐ la rotación es NULL cuando no se puede calcular, nunca 0', () => {
    expect(SQL).toMatch(/CASE WHEN c\.comprado > 0[\s\S]{0,120}END AS rotacion/);
  });

  it('con cero renglones el resumen se pide aparte — la tira no desaparece', () => {
    const i = SVC.indexOf('async postmortem(');
    expect(SVC.slice(i, i + 6000)).toContain('if (raw.length)');
  });
});
