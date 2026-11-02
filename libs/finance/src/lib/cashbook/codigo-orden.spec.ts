import { ALFABETO, armarCodigo, decidirRetiro, digitoVerificador, leerCodigo, type OrdenConCodigo } from './codigo-orden';

/** `[LE.2.8]` La regla del código: ningún peso sale de la máquina sin una orden (V2, ADR-112). */

const orden = (over: Partial<OrdenConCodigo> = {}): OrdenConCodigo => ({
  codigo: armarCodigo(41), requestId: 'req-1', montoCentavos: 78000n, usadoCentavos: 0n,
  venceEn: '2026-11-02T23:59:59-06:00', clasificacion: { tipo: 'cajon' }, ...over,
});
const retiro = (ref: string | null, total = '780.00', occurred_at = '2026-11-02T10:12:00-06:00') => ({ ref, total, occurred_at });

describe('[LE.2.8] el código de la orden', () => {
  it('tiene la forma XXXX-D, sin I, O, 0 ni 1, y su verificador cuadra', () => {
    for (let n = 0; n < 2000; n++) {
      const c = armarCodigo(n);
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-\d$/);
      expect(Number(c[5])).toBe(digitoVerificador(c.slice(0, 4)));
    }
  });

  it('dos consecutivos distintos nunca dan el mismo código (10,000 seguidos)', () => {
    const vistos = new Set<string>();
    for (let n = 0; n < 10_000; n++) vistos.add(armarCodigo(n).slice(0, 4));
    expect(vistos.size).toBe(10_000);
  });

  it('el verificador caza la mayoría de los errores de dedo — medido, no prometido', () => {
    let cambios = 0, cazados = 0, volteos = 0, cazadosVolteo = 0;
    for (let n = 0; n < 300; n++) {
      const cuerpo = armarCodigo(n).slice(0, 4), dv = digitoVerificador(cuerpo);
      for (let i = 0; i < 4; i++) for (const c of ALFABETO) {
        if (c === cuerpo[i]) continue;
        cambios++; if (digitoVerificador(cuerpo.slice(0, i) + c + cuerpo.slice(i + 1)) !== dv) cazados++;
      }
      for (let i = 0; i < 3; i++) {
        if (cuerpo[i] === cuerpo[i + 1]) continue;
        volteos++; if (digitoVerificador(cuerpo.slice(0, i) + cuerpo[i + 1] + cuerpo[i] + cuerpo.slice(i + 2)) !== dv) cazadosVolteo++;
      }
    }
    expect(cazados / cambios).toBeGreaterThan(0.85);
    expect(cazadosVolteo / volteos).toBeGreaterThan(0.75);
  });
});

describe('[LE.2.8] leer el código de la referencia de CAOS', () => {
  const c = armarCodigo(41);

  it('al inicio de la referencia; el resto del texto es libre', () => {
    expect(leerCodigo(`${c} gnf canindo`)).toEqual({ ok: true, codigo: c });
    expect(leerCodigo(c)).toEqual({ ok: true, codigo: c });
  });

  it('liberal en la forma: minúsculas y espacios alrededor del guion', () => {
    expect(leerCodigo(`  ${c.slice(0, 4).toLowerCase()} - ${c[5]}  nom`)).toEqual({ ok: true, codigo: c });
  });

  it('NEGATIVA: un verificador que no cuadra NO se adivina', () => {
    const malo = `${c.slice(0, 4)}-${(Number(c[5]) + 1) % 10}`;
    expect(leerCodigo(`${malo} gnf`)).toEqual({ ok: false, motivo: 'verificador', leido: malo });
  });

  it('NEGATIVA: el código en medio del texto no cuenta — tiene que ir al inicio', () => {
    expect(leerCodigo(`gnf ${c}`)).toEqual({ ok: false, motivo: 'sin_codigo' });
  });

  it('PLACEBO: las referencias como las de hoy (medidas 2026-11-02) no tienen código', () => {
    const deHoy = ['gnf canindo', 'nom morelia madero', 'nomina semana 44', 'gastos oficina', 'piñatas 8 cajas',
      'bono chofer', 'rompope', 'cueritos', 'levy', 'gasto 8 rutas', 'GNF2 PADRE HIDALGO', null, ''];
    for (const ref of deHoy) expect(leerCodigo(ref).ok).toBe(false);
  });
});

describe('[LE.2.8] qué es un retiro de la máquina, según su código', () => {
  it('con una orden vigente y saldo, el retiro se asienta contra ella, con su clasificación', () => {
    const o = orden({ clasificacion: { tipo: 'custodia', empleado: 'e-1', nombre: 'Compras' } });
    const d = decidirRetiro(retiro(`${o.codigo} compra urgente`), [o]);
    expect(d).toMatchObject({ tipo: 'orden', clasificacion: { tipo: 'custodia', nombre: 'Compras' }, restanteCentavos: 0n });
  });

  it('una orden se puede entregar en dos dispensaciones mientras no pase de lo autorizado', () => {
    const o = orden({ montoCentavos: 100000n, usadoCentavos: 60000n });
    expect(decidirRetiro(retiro(o.codigo, '400.00'), [o])).toMatchObject({ tipo: 'orden', restanteCentavos: 0n });
  });

  it('NEGATIVA: sin código, Suspenso', () => {
    expect(decidirRetiro(retiro('gnf canindo'), [orden()])).toEqual({ tipo: 'suspenso', motivo: 'sin_codigo' });
  });

  it('NEGATIVA: un código que no es de ninguna orden, Suspenso', () => {
    const otro = armarCodigo(99);
    expect(decidirRetiro(retiro(otro), [orden()])).toEqual({ tipo: 'suspenso', motivo: 'desconocido', codigo: otro });
  });

  it('NEGATIVA: más de lo que la orden autorizaba, Suspenso — no se asienta la parte que sí cabía', () => {
    const o = orden();
    expect(decidirRetiro(retiro(o.codigo, '5000.00'), [o])).toEqual({ tipo: 'suspenso', motivo: 'de_mas', codigo: o.codigo });
  });

  it('NEGATIVA: un código ya usado completo, o vencido, Suspenso', () => {
    const usada = orden({ usadoCentavos: 78000n });
    expect(decidirRetiro(retiro(usada.codigo), [usada])).toMatchObject({ tipo: 'suspenso', motivo: 'usado' });
    const o = orden();
    expect(decidirRetiro(retiro(o.codigo, '780.00', '2026-11-03T08:00:00-06:00'), [o])).toMatchObject({ tipo: 'suspenso', motivo: 'vencido' });
  });
});
