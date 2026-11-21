import type { ComprobacionEnLaCola, EstadoKeplerDelGasto, MotivoSinComprobar, QuienResuelve } from '@megadulces/contracts';
import type { ValeEsperaKepler } from '../comprobaciones.service';
import {
  colaDeKepler, esCanceladaEnKepler, grupoDelVale, lecturaSinEscribir, lineaDelGasto, loEscribeLaSuite, partirCanceladas, polizaCorta,
  puedeEscribirseYa, quienTexto, solicitudSinEscribir, TITULO_OTRO_MOTIVO,
} from './esperan-kepler.ayudas';

/**
 * `[PGP.123]` G.9 — Las reglas de «Esperan a Kepler» como cola de comprobación (anexo G §14). Lo que cuidan:
 *
 * - ⛔ que «la Suite las escribe» no cuente lo que la Suite NO va a escribir. Hoy el interruptor nace apagado en todas
 *   las bases (DG7 se retiró con G.1, 2026-11-20): si un vale «listo» se contara como de la Suite, nadie lo capturaría en Kepler;
 * - ⛔ que un gasto «en duda» fuera de una base abierta no se mande a capturar a mano: puede que ya esté en Kepler;
 * - que ningún vale se pierda ni se repita entre secciones (las secciones suman lo que dice la pestaña).
 */

type GOpts = {
  motivo?: MotivoSinComprobar; quien?: QuienResuelve; texto?: string;
  abierta?: boolean; motivoEscritura?: string; gasto?: Partial<EstadoKeplerDelGasto>;
};
const G = (o: GOpts = {}): ComprobacionEnLaCola => ({
  comprobacion: o.motivo
    ? { listo: false, motivo: o.motivo, quien: o.quien ?? 'sucursal', texto: o.texto ?? 'El vale es por $347.59 y la solicitud por $518.00: se comprueba en Kepler' }
    : { listo: true, fecha: '2026-11-10' },
  gasto: o.gasto ? { id: 'v', status: null, folio: null, poliza: null, fecha: null, nota: null, intentos: 0, siguiente: null, ...o.gasto } : null,
  escritura: o.abierta
    ? { abierta: true, motivo: null, detalle: null }
    : { abierta: false, motivo: o.motivoEscritura ?? 'La escritura de gastos a Kepler todavía está apagada en esta base', detalle: 'interruptor' },
});

const V = (id: string, over: Partial<ValeEsperaKepler> = {}): ValeEsperaKepler => ({
  id, folio_solicitud: '0000501', sucursal: '02', proveedor: 'PROVEEDOR DEMO', importe: 100,
  created_by: 'demo.capturista', validated_by: 'demo.revisor', revisado_at: '2026-11-01T10:00:00.000Z',
  dias: 5, espera: 'falta_generar_gasto', hallazgo: false, kepler_estado: 'A', ...over,
});

describe('[PGP.123] G.9 la cola de comprobación', () => {
  describe('quién lo mueve', () => {
    it('⛔ lo listo en una base donde la Suite no escribe NO es «la Suite las escribe»: va con lo que hace una persona', () => {
      const g = G();
      expect(loEscribeLaSuite(g)).toBe(false);
      expect(grupoDelVale(g)).toBe('apagada');
      const q = colaDeKepler([V('a', { gasto_kepler: g })]);
      expect(q.laSuite).toEqual([]);
      expect(q.conMotivo.map((x) => x.clave)).toEqual(['apagada']);
      expect(q.conMotivo[0].titulo).toContain('mientras, las comprueba la sucursal en Kepler');
    });

    it('lo listo en una base abierta, y lo ya escrito o escribiéndose, sí son de la Suite', () => {
      expect(grupoDelVale(G({ abierta: true }))).toBe('la_suite');
      expect(grupoDelVale(G({ gasto: { status: 'written', folio: '0000123', poliza: 'kdc22611/D/4' } }))).toBe('la_suite');
      expect(grupoDelVale(G({ gasto: { status: 'writing' } }))).toBe('la_suite');
      // Reconocido: el gasto que capturó una persona y la Suite ligó por su folio, aunque la base esté cerrada.
      expect(grupoDelVale(G({ motivo: 'total_distinto', gasto: { status: 'seen_in_ods', folio: '0000124' } }))).toBe('la_suite');
    });

    it('⛔ «en duda» fuera de una base abierta necesita a una persona, y le dice que lo busque antes de capturarlo', () => {
      const g = G({ gasto: { status: 'in_doubt' } });
      expect(grupoDelVale(g)).toBe('fallo');
      expect(lineaDelGasto(g).texto).toBe('En duda: puede que ya esté en Kepler; búscalo antes de capturarlo');
      expect(lineaDelGasto(g).tono).toBe('warn');
      // Lo que la Suite intentó lo atiende Finanzas (decide si se reintenta), no la sucursal.
      expect(lineaDelGasto(g).quien).toBe('Finanzas, en Kepler');
      // Con la base abierta la duda la resuelve la Suite (busca el gasto antes de reintentar).
      const abierta = G({ abierta: true, gasto: { status: 'in_doubt' } });
      expect(grupoDelVale(abierta)).toBe('la_suite');
      expect(lineaDelGasto(abierta).texto).toContain('la Suite lo busca en Kepler');
    });

    it('atorado, rechazado por Kepler o cancelado: a una persona, en rojo, con su nota', () => {
      for (const status of ['stuck', 'rejected_by_kepler', 'cancelled']) {
        const g = G({ abierta: true, gasto: { status, nota: 'el periodo está cerrado', folio: status === 'cancelled' ? '0000125' : null } });
        expect(grupoDelVale(g)).toBe('fallo');
        expect(lineaDelGasto(g).tono).toBe('bad');
        expect(lineaDelGasto(g).texto).toContain('el periodo está cerrado');
        expect(lineaDelGasto(g).quien).toBe('Finanzas, en Kepler');
      }
    });

    it('con motivo: por quién lo mueve, la sucursal primero (la comprobación es suya); sin medir y ya comprobado van aparte', () => {
      const q = colaDeKepler([
        V('s', { gasto_kepler: G({ motivo: 'sin_cerrar', quien: 'suite', texto: 'El vale todavía no se valida en la Suite' }) }),
        V('c', { gasto_kepler: G({ motivo: 'fecha_otro_mes', quien: 'contabilidad', texto: 'La solicitud es de octubre…' }) }),
        V('k', { gasto_kepler: G({ motivo: 'total_distinto' }) }),
        V('f', { gasto_kepler: G({ motivo: 'sin_autorizar', quien: 'finanzas', texto: 'Falta que autoricen la solicitud en Kepler' }) }),
        V('m', { gasto_kepler: G({ motivo: 'sin_medir', quien: 'nadie', texto: 'No se pudo leer la solicitud en Kepler…' }) }),
        V('y', { gasto_kepler: G({ motivo: 'ya_comprobado', quien: 'nadie', texto: 'Ya tiene su gasto en Kepler' }) }),
      ]);
      expect(q.conMotivo.map((g) => g.clave)).toEqual(['sucursal', 'finanzas', 'contabilidad', 'suite', 'sin_calcular', 'ya_tiene']);
      expect(q.conMotivo[0].titulo).toBe('Las comprueba la sucursal, en Kepler');
      expect(q.conMotivo[1].titulo).toBe('Le toca a Finanzas, en Kepler');
    });

    it('⛔ un «quién» que la pantalla no conoce (otra versión del servidor) no esconde sus vales: van al final y lo dice', () => {
      const raro = 'kepler' as QuienResuelve;
      const q = colaDeKepler([
        V('k', { gasto_kepler: G({ motivo: 'total_distinto', quien: raro }) }),
        V('s', { gasto_kepler: G({ motivo: 'total_distinto' }) }),
      ]);
      expect(q.conMotivo.map((g) => [g.clave, g.titulo, g.vales.map((v) => v.id)])).toEqual([
        ['sucursal', 'Las comprueba la sucursal, en Kepler', ['s']],
        ['kepler', TITULO_OTRO_MOTIVO, ['k']],
      ]);
      expect(lineaDelGasto(G({ motivo: 'total_distinto', quien: raro })).quien).toBeNull();
    });

    it('⛔ sin el cálculo del servidor (versión anterior o falla) no se finge que se comprueba sola', () => {
      for (const g of [undefined, null]) {
        expect(grupoDelVale(g)).toBe('sin_calcular');
        expect(lineaDelGasto(g).texto).toBe('No se pudo calcular si se comprueba sola: revísalo en Kepler');
        expect(puedeEscribirseYa(g)).toBe(false);
      }
    });
  });

  it('cada vale cae en UNA sección: ninguno se pierde ni se repite', () => {
    const vales = [
      V('suite', { gasto_kepler: G({ abierta: true }) }),
      V('apagada', { gasto_kepler: G() }),
      V('motivo', { gasto_kepler: G({ motivo: 'total_distinto' }) }),
      V('sincalc'),
      V('autorizar', { espera: 'falta_autorizar', kepler_estado: 'N' }),
      V('aplicada', { espera: 'aplicada_sin_ligar', kepler_estado: 'F' }),
      // Una cancelada con gasto es hallazgo aunque su espera diga otra cosa: va con las canceladas.
      V('cancelada', { espera: 'falta_generar_gasto', hallazgo: true, kepler_estado: 'C', gasto_kepler: G({ abierta: true }) }),
      // `[PGP.123]` G.UI.1c: la cancelada SIN gasto (antes el servidor la descartaba) va con las canceladas, no a «sin medir».
      V('cancelada-sin-gasto', { espera: null, hallazgo: false, kepler_estado: 'C' }),
      V('sinmedir', { espera: null }),
      // `[PGP.122]` Nació en la Suite y Kepler no la tiene (la rechazó): su propia sección, no «sin medir».
      V('sin-escribir', { folio_solicitud: null, espera: 'sin_medir', kepler_estado: null, nace_en_la_suite: { status: 'rejected_by_kepler', nota: 'acreedor suspendido', siguiente: null, intentos: 1 } }),
    ];
    const q = colaDeKepler(vales);
    const enSecciones = [
      ...q.sinEscribir, ...q.laSuite, ...q.conMotivo.flatMap((g) => g.vales), ...q.porAutorizar, ...q.aplicadaSinLigar, ...q.canceladas, ...q.sinMedir,
    ].map((v) => v.id);
    expect(enSecciones.sort()).toEqual(vales.map((v) => v.id).sort());
    expect(q.porComprobar.map((v) => v.id).sort()).toEqual([...q.laSuite, ...q.conMotivo.flatMap((g) => g.vales)].map((v) => v.id).sort());
    expect(q.canceladas.map((v) => v.id)).toEqual(['cancelada', 'cancelada-sin-gasto']);
    expect(q.sinMedir.map((v) => v.id)).toEqual(['sinmedir']);
    expect(q.sinEscribir.map((v) => v.id)).toEqual(['sin-escribir']);
  });

  /**
   * `[PGP.122]` La solicitud que nació en la Suite y Kepler rechazó caía en «No se pudo leer su estado en Kepler»: Kepler sí
   * contestó. Medido con Playwright el 2026-11-19 (API sintética): plegada, sin el motivo y sin poder abrirse.
   */
  it('[PGP.122] la solicitud de la Suite que Kepler no tiene va a su sección, con lo que dijo Kepler', () => {
    const rech = { status: 'rejected_by_kepler', nota: 'Kepler no aceptó el acreedor GP001', siguiente: null, intentos: 1 };
    expect(solicitudSinEscribir({ folio_solicitud: null, nace_en_la_suite: rech })).toBe(true);
    expect(solicitudSinEscribir({ folio_solicitud: '  ', nace_en_la_suite: rech })).toBe(true);
    // Ya escrita (tiene folio): sigue su camino normal (autorizada, espera su gasto).
    expect(solicitudSinEscribir({ folio_solicitud: '0000083', nace_en_la_suite: { ...rech, status: 'written' } })).toBe(false);
    // No nació en la Suite: un vale sin folio de los de antes no cambia de sección.
    expect(solicitudSinEscribir({ folio_solicitud: null })).toBe(false);
    expect(lecturaSinEscribir({ nace_en_la_suite: rech })).toEqual({ texto: 'Kepler: no la aceptó · Kepler no aceptó el acreedor GP001', tono: 'bad' });
    expect(lecturaSinEscribir({ nace_en_la_suite: { status: 'retry', nota: null, siguiente: null, intentos: 1 } })).toEqual({ texto: 'Kepler: se reintenta sola', tono: 'warn' });
    // ⛔ Un punto final no se come la última letra de la nota.
    expect(lecturaSinEscribir({ nace_en_la_suite: { ...rech, nota: 'acreedor suspendido.' } }).texto).toBe('Kepler: no la aceptó · acreedor suspendido.');
  });

  it('G.UI.1c: las canceladas, partidas en con gasto (¿salió dinero?) y sin gasto', () => {
    const conGasto = V('a', { espera: null, hallazgo: true, kepler_estado: 'C' });
    const sinGasto = V('b', { espera: null, hallazgo: false, kepler_estado: ' C ' });
    expect(esCanceladaEnKepler(conGasto)).toBe(true);
    expect(esCanceladaEnKepler(sinGasto)).toBe(true);
    expect(esCanceladaEnKepler(V('c'))).toBe(false);
    expect(partirCanceladas([conGasto, sinGasto])).toEqual({ conGasto: [conGasto], sinGasto: [sinGasto], revisadas: [] });
    // `[PGP.123]` G.UI.1e: lo ya revisado va aparte, fuera de lo pendiente.
    const revisada = V('r', { espera: null, hallazgo: true, kepler_estado: 'C', cancelada_revisada: { por: 'X', at: '2026-11-16T10:00:00.000Z', nota: 'listo' } });
    expect(partirCanceladas([conGasto, revisada])).toEqual({ conGasto: [conGasto], sinGasto: [], revisadas: [revisada] });
  });

  describe('la línea del gasto', () => {
    it('escrito por la Suite: su folio y la póliza como se busca en Kepler', () => {
      const l = lineaDelGasto(G({ gasto: { status: 'written', folio: '0000123', poliza: 'kdc22611/D/4' } }));
      expect(l).toEqual({ texto: 'Escrito por la Suite: X-A-10 0000123 · póliza D 4 (nov 2026)', tono: 'ok', quien: null });
    });

    it('listo con la base cerrada: se comprobaría sola, el motivo de la base y a quién le toca mientras', () => {
      const l = lineaDelGasto(G({ motivoEscritura: 'En esta base la Suite todavía no escribe gastos: su póliza lleva un contador que falta medir' }));
      expect(l.texto).toBe('Se comprobaría sola, pero en esta base la Suite todavía no escribe gastos: su póliza lleva un contador que falta medir');
      expect(l.quien).toBe('la sucursal, en Kepler');
    });

    it('listo con la base abierta: se comprueba sola en el siguiente ciclo; un reintento dice su nota', () => {
      expect(lineaDelGasto(G({ abierta: true })).texto).toBe('Se comprueba sola: la Suite la escribe en el siguiente ciclo (cada 5 min)');
      expect(lineaDelGasto(G({ abierta: true, gasto: { status: 'retry', nota: 'Kepler no contestó' } })).texto)
        .toBe('La Suite lo reintenta sola: Kepler no contestó');
    });

    it('con motivo: el texto de la regla G.5 y quién lo mueve aparte (la cola ya lo dice en su título)', () => {
      const l = lineaDelGasto(G({ motivo: 'total_distinto' }));
      expect(l.texto).toBe('El vale es por $347.59 y la solicitud por $518.00: se comprueba en Kepler');
      expect(l.quien).toBe('la sucursal, en Kepler');
      expect(lineaDelGasto(G({ motivo: 'ya_comprobado', quien: 'nadie', texto: 'Ya tiene su gasto en Kepler' })).quien).toBeNull();
    });

    it('una póliza con otra forma se dice tal cual (no se inventa)', () => {
      expect(polizaCorta('kdc22611/D/4')).toBe('D 4 (nov 2026)');
      expect(polizaCorta('otra/forma')).toBe('otra/forma');
    });
  });

  it('«Escribir el gasto» sólo se ofrece donde la Suite lo escribiría y no hay gasto escrito', () => {
    expect(puedeEscribirseYa(G({ abierta: true }))).toBe(true);
    expect(puedeEscribirseYa(G({ abierta: true, gasto: { status: 'stuck', nota: 'x' } }))).toBe(true);
    expect(puedeEscribirseYa(G())).toBe(false);
    expect(puedeEscribirseYa(G({ abierta: true, motivo: 'total_distinto' }))).toBe(false);
    expect(puedeEscribirseYa(G({ abierta: true, gasto: { status: 'written', folio: '0000123' } }))).toBe(false);
    expect(puedeEscribirseYa(G({ abierta: true, gasto: { status: 'writing' } }))).toBe(false);
  });

  it('G.UI.8: la persona por su nombre; sin nombre, su clave; un actor del sistema sin el código del tracker', () => {
    expect(quienTexto('Nombre Demo', 'demo.usuario')).toBe('Nombre Demo');
    expect(quienTexto(null, 'demo.usuario')).toBe('demo.usuario');
    expect(quienTexto('  ', '')).toBe('—');
    expect(quienTexto(null, 'cierre GX.82 (aprobado con cotización)')).toBe('el cierre automático (aprobado con cotización)');
  });
});
