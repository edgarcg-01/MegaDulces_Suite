import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cuentaDeConversion, type UnidadParaContar } from './conteo-cuenta-de-conversion';

/**
 * `[ICR.M5][ICR.M6]` — los dos arreglos de la **pantalla del contador** para el trimestral de
 * Yurécuaro del martes 1-dic-2026 (acta
 * `docs/IMPLEMENTACION/FASES/FASE_ICR_ANEXO_CONTEO_TRIMESTRAL_2026-11-27.md`, §5.1 E2 y E4).
 *
 * ## Qué afirma y qué NO
 *
 * - **La cuenta de la conversión (M6) se ejerce de verdad**: es una función pura, con sus cinco
 *   casos de `null`. Eso sí es una prueba de comportamiento.
 * - **Lo demás lee el fuente.** La pantalla arrastra `@zxing/browser`, Capacitor y un socket:
 *   no se monta. Entonces acá no se afirma «la cola se ve»; se afirma que **el arreglo sigue
 *   conectado** — que el aviso no volvió a quedar colgado de la jornada, que el pipe sigue
 *   declarado y que el candado de salida sigue mirando la cola. Una pieza perfecta que alguien
 *   mueve de lugar deja la pantalla como estaba y ninguna prueba de la pieza se entera.
 *
 * ⚠️ Los componentes están guardados con CRLF: el retorno de carro se quita antes de buscar,
 * o un ancla de varias líneas no macha ni una vez y la prueba negativa sale verde sin probar
 * nada.
 */

const RETORNO = String.fromCharCode(13);
const leer = (archivo: string): string =>
  readFileSync(join(__dirname, archivo), 'utf8').split(RETORNO).join('');

const CONTEO = leer('comercial-inventory-count.component.ts');
const GUARDA = readFileSync(
  join(__dirname, '..', '..', '..', 'core', 'guards', 'count-focus.guard.ts'),
  'utf8',
).split(RETORNO).join('');

/** El bloque `template:` solo — para distinguir «está en la pantalla» de «está en un comentario». */
const PLANTILLA = (() => {
  const desde = CONTEO.indexOf('template: ');
  const hasta = CONTEO.indexOf('  styles: [');
  return desde >= 0 && hasta > desde ? CONTEO.slice(desde, hasta) : '';
})();

/** El bloque que sólo se pinta mientras hay una jornada activa. */
const SOLO_CONTANDO = (() => {
  const desde = PLANTILLA.indexOf('@if (sessionActive()) {');
  return desde >= 0 ? PLANTILLA.slice(desde) : '';
})();

// ───────────────────────── [ICR.M6] la cuenta antes de aceptar ─────────────────────────

const CJA: UnidadParaContar = { unit: 'CJA', factor: 24, es_nativa: false };
const PAQ: UnidadParaContar = { unit: 'PAQ', factor: 1, es_nativa: true };

describe('[ICR.M6] contar en cajas muestra la cuenta antes de aceptar', () => {
  it('CONTROL — el caso del acta: 3 cajas × 24 = 72 paquetes', () => {
    const c = cuentaDeConversion(3, 'CJA', [PAQ, CJA]);
    expect(c).not.toBeNull();
    expect(c).toEqual({ cantidad: 3, unidad: 'CJA', factor: 24, nativa: 'PAQ', total: 72 });
  });

  it('CONTROL NEGATIVO — con la caja de 12 que de verdad hay en el anaquel, la cuenta cambia', () => {
    // Es el error que E2 previene: el mismo gesto, 36 piezas en vez de 72. Si la función
    // devolviera algo fijo, este control lo caza.
    const c = cuentaDeConversion(3, 'CJA', [PAQ, { ...CJA, factor: 12 }]);
    expect(c?.total).toBe(36);
    expect(c?.factor).toBe(12);
  });

  it('el cero es capturable y también se cuenta (un hueco contado no es un no-contado)', () => {
    expect(cuentaDeConversion(0, 'CJA', [PAQ, CJA])?.total).toBe(0);
  });

  it('un factor fraccionario no se redondea por su cuenta', () => {
    const c = cuentaDeConversion(2, 'MED', [PAQ, { unit: 'MED', factor: 0.5, es_nativa: false }]);
    expect(c?.total).toBe(1);
  });

  describe('⛔ los cinco casos en que NO se afirma nada', () => {
    it('sin cantidad tecleada', () => {
      expect(cuentaDeConversion(null, 'CJA', [PAQ, CJA])).toBeNull();
      expect(cuentaDeConversion(undefined, 'CJA', [PAQ, CJA])).toBeNull();
    });

    it('contando en la unidad NATIVA: lo tecleado es lo que se guarda', () => {
      expect(cuentaDeConversion(3, 'PAQ', [PAQ, CJA])).toBeNull();
    });

    it('la unidad elegida no está en la lista: no se adivina a qué equivale', () => {
      expect(cuentaDeConversion(3, 'BTO', [PAQ, CJA])).toBeNull();
      expect(cuentaDeConversion(3, null, [PAQ, CJA])).toBeNull();
    });

    it('factor 1, o no positivo: no hay cuenta que verificar', () => {
      expect(cuentaDeConversion(3, 'OTRO', [PAQ, { unit: 'OTRO', factor: 1, es_nativa: false }])).toBeNull();
      expect(cuentaDeConversion(3, 'OTRO', [PAQ, { unit: 'OTRO', factor: 0, es_nativa: false }])).toBeNull();
      expect(cuentaDeConversion(3, 'OTRO', [PAQ, { unit: 'OTRO', factor: -2, es_nativa: false }])).toBeNull();
    });

    it('⛔⛔ SIN unidad nativa no se inventa el factor (15 % de los artículos no tienen código primario)', () => {
      // Hay CJA con factor 24, pero nada dice 24 ¿de qué?. Rellenar acá sería el mismo defecto
      // que este arreglo previene.
      expect(cuentaDeConversion(3, 'CJA', [CJA])).toBeNull();
      expect(cuentaDeConversion(3, 'CJA', [])).toBeNull();
      expect(cuentaDeConversion(3, 'CJA', null)).toBeNull();
    });
  });

  describe('y sigue CONECTADA a la pantalla', () => {
    it('el componente la llama, en vez de tener su propia copia de la cuenta', () => {
      expect(CONTEO).toContain("from './conteo-cuenta-de-conversion'");
      expect(CONTEO).toContain('return cuentaDeConversion(cantidad, elegida, unidades);');
    });

    it('la cuenta se pinta ANTES del botón, no después', () => {
      const posCuenta = PLANTILLA.indexOf('ic-conversion-cuenta');
      const posBoton = PLANTILLA.indexOf('ic-submit');
      expect(posCuenta, 'no se pinta la cuenta').toBeGreaterThan(-1);
      expect(posBoton).toBeGreaterThan(-1);
      expect(posCuenta, 'la cuenta sale después del botón: ya no se verifica antes de aceptar')
        .toBeLessThan(posBoton);
    });

    it('el factor se muestra SUELTO: es lo único que se puede cotejar contra la caja en la mano', () => {
      expect(PLANTILLA).toContain('Verifica que 1 {{ c.unidad }} traiga {{ c.factor');
    });

    it('el botón dice la cifra que va a quedar escrita, en la unidad del teórico', () => {
      expect(PLANTILLA).toContain('Registrar {{ c.total');
    });

    it('⛔ el pipe `number` está DECLARADO: sin eso el AOT de producción truena con el build local en verde', () => {
      expect(CONTEO).toContain("import { DecimalPipe } from '@angular/common';");
      expect(CONTEO).toContain('DecimalPipe,');
    });

    it('PRUEBA NEGATIVA — sin la llamada, el candado se pone ROJO', () => {
      const mutante = CONTEO.split('return cuentaDeConversion(cantidad, elegida, unidades);').join('return null;');
      expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(CONTEO);
      expect(mutante).not.toContain('return cuentaDeConversion(cantidad, elegida, unidades);');
    });
  });
});

// ──────────────── [ICR.M5] lo capturado y no sincronizado se ve ────────────────

describe('[ICR.M5] la cola se ve, y no se va con la persona', () => {
  it('CONTROL — los anclajes existen: hay plantilla, y hay un bloque de jornada activa', () => {
    expect(PLANTILLA.length, 'no se encontró el template').toBeGreaterThan(2000);
    expect(SOLO_CONTANDO, 'no se encontró el bloque de sessionActive()').not.toBe('');
    expect(SOLO_CONTANDO).toContain('Conteo en curso');
  });

  it('⛔ el aviso de la cola NO cuelga de la jornada: se ve también al elegir folio y al terminar', () => {
    expect(PLANTILLA).toContain('offline.pending()');
    expect(
      SOLO_CONTANDO.includes('offline.pending()'),
      'el aviso volvió adentro de sessionActive(): al terminar desaparece y la persona se va sin verlo (E4)',
    ).toBe(false);
  });

  it('⛔ lo rechazado tampoco cuelga de la jornada', () => {
    expect(PLANTILLA).toContain('discarded().length');
    expect(SOLO_CONTANDO.includes('discarded()')).toBe(false);
  });

  it('sin conexión también dice CUÁNTOS faltan, no sólo que no hay red', () => {
    expect(PLANTILLA).toContain('Sin conexión · <b>{{ offline.pending() }}</b> sin subir');
  });

  it('⛔ la tarjeta de «fase terminada» no pone un check verde sobre una cola sucia', () => {
    expect(PLANTILLA).toContain('[class.pi-check-circle]="!colaSucia()"');
    expect(PLANTILLA).toContain('[class.pi-exclamation-triangle]="colaSucia()"');
    expect(PLANTILLA).toContain('Faltan <b>{{ offline.pending() }}</b> escaneos por subir');
    expect(PLANTILLA, 'volvió a afirmar que registró el conteo sin mirar la cola')
      .not.toContain('Registramos tu conteo.');
  });

  it('⛔ la cola se drena ANTES de terminar: terminar es el cambio de estado que rechaza lo nuevo', () => {
    const metodo = CONTEO.slice(CONTEO.indexOf('async finishCount()'), CONTEO.indexOf('private refreshProgress()'));
    expect(metodo, 'no se encontró finishCount()').not.toBe('');
    const posFlush = metodo.indexOf('await this.offline.flush()');
    const posFin = metodo.indexOf('this.svc.inventoryFinishSession(id)');
    expect(posFlush, 'ya no se vacía la cola antes de terminar').toBeGreaterThan(-1);
    expect(posFin).toBeGreaterThan(-1);
    expect(posFlush, 'el flush quedó DESPUÉS de terminar: lo nuevo se rechaza con 409').toBeLessThan(posFin);
  });

  it('el drenado periódico ya no se apaga al terminar la jornada', () => {
    const metodo = CONTEO.slice(CONTEO.indexOf('private startPeriodicFlush()'), CONTEO.indexOf('private stopPeriodicFlush()'));
    expect(metodo, 'no se encontró startPeriodicFlush()').not.toBe('');
    // El guard del flush mira la red y la cola, nada más. (La descarga del catálogo sí mira la
    // jornada, y por eso la condición se ancla al `flush`, no al método entero.)
    expect(metodo).toContain('if (this.offline.online() && this.offline.pending() > 0) {');
    expect(
      metodo.includes('this.sessionActive() && this.offline.online() && this.offline.pending()'),
      'el drenado volvió a colgar de la jornada: al terminar deja de reintentar',
    ).toBe(false);
    // Y el único apagado es el de destruir el componente.
    const fin = CONTEO.slice(CONTEO.indexOf('async finishCount()'), CONTEO.indexOf('private refreshProgress()'));
    expect(fin.includes('this.stopPeriodicFlush()'), 'terminar la jornada volvió a apagar el drenado').toBe(false);
  });

  it('⛔ cerrar la app con la cola sucia pregunta primero', () => {
    expect(CONTEO).toContain("window.addEventListener('beforeunload', onBeforeUnload);");
    expect(CONTEO).toContain('if (this.offline.pending() <= 0) return;');
    // Y se quita al destruir: un listener huérfano pregunta en pantallas que no son ésta.
    expect(CONTEO).toContain("window.removeEventListener('beforeunload', onBeforeUnload);");
  });

  it('⛔ salir de la ruta con la cola sucia pregunta, AUNQUE la jornada ya haya terminado', () => {
    expect(GUARDA).toContain('const sinSubir = offline.pending();');
    expect(GUARDA).toContain('if (!enCurso && sinSubir <= 0) return true;');
    expect(GUARDA, 'el candado volvió a mirar sólo el modo foco').not.toContain('if (!focus.active()) return true;');
  });

  it('un dispositivo sin catálogo y sin red lo DICE, en vez de que se descubra escaneando', () => {
    expect(PLANTILLA).toContain('@if (!offline.online() && catalogoLocal() === 0) {');
    expect(PLANTILLA).toContain('no tiene descargado el catálogo del folio');
    // Y nunca sobre una medición que no se pudo hacer: `null` no es cero.
    expect(CONTEO).toContain('.catch(() => this.catalogoLocal.set(null));');
  });

  it('PRUEBA NEGATIVA — devolver el aviso adentro de la jornada pone el candado ROJO', () => {
    const mutante = SOLO_CONTANDO + 'offline.pending()';
    expect(mutante).not.toBe(SOLO_CONTANDO);
    expect(mutante.includes('offline.pending()')).toBe(true);
  });
});
