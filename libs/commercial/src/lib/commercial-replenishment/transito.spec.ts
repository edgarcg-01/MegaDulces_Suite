// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { AVISO_TRANSITO, POLITICA_TRANSITO, transitoDescontado, transitoMostrado } from './transito';

/**
 * `[RA.TR]` — **El candado de la política de tránsito.**
 *
 * Lo que protege son dos cosas distintas, y por eso hay dos clases de prueba acá:
 *
 * 1. **La función** — tests de verdad, ejercitando las tres políticas. Lo que devuelve se arma en
 *    SQL, así que se comprueba la CADENA que sale, no una intención.
 * 2. **El reparto** — un escaneo de los fuentes de esta carpeta que se pone rojo si alguien vuelve
 *    a escribir la resta a mano. ⚠️ Un escaneo por regex **no es un test**: no prueba que el SQL
 *    corra ni que la cifra sea correcta. Prueba una sola cosa, y es justo la que importa acá: que
 *    siga habiendo **una** definición y no seis. Por eso lleva su propia prueba negativa, con un
 *    fuente sintético que DEBE salir rojo.
 *
 * ⛔ Lo que este archivo NO afirma: que el sugerido resultante sea el correcto para el negocio.
 * Eso lo decidió Edgar con las 394 OC abiertas a la vista, y la decisión vive en `transito.ts`.
 */

const DIR = __dirname;
const FUENTES = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f !== 'transito.ts');

/**
 * La firma de una resta de tránsito escrita a mano: el nombre de la columna pesada apareciendo
 * dentro de un `COALESCE`, que es como estaban escritos los seis sitios antes de esta fase.
 *
 * ⚠️ NO marca `sum(transit_eff_cajas) AS transit_eff`: eso es ARRASTRAR la columna hasta el lugar
 * donde la política decide, que es lo correcto. La diferencia entre arrastrar y restar es el
 * `COALESCE` con caída al crudo — la forma exacta que tenían las seis expresiones viejas.
 */
const RESTA_A_MANO = /COALESCE\(\s*(?:sum\()?[\w.]*transit_eff[\w.]*\)?\s*,/;

function escanear(texto: string): boolean {
  return RESTA_A_MANO.test(texto);
}

describe('[RA.TR] el arnés del candado', () => {
  it('encuentra los fuentes que dice escanear', () => {
    expect(FUENTES).toContain('commercial-replenishment.service.ts');
    expect(FUENTES).toContain('replenishment-scanner.service.ts');
    expect(FUENTES.length).toBeGreaterThanOrEqual(2);
  });

  it('⭐ PRUEBA NEGATIVA: el detector SÍ se pone rojo con la forma vieja', () => {
    // Las tres expresiones tal como estaban escritas antes del 2026-10-09, verbatim.
    expect(escanear(`const it = 'COALESCE(rpl.transit_eff_cajas, rpl.transit_cajas, 0) * COALESCE(rpl.bf, 1)';`)).toBe(true);
    expect(escanear(`const transitEff = 'COALESCE(plan.transit_eff, plan.transit, 0)';`)).toBe(true);
    expect(escanear(`- COALESCE(sum(b.transit_eff_cajas),0)) * fill`)).toBe(true);
  });

  it('⭐ y NO se pone rojo con el arrastre legítimo de la columna', () => {
    // Un detector que marcara esto obligaría a dejar de pasar el dato al lugar donde se decide,
    // que es peor que el problema: volvería a repartir la decisión.
    expect(escanear(`sum(transit_eff_cajas) AS transit_eff,`)).toBe(false);
    expect(escanear(`rp.transit_eff_cajas AS transit_eff_cajas, rp.revenue30`)).toBe(false);
    expect(escanear(`transitoDescontado('rpl.transit_eff_cajas', 'rpl.transit_cajas')`)).toBe(false);
  });
});

describe('[RA.TR] una sola definición — ningún fuente resta por su cuenta', () => {
  for (const f of FUENTES) {
    it(`${f} no escribe la resta a mano`, () => {
      const linea = readFileSync(join(DIR, f), 'utf8')
        .split('\n')
        .findIndex((l) => escanear(l));
      // El mensaje nombra la línea: un candado que sólo dice "falló" obliga a buscarla de nuevo.
      expect(linea === -1 || `${f}:${linea + 1}`).toBe(true);
    });
  }

  it('⛔ y los dos servicios que restan lo hacen LLAMANDO al helper', () => {
    const svc = readFileSync(join(DIR, 'commercial-replenishment.service.ts'), 'utf8');
    const scan = readFileSync(join(DIR, 'replenishment-scanner.service.ts'), 'utf8');
    expect(svc).toContain(`from './transito'`);
    expect(scan).toContain(`from './transito'`);
    // Seis sitios restaban. Cinco viven en el servicio (matriz, desglose, drill, los dos
    // resúmenes y el diálogo comparten helper o llamada directa) y uno en el escáner.
    const llamadas = (svc.match(/transitoDescontado\(/g) || []).length;
    expect(llamadas).toBeGreaterThanOrEqual(5);
  });
});

describe('[RA.TR] la función: qué SQL sale de cada política', () => {
  it('ignorar → el literal 0, que es válido donde entraba la expresión vieja', () => {
    expect(transitoDescontado('a.eff', 'a.crudo', 'ignorar')).toBe('0');
    // ⚠️ Lo importante no es que diga "0" sino que NO pueda ser NULL: quien la llama la resta
    // directo, y un NULL en una resta anula el renglón entero en vez de dejarlo igual.
    expect(transitoDescontado('a.eff', 'a.crudo', 'ignorar')).not.toMatch(/null/i);
  });

  it('curva → pesa por P(llega|edad), con caída al crudo', () => {
    expect(transitoDescontado('a.eff', 'a.crudo', 'curva')).toBe('COALESCE(a.eff, a.crudo, 0)');
  });

  it('crudo → el papel entero, ignorando la curva', () => {
    expect(transitoDescontado('a.eff', 'a.crudo', 'crudo')).toBe('COALESCE(a.crudo, 0)');
    expect(transitoDescontado('a.eff', 'a.crudo', 'crudo')).not.toContain('a.eff');
  });

  it('⭐ las tres terminan en un COALESCE o en un literal — ninguna puede devolver NULL', () => {
    for (const p of ['ignorar', 'curva', 'crudo'] as const) {
      const sql = transitoDescontado('a.eff', 'a.crudo', p);
      expect(sql === '0' || sql.startsWith('COALESCE(')).toBe(true);
    }
  });

  it('⭐ y funciona con una AGREGADA, que es como la usa el desglose por sucursal', () => {
    expect(transitoDescontado('sum(b.eff)', 'sum(b.crudo)', 'curva')).toBe('COALESCE(sum(b.eff), sum(b.crudo), 0)');
  });
});

describe('[RA.TR] ordenar por una columna ordena por LO QUE SE VE', () => {
  const svc = readFileSync(join(DIR, 'commercial-replenishment.service.ts'), 'utf8');

  it('⛔⛔ la columna "En camino" se ORDENA por la expresión que se MUESTRA, no por la que se resta', () => {
    // Si `in_transit` se ordenara por `it`, con la política vigente ordenaría por una constante 0:
    // la tabla se vería ordenada y no lo estaría, sin un solo error de por medio.
    // Lo encontró `trade-marketing-06` en typecheck:fast cuando la variable ni siquiera existía
    // en ese método; el arreglo "obvio" (usar `it`) compilaba y rompía el orden en silencio.
    const m = /in_transit:\s*`\(\$\{(\w+)\}\)/.exec(svc);
    expect(m?.[1]).toBe('itShow');
  });

  it('⭐ y el sugerido se ordena por la que SÍ se resta — son dos columnas distintas', () => {
    const m = /suggested_qty:\s*`GREATEST\(0, \$\{target\} - \$\{oh\} - \$\{(\w+)\}\)/.exec(svc);
    expect(m?.[1]).toBe('it');
  });

  it('⛔ y `sortableExpr` RECIBE las dos: una sola las confundiría de nuevo', () => {
    expect(svc).toMatch(/private sortableExpr\([^)]*\bit: string\b[^)]*\bitShow: string\b/);
  });
});

describe('[RA.TR] lo que se MUESTRA no depende de la política', () => {
  it('siempre el crudo: es el papel que el comprador busca por folio', () => {
    expect(transitoMostrado('rpl.transit_cajas')).toBe('COALESCE(rpl.transit_cajas, 0)');
  });

  it('⛔ NEGATIVA: nunca la columna pesada — con ella la columna jamás cuadró con el diálogo', () => {
    expect(transitoMostrado('rpl.transit_cajas')).not.toContain('transit_eff');
  });
});

describe('[RA.TR] la decisión vigente y su aviso', () => {
  it('la política es la que Edgar decidió el 2026-10-08: ignorar', () => {
    expect(POLITICA_TRANSITO).toBe('ignorar');
  });

  it('⛔ y viaja con un aviso para el comprador — un cambio así no puede ser silencioso', () => {
    // ADR-056: lo que el motor decidió NO usar se declara donde está el número. Sin esto, una OC
    // en camino que el sugerido ignora se lee como un descuido del motor.
    expect(AVISO_TRANSITO[POLITICA_TRANSITO]).toBeTruthy();
    expect(AVISO_TRANSITO[POLITICA_TRANSITO]).toMatch(/NO descuenta/);
  });

  it('las tres políticas tienen aviso — ninguna se puede activar muda', () => {
    for (const p of ['ignorar', 'curva', 'crudo'] as const) {
      expect(AVISO_TRANSITO[p]?.length).toBeGreaterThan(20);
    }
  });
});
