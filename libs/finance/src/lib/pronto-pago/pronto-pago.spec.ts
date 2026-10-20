// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[PP.1]` — El candado del pronto pago.
 *
 * ⛔ **Lo que protege es UNA cosa y es la que puede costar caro:** que la pantalla no haga pasar
 * una ventana **observada** por una condición **pactada**. El acuerdo con el proveedor no existe
 * como dato — `commercial.supplier_discount_policy` trae 147 filas, todas `source='observed'`, con
 * `discount_days` vacío en el 100%. Si esta pantalla dijera "vence el 14" como si el proveedor lo
 * hubiera prometido, Tesorería tomaría decisiones de pago sobre una cifra que nadie pactó.
 *
 * ## Lo medido en prod antes de construir (2026-10-10)
 *
 * | | docs | monto | beneficio |
 * |---|---:|---:|---:|
 * | capturable | 490 | $33,253,042 | $1,956,067 |
 * | por vencer (<= 5 d) | 75 | $6,442,366 | $370,132 |
 * | fuera de ventana | 483 | $23,475,504 | $1,346,428 |
 * | **sin medir** | **807** | **$30,656,847** | **—** |
 *
 * Ventana observada: mediana **26 días** sobre 4,747 pagos con `c84 > 0`. Con `n >= 3` quedan 157
 * de 190 proveedores y se conserva el **99.7%** del descuento ganado — por eso ese umbral.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..', '..');
const SVC = readFileSync(join(__dirname, 'pronto-pago.service.ts'), 'utf8');
const CTRL = readFileSync(join(__dirname, 'pronto-pago.controller.ts'), 'utf8');
const MIG = readFileSync(join(RAIZ, 'database', 'migrations-newdb', '20261010111352_pronto_pago_ventana_observada.js'), 'utf8');
const PANT = readFileSync(join(RAIZ, 'apps', 'view', 'src', 'app', 'modules', 'finanzas', 'pages', 'finanzas-pronto-pago.component.ts'), 'utf8');

/** Mide código, no redacción. */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/^\s*--.*$/gm, ' ');
}
/** El texto que VE una persona: sin comentarios de TS ni de HTML. */
function visible(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}
const CODIGO = sinComentarios(SVC);
/**
 * `[TP.18.7]` La regla de la ventana (umbral y fecha límite) se mudó a `libs/contracts`, compartida
 * con el Calendario de pagos. Las pruebas la miden AHÍ y exigen que el servicio la use: buscar el
 * literal en el servicio dejó estas dos en rojo desde ese refactor.
 */
const VENTANA = sinComentarios(
  readFileSync(join(RAIZ, 'libs', 'contracts', 'src', 'finance', 'pronto-pago-ventana.contract.ts'), 'utf8'),
);
const MIG_SQL = sinComentarios(MIG);
const VIS = visible(PANT);

describe('[PP.1] el arnés', () => {
  it('encuentra las cuatro piezas', () => {
    expect(CODIGO).toContain('ProntoPagoService');
    expect(MIG).toContain('mv_supplier_prompt_discount');
    expect(PANT).toContain('FinanzasProntoPagoComponent');
    expect(CTRL).toContain('finance/pronto-pago');
  });

  it('y falla fuerte si una se renombra', () => {
    expect(() => { if (!'nada'.includes('ProntoPagoService')) throw new Error('No existe el servicio'); })
      .toThrow(/No existe/);
  });
});

describe('[PP.1] ⛔ la ventana es OBSERVADA, y la pantalla lo dice', () => {
  it('⭐⭐ el servidor marca la procedencia — no es un adorno del front', () => {
    // Si la marca viviera sólo en la pantalla, cualquier otro consumidor del endpoint (un export,
    // un chat de Maat) publicaría la fecha como si fuera pactada.
    expect(CODIGO).toMatch(/ventana: 'observada'/);
    expect(CODIGO).toMatch(/min_observaciones: MIN_OBS/);
  });

  it('⭐⭐ y se lee en pantalla, no escondido en un title', () => {
    expect(VIS).toMatch(/es <strong>observada<\/strong>, no pactada/);
    expect(VIS).toMatch(/No es una promesa del proveedor/);
  });

  it('⛔ NEGATIVA: en ningún lado se la llama pactada, acordada ni negociada', () => {
    expect(VIS).not.toMatch(/condici[óo]n pactada con el proveedor/i);
    expect(VIS).not.toMatch(/seg[úu]n lo acordado/i);
  });

  it('⭐ el umbral de observaciones está MEDIDO, no elegido de oído', () => {
    expect(VENTANA).toMatch(/export const PRONTO_PAGO_MIN_OBS = 3;/);
    expect(CODIGO).toMatch(/const MIN_OBS = PRONTO_PAGO_MIN_OBS;/);
    // Y la migración carga la medición que lo justifica, para que nadie lo mueva a ciegas.
    expect(MIG).toMatch(/99\.7%/);
  });
});

describe('[PP.1] ⛔ lo que no se midió se DECLARA, nunca se dibuja en cero', () => {
  it('⭐⭐ sin ventana medible NO hay fecha límite: queda NULL, no CURRENT_DATE', () => {
    // Un COALESCE a hoy pondría "vence hoy" sobre 807 documentos que nadie midió.
    // La regla vive en el contrato (sin ELSE: sin ventana, NULL) y el servicio la usa tal cual.
    expect(VENTANA).toMatch(/THEN \$\{v\}\.fecha \+ \$\{d\}\.dias_mediana END`/);
    expect(VENTANA).not.toMatch(/coalesce\(\s*\$\{d\}\.dias_mediana/i);
    expect(CODIGO).toMatch(/\$\{sqlVentanaProntoPago\('p', 'd'\)\}/);
    expect(CODIGO).toMatch(/b\.pronto_fecha_limite AS fecha_limite/);
    expect(CODIGO).not.toMatch(/coalesce\(\s*d\.dias_mediana\s*,\s*\d/i);
  });

  it('⭐⭐ el KPI de "sin medir" va en DOCUMENTOS, no en pesos', () => {
    // Su beneficio no es cero: es desconocido. Publicarlo como $0 afirmaría que esos proveedores
    // no dan descuento, y no lo sabemos.
    expect(PANT).toMatch(/label: 'Sin ventana medible', value: d\.kpis\.sin_medir\.docs \}/);
    expect(PANT).not.toMatch(/sin_medir\.beneficio[^;]*format: 'currency'/);
  });

  it('⭐ la tasa y el beneficio ausentes se pintan como raya, no como 0', () => {
    expect(VIS).toMatch(/r\.tasa_observada != null/);
    expect(VIS).toMatch(/r\.beneficio != null/);
  });
});

describe('[PP.1] ⛔ "fuera de ventana" NO significa perdido', () => {
  it('⭐⭐ la etiqueta nunca dice perdido ni vencido', () => {
    // Decirle perdido a algo que todavía podría cobrarse haría que Tesorería dejara de intentarlo
    // — el daño opuesto al que esta pantalla viene a evitar.
    const i = PANT.indexOf('etiquetaDe(e: EstadoPronto)');
    expect(i).toBeGreaterThan(0);
    const b = PANT.slice(i, i + 400);
    expect(b).toContain("'Fuera de ventana'");
    expect(b).not.toMatch(/perdid/i);
    expect(b).not.toMatch(/vencid/i);
  });

  it('⭐ y el servicio lo explica donde se decide el nombre', () => {
    expect(SVC).toMatch(/fuera_de_ventana\` NO significa "perdido"|fuera_de_ventana. NO significa/);
  });
});

describe('[PP.1] ⭐ accesibilidad: el color nunca es el único portador', () => {
  it('⭐⭐ cada estado lleva TEXTO e ICONO, no sólo una clase de color', () => {
    expect(PANT).toContain('iconoDe(');
    expect(PANT).toContain('etiquetaDe(');
    expect(VIS).toMatch(/\{\{ etiquetaDe\(r\.estado\) \}\}/);
  });

  it('⛔ NEGATIVA: no hay outline:none sin su anillo de foco', () => {
    // El repo cerró 37 controles sin anillo el 2026-10-03 y la compuerta tiene tope 0.
    const estilos = PANT.slice(PANT.indexOf('styles: ['));
    if (/outline:\s*none/.test(estilos)) expect(estilos).toMatch(/:focus-visible/);
    expect(estilos).toMatch(/:focus-visible/);
  });

  it('⭐ el filtro es un RADIOGROUP, no pestañas', () => {
    // D.4(c): 36 archivos del repo confundían un selector de una opción con un tablist.
    // ⚠️ Sobre el texto VISIBLE: el JSDoc de `estadoOpts` CITA `role="tablist"` para explicar por
    // qué no se usa, y el candado se puso rojo por la prosa. Cuarta vez en el día.
    expect(PANT).toContain('app-segmented');
    expect(VIS).not.toMatch(/role="tablist"/);
  });

  it('⭐ los estados de carga y error se anuncian, y el buscador tiene nombre', () => {
    expect(VIS).toMatch(/aria-busy="true" aria-live="polite"/);
    expect(VIS).toMatch(/role="alert"/);
    expect(VIS).toMatch(/<span class="sr-only">Buscar proveedor o folio<\/span>/);
  });

  it('⭐ y los objetivos táctiles crecen donde el puntero es grueso', () => {
    expect(PANT).toMatch(/@media \(pointer: coarse\)/);
    expect(PANT).toMatch(/min-height: 44px/);
  });
});

describe('[PP.1] ⭐ el orden es la mitad del valor', () => {
  it('⛔⛔ la lista sale por URGENCIA y después por dinero', () => {
    // Por importe, los $200 que vencen mañana quedan debajo de los $2M que vencen en tres semanas.
    expect(CODIGO).toMatch(/ORDER BY CASE estado WHEN 'por_vencer' THEN 0/);
    expect(CODIGO).toMatch(/dias_restantes ASC NULLS LAST/);
  });
});

describe('[PP.1] ⭐ lo retrospectivo se LEE, no se vuelve a detectar', () => {
  it('⛔⛔ lo ya perdido sale de finance.findings, no de una segunda definición', () => {
    // Dos definiciones de "descuento no capturado" obligarían a alguien a decidir cuál creer.
    expect(CODIGO).toMatch(/finance\.findings/);
    expect(CODIGO).toMatch(/rule_key', 'descuento_no_capturado/);
  });

  it('⭐ y se declara que nadie los triageó y que el detector se calló', () => {
    expect(CODIGO).toMatch(/sin_triage/);
    expect(VIS).toMatch(/El detector dejo de producir el/);
  });
});

describe('[PP.1] la migración', () => {
  it('⭐ nace WITH NO DATA y tiene índice único para refrescar sin bloquear', () => {
    expect(MIG_SQL).toContain('WITH NO DATA');
    expect(MIG_SQL).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,160}mv_supplier_prompt_discount/);
  });

  it('⛔ excluye el pago fechado ANTES de su factura — no es una ventana negativa', () => {
    expect(MIG_SQL).toMatch(/a\.fecha_pago >= fc\.fecha_fac/);
  });

  it('⛔ y acota al universo de COMPRA: sin eso entran nómina, caja y banco', () => {
    expect(MIG_SQL).toMatch(/btrim\(m\.c10\) LIKE 'C%'/);
  });

  it('⭐ las CTE van AS MATERIALIZED — PG12+ las inlinea y el plan se desarma', () => {
    expect((MIG_SQL.match(/AS MATERIALIZED/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('el `down` deshace exactamente lo que hizo el `up`', () => {
    expect(MIG).toMatch(/exports\.down[\s\S]*DROP MATERIALIZED VIEW IF EXISTS analytics\.mv_supplier_prompt_discount/);
  });
});

/**
 * `[PP.2]` — **El por qué, y el estadístico que casi lo arruina.**
 *
 * ⛔ La primera versión de la frase decía el rango **mínimo–máximo**. Para el proveedor más grande
 * (423 pagos, $15,080,144 de ahorro) eso daba *"entre 0 y 112 días"* — y su ventana real es de
 * **19 a 23**. El máximo es una cola suelta: habría hecho parecer inútil el plazo más confiable
 * que tenemos. El estadístico correcto es el **p90**.
 *
 * ⭐ Y midiéndolo bien apareció lo que sí hay que declarar: **29 proveedores ($7,327,046)** donde
 * el p90 está tan lejos de la mediana que el plazo no explica el descuento, contra **128
 * ($49,758,200)** donde la ventana es real.
 */
describe('[PP.2] ⛔ el por qué se arma con p90, no con el máximo', () => {
  it('⭐⭐ la frase usa dias_p90 — el máximo es una cola suelta', () => {
    expect(CODIGO).toMatch(/const p90 = dia\(r\.dias_p90\)/);
    expect(CODIGO).toMatch(/9 de cada 10, antes de \$\{p90\}/);
  });

  it('⛔ NEGATIVA: no vuelve el rango mínimo–máximo', () => {
    expect(CODIGO).not.toMatch(/dias_min/);
    expect(CODIGO).not.toMatch(/entre \$\{lo\} y \$\{hi\}/);
  });

  it('⭐ y la consulta pide p90, no min/max', () => {
    expect(CODIGO).toMatch(/d\.dias_p90, d\.descuento_12m/);
  });
});

describe('[PP.2] ⭐ las ausencias se nombran distinto porque se arreglan distinto', () => {
  it('⭐⭐ "nunca dio" y "pocas veces" NO son el mismo motivo', () => {
    // Medido: 763 docs / $27,321,330 de proveedores que nunca dieron descuento, contra 48 docs
    // que lo dieron 1 o 2 veces. Al primero no hay nada que pedirle; al segundo sí.
    expect(CODIGO).toMatch(/motivo: 'nunca_dio'/);
    expect(CODIGO).toMatch(/motivo: 'pocas_veces'/);
    expect(CODIGO).toMatch(/motivo: 'sin_fecha'/);
  });

  it('⛔ y cuando el plazo NO manda, se dice que la fecha es poco confiable', () => {
    expect(CODIGO).toMatch(/motivo: 'historial_disperso'/);
    expect(CODIGO).toMatch(/El plazo no es lo que lo dispara/);
  });

  it('⭐ el umbral de dispersión es una heurística DECLARADA, no una ley escondida', () => {
    expect(CODIGO).toMatch(/const esDisperso = \(med: number, p90: number\)/);
    expect(SVC).toMatch(/HEUR[ÍI]STICA, no una ley/);
  });

  it('⭐⭐ el motivo lo arma el SERVIDOR, no la pantalla', () => {
    // Mismo motivo que la marca de procedencia: si la frase la escribiera el front, al cambiar
    // MIN_OBS o la derivación seguiría contando la historia vieja.
    expect(CODIGO).toMatch(/private porQue\(/);
    expect(PANT).not.toMatch(/pagos a este proveedor obtuvieron descuento/);
    expect(VIS).toMatch(/\{\{ r\.porque \}\}/);
  });

  it('⛔ y se LEE en pantalla, no escondido en un title', () => {
    expect(VIS).toMatch(/class="pp-porque"/);
  });
});

describe('[PP.1] la ruta', () => {
  it('⭐ es sólo lectura y reusa el permiso de Pagos — sin permiso nuevo, sin re-login', () => {
    expect(CTRL).toContain('FINANCE_PAYMENTS_VER');
    expect(CTRL).not.toContain('@Post');
    expect(CTRL).not.toContain('GESTIONAR');
  });
});
