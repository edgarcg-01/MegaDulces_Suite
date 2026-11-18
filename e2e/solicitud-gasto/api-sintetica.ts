import type { Page, Request } from '@playwright/test';

/**
 * `[PGP.122]` La API de la solicitud de gasto, SINTÉTICA y con estado: lo que la pantalla manda (crear, firmar,
 * cancelar) cambia lo que las siguientes lecturas contestan, como el servidor real. Ninguna petición sale del
 * navegador.
 *
 * Todo es inventado («Plomería Prueba», «Cajera Prueba», folio 0000083); la FORMA es la de los contratos:
 * `libs/contracts/src/finance/solicitud-gasto.contract.ts`, `ejercicio.contract.ts` y
 * `apps/view/src/app/modules/finanzas/comprobaciones.service.ts`. La sucursal es la 05 (Zamora Centro), la del
 * canario, para que la pantalla diga el nombre que verá la gente.
 *
 * Lo que este modo NO puede decir: si el servidor real acepta el payload (eso es `test-newdb-solicitud-gasto-suite.js`
 * contra Postgres y el ensayo con ROLLBACK contra Kepler), tiempos de red ni volúmenes.
 */

export const YO = 'u-prueba';
const QUIEN_PIDE = 'u-cajero';
const SUC = '05';
const VALE = 'v-prueba-1';
const FOLIO_KEPLER = '0000083';

const B64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Un JWT sin firma válida: el frontend lo decodifica, no lo verifica; ningún servidor lo ve. */
export function tokenSintetico(): string {
  const ahora = Math.floor(Date.now() / 1000);
  return `${B64({ alg: 'HS256', typ: 'JWT' })}.${B64({ sub: YO, id: YO, role_name: 'superadmin', rol: 'superadmin', name: 'Tesorera de prueba', iat: ahora, exp: ahora + 86_400 })}.sin-firma`;
}

export const hoyMx = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const horaMx = (): string => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

const CONCEPTOS = [
  { codigo: 'MANT', nombre: 'Mantenimiento de local', cuenta: '603-008', fuera_de_alcance: null, distinto_de_cedis: null },
  { codigo: 'PAPE', nombre: 'Papelería de prueba', cuenta: '603-020', fuera_de_alcance: null, distinto_de_cedis: null },
];
const PROYECTOS = [{ codigo: 'P01', nombre: 'Proyecto de prueba' }];
const DEPTOS = [{ codigo: 'D01', nombre: 'Departamento de prueba' }];
const ACREEDORES = [
  { clave: 'GP001', nombre: 'Plomería Prueba', rfc: 'XAXX010101000', usos: 4 },
  { clave: 'GL002', nombre: 'Limpieza Prueba', rfc: null, usos: 2 },
];

type Cuerpo = Record<string, unknown>;
export interface Registro {
  /** Lo que la pantalla mandó, tal cual (el «payload de la pantalla» de la regla 13). */
  crear: Cuerpo | null;
  aprobar: Cuerpo | null;
  cancelar: Cuerpo | null;
  subidas: number;
  servidas: number;
  /** Escrituras que no son de este flujo (telemetría, etc.): se abortan y se cuentan. */
  abortadas: string[];
  /** GET que esta API no conoce: se contestan vacíos y se DECLARAN (pueden esconder un defecto de la prueba). */
  desconocidas: string[];
  /** ⛔ Lo que salió del navegador sin pasar por aquí. Debe quedar vacío. */
  salieron: string[];
}

type Etapa = 'nada' | 'pedida' | 'firmada' | 'cancelada';

export async function servirApi(page: Page): Promise<Registro> {
  const reg: Registro = { crear: null, aprobar: null, cancelar: null, subidas: 0, servidas: 0, abortadas: [], desconocidas: [], salieron: [] };
  let etapa: Etapa = 'nada';
  let archivo: Cuerpo | null = null;
  const motivoCancelar = (): string => String(reg.cancelar?.['motivo'] ?? '');

  const total = (): number => {
    const c = reg.crear;
    if (!c) return 0;
    const sub = ((c['renglones'] as Array<{ importe: number }>) ?? []).reduce((s, r) => s + Number(r.importe ?? 0), 0);
    return Math.round((sub + Number(c['iva'] ?? 0)) * 100) / 100;
  };
  const acreedor = () => ACREEDORES.find((a) => a.clave === reg.crear?.['acreedor']) ?? ACREEDORES[0];
  const status = (): string => (etapa === 'pedida' ? 'recibida' : etapa === 'firmada' ? 'aprobada' : 'rechazada');
  const folio = (): string | null => (etapa === 'firmada' || etapa === 'cancelada' ? FOLIO_KEPLER : null);

  const expediente = () => ({
    id: VALE, folio_solicitud: folio(), sucursal: SUC, fecha_gasto: hoyMx(), created_at: hoyMx(), created_hora: horaMx(),
    importe: total(), departamento: 'Departamento de prueba', solicitante: 'Cajera Prueba', concepto: 'Mantenimiento de local',
    proveedor: acreedor().nombre, clasificacion: null, forma_pago: String(reg.crear?.['forma_pago'] ?? ''), forma_pago_detalle: null,
    comentarios: null, created_by: QUIEN_PIDE, status: status(), etapa: etapa === 'pedida' ? 'entrada' : etapa === 'firmada' ? 'aprobados' : 'rechazados',
    motivo_rechazo: etapa === 'cancelada' ? `Cancelada en Kepler desde la Suite: ${motivoCancelar()}` : null, revision_nota: null,
    validated_by: etapa === 'pedida' ? null : YO, validated_at: etapa === 'pedida' ? null : new Date().toISOString(),
    requiere_evidencia: true, tiene_evidencia: !!archivo, evidencia_en_vivo: false, files: archivo ? [archivo] : [], provisional: false, departamentos: null,
  });
  const naceEnLaSuite = () => (etapa === 'pedida'
    ? { status: 'pending', nota: null, siguiente: null, intentos: 0 }
    : etapa === 'firmada' ? { status: 'written', nota: null, siguiente: null, intentos: 1 }
    : { status: 'cancelled', nota: `Cancelada en Kepler desde la Suite: ${motivoCancelar()}`, siguiente: null, intentos: 1 });
  const keplerDelVale = () => ({
    solicitud: folio(), estado: etapa === 'firmada' ? 'A' : etapa === 'cancelada' ? 'C' : null, suite: null, nace_en_la_suite: naceEnLaSuite(),
  });
  const estadoSolicitud = () => ({ id: VALE, status: naceEnLaSuite().status, folio: folio(), nota: naceEnLaSuite().nota, intentos: naceEnLaSuite().intentos, siguiente: null });
  const grupo = (clave: string, etiqueta: string, ids: string[]) => ({ clave, etiqueta, n: ids.length, monto: ids.length ? total() : 0, ids });

  const delDia = () => {
    const filas = etapa === 'nada' ? [] : [expediente()];
    const entrada = etapa === 'pedida' ? [VALE] : [];
    const cero = { n: 0, monto: 0 };
    return {
      fecha: hoyMx(), es_hoy: true, hoy: hoyMx(), fecha_pedida: null, total: filas.length, monto_total: filas.length ? total() : 0,
      etapas: {
        entrada: etapa === 'pedida' ? { n: 1, monto: total() } : cero, aprobados: etapa === 'firmada' ? { n: 1, monto: total() } : cero,
        rechazados: etapa === 'cancelada' ? { n: 1, monto: total() } : cero, sin_etapa: cero,
      },
      filas,
      entrada: {
        total: entrada.length, monto_total: entrada.length ? total() : 0,
        por_fecha: entrada.length ? [grupo(hoyMx(), 'Hoy', entrada)] : [],
        por_departamento: entrada.length ? [{ ...grupo('D01', 'Departamento de prueba', entrada), origen: 'solicitud' }] : [],
      },
      entrada_truncada: false, atrasados: [], atrasados_total: cero, atrasados_truncada: false, atrasados_por_departamento: [],
    };
  };
  const esperanKepler = () => ({
    vales: etapa === 'firmada' ? [{
      id: VALE, folio_solicitud: FOLIO_KEPLER, sucursal: SUC, proveedor: acreedor().nombre, importe: total(), importe_capturado: total(), importe_fuente: null,
      created_by: QUIEN_PIDE, validated_by: YO, capturo_nombre: 'Cajera Prueba', reviso_nombre: 'Tesorera de prueba', revisado_at: new Date().toISOString(),
      dias: 0, espera: 'falta_generar_gasto', hallazgo: false, kepler_estado: 'A', gasto_kepler: null, pista_cancelada: null, cancelada_revisada: null,
    }] : [],
    truncado: false, medido: true,
  });
  const detalle = () => {
    const c = reg.crear ?? {};
    const comp = (c['comprobante'] ?? {}) as Cuerpo;
    return {
      id: VALE, sucursal: SUC, acreedor: { clave: acreedor().clave, nombre: acreedor().nombre },
      renglones: ((c['renglones'] as Array<Cuerpo>) ?? []).map((r, i) => {
        const k = CONCEPTOS.find((x) => x.codigo === r['concepto']);
        return { linea: i + 1, concepto: String(r['concepto']), nombre: k?.nombre ?? null, cuenta: k?.cuenta ?? null, proyecto: String(r['proyecto']), departamento: String(r['departamento']), importe: Number(r['importe']) };
      }),
      iva: Number(c['iva'] ?? 0), total: total(),
      documento: { tipo: (comp['tipo'] as string) ?? null, folio: (comp['folio'] as string) ?? null, fecha: (comp['fecha'] as string) ?? null, uuid: (comp['uuid'] as string) ?? null },
      fecha_solicitud: hoyMx(), necesita_para: null, pago: null,
    };
  };

  const atendidas = new WeakSet<Request>();
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/**', async (r) => {
    const q = r.request();
    atendidas.add(q);
    const u = new URL(q.url());
    const p = u.pathname.replace(/^.*?\/api\//, '/');
    const m = q.method();
    const cuerpo = (): Cuerpo => { try { return (q.postDataJSON() ?? {}) as Cuerpo; } catch { return {}; } };
    reg.servidas++;

    // ── Las escrituras de ESTE flujo (se contestan; nada sale) ──
    if (m === 'POST' && p === '/finance/expenses/proofs/upload') {
      reg.subidas++;
      const b = cuerpo();
      archivo = { role: String(b['role'] ?? 'ticket'), url: 'https://ejemplo.invalid/ticket-prueba.png', public_id: 'prueba/ticket-1', kind: 'image', name: 'ticket-prueba.png', live: b['live'] === true };
      return r.fulfill(json(archivo));
    }
    if (m === 'POST' && p === '/finance/expenses/solicitudes/leer-comprobante') {
      return r.fulfill(json({
        legible: true, motivo: null, acreedor: null, cfdi: null,
        leido: { total: 116, subtotal: 100, iva: 16, fecha: hoyMx(), folio: 'T-0001', rfc: null, comercio: 'Plomería Prueba' },
      }));
    }
    if (m === 'POST' && p === '/finance/expenses/solicitudes') {
      reg.crear = cuerpo();
      etapa = 'pedida';
      return r.fulfill(json({ id: VALE, status: 'recibida', kepler_request_status: 'pending', total: total(), retroactiva: false, duplicados: [] }));
    }
    if (m === 'POST' && p === `/finance/expenses/proofs/${VALE}/approve`) {
      reg.aprobar = cuerpo();
      etapa = 'firmada';
      // Control negativo (regla 12): con E2E_MUTANTE=kepler_rechaza la firma NO escribe en Kepler y la prueba debe salir roja.
      if (process.env.E2E_MUTANTE === 'kepler_rechaza') {
        return r.fulfill(json({ id: VALE, status: 'aprobada', solicitud_kepler: { ...estadoSolicitud(), status: 'rejected_by_kepler', folio: null, nota: 'Mutante: Kepler la rechazó.' } }));
      }
      return r.fulfill(json({ id: VALE, status: 'aprobada', solicitud_kepler: estadoSolicitud() }));
    }
    if (m === 'POST' && p === `/finance/expenses/solicitudes/${VALE}/cancelar-en-kepler`) {
      reg.cancelar = cuerpo();
      etapa = 'cancelada';
      return r.fulfill(json(estadoSolicitud()));
    }
    if (m !== 'GET') { reg.abortadas.push(`${m} ${p}`); return r.abort('blockedbyclient'); }

    // ── Lecturas ──
    const sp = u.searchParams;
    if (p === '/finance/expenses/solicitudes/abiertas') return r.fulfill(json({ sucursales: [SUC], alcance: 'una' }));
    if (p === '/finance/expenses/solicitudes/disponibilidad') return r.fulfill(json({ sucursal: sp.get('sucursal'), disponible: true, motivos: [] }));
    if (p === '/finance/expenses/solicitudes/catalogo') return r.fulfill(json({ sucursal: SUC, conceptos: CONCEPTOS, proyectos: PROYECTOS, departamentos: DEPTOS }));
    if (p === '/finance/expenses/solicitudes/acreedores') {
      const t = (sp.get('q') ?? '').toLowerCase();
      return r.fulfill(json(ACREEDORES.filter((a) => !t || a.nombre.toLowerCase().includes(t) || a.clave.toLowerCase().includes(t)).slice(0, Number(sp.get('limit') ?? 20))));
    }
    if (p === '/finance/expenses/solicitudes/precarga') {
      const a = ACREEDORES.find((x) => x.clave === sp.get('acreedor')) ?? null;
      return r.fulfill(json({
        acreedor: a, alcance: { dentro: true }, conceptos: [{ ...CONCEPTOS[0], usos: 4 }],
        ultimo: { concepto: 'MANT', proyecto: 'P01', departamento: 'D01', fecha: hoyMx() }, forma_pago: 'transferencia',
        plazo: { dias: 0, fuente: 'habito' }, pago: null,
      }));
    }
    if (p === '/finance/expenses/solicitudes/duplicados') return r.fulfill(json([]));
    if (p === '/finance/expenses/solicitudes/facturas-sat') {
      return r.fulfill(json({
        sucursal: SUC, desde: hoyMx(), ultima_llegada: new Date().toISOString(), horas_sin_llegadas: 0,
        por_registrar: [], registradas: [], descartadas: [], sin_sucursal_clara: 0, declarado: [],
      }));
    }
    if (p === `/finance/expenses/solicitudes/${VALE}/detalle`) return r.fulfill(json(detalle()));
    if (p === '/finance/expenses/proofs/del-dia') return r.fulfill(json(delDia()));
    if (p === '/finance/expenses/proofs/reaperturas/pendientes') return r.fulfill(json([]));
    if (p === '/finance/expenses/proofs/esperan-kepler') return r.fulfill(json(esperanKepler()));
    if (p === '/finance/expenses/kepler-autorizacion') {
      const ids = (sp.get('ids') ?? '').split(',').filter(Boolean);
      return r.fulfill(json(Object.fromEntries(ids.filter((i) => i === VALE && etapa !== 'nada').map((i) => [i, keplerDelVale()]))));
    }
    if (p === '/finance/expenses/proofs/buscar') {
      const t = sp.get('q') ?? '';
      const hay = etapa !== 'nada' && (!t || t.includes(FOLIO_KEPLER) || 'plomería prueba'.includes(t.toLowerCase()));
      return r.fulfill(json({ q: t, recientes: !t, vales: hay ? [expediente()] : [], vales_truncado: false, sin_vale: [], sin_vale_truncado: false, solicitudes_desde: null }));
    }
    if (p === `/finance/expenses/proofs/${VALE}`) return r.fulfill(json({ ...expediente(), storage_ok: true }));
    if (p === '/users/me/access') return r.fulfill(json({ permissions: {} }));
    // Lo que el marco de la Suite pide en cualquier pantalla: vacío, con SU forma (con `{data: []}` el marco truena
    // con «t.filter is not a function» y el error es de la prueba, no del producto).
    if (p === '/users/me/scope') return r.fulfill(json({ user_id: YO, role_name: 'superadmin', dimensions: {} }));
    if (p === '/service-desk/me/notifications' || p === '/store/labels/notices') return r.fulfill(json([]));
    if (p === '/commercial/replenishment/requisitions/por-aprobar') return r.fulfill(json({ n: 0, monto: 0, recientes: [] }));
    if (p === '/finance/expenses/proofs/mine') return r.fulfill(json({ kpis: { total: 0, recibidas: 0, validadas: 0, rechazadas: 0 }, rows: [] }));
    if (p === '/finance/expenses/expediente/listas-para-comprobar') return r.fulfill(json({ medido: true, motivo: null, ventana_dias: 30, rows: [] }));

    reg.desconocidas.push(p);
    return r.fulfill(json({ data: [] }));
  });
  await page.route('**/socket.io/**', (r) => { atendidas.add(r.request()); reg.abortadas.push('WS'); return r.abort('blockedbyclient'); });
  const revisar = (q: Request) => {
    if (!atendidas.has(q) && /\/(api|socket\.io)\//.test(new URL(q.url()).pathname)) reg.salieron.push(`${q.method()} ${new URL(q.url()).pathname}`);
  };
  page.on('requestfinished', revisar);
  page.on('requestfailed', revisar);
  return reg;
}
