'use strict';
/**
 * `[GP.A.2]` Las verificaciones de la bitácora de la autorización de pedidos (`finance.order_authorizations`), en UN
 * lugar, para dos llamadores:
 *  · `database/tests/test-newdb-autorizacion-pedidos.js` — contra una base de pruebas (CI o local), con `pg`.
 *  · `ops/prod/simulacion-bitacora-autorizacion/simular.js` — contra PRODUCCIÓN, dentro de una transacción que se
 *    deshace, después de correr la migración real en esa misma transacción.
 *
 * El llamador abre y cierra la transacción y elige el rol (app_runtime). Aquí sólo se escribe con las sentencias
 * LEÍDAS DEL SERVICIO (`autorizacion-decision.service.ts`) y los valores que arma con el cuerpo del panel.
 *
 * `c` es cualquier cosa con `query(sql, params) → { rows, rowCount }` que lance un error con `code` (SQLSTATE).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'libs', 'finance', 'src', 'lib', 'customer-ledger', 'autorizacion-decision.service.ts');
/** `[GP.A.4b]` Lo que LEE la bandeja (otro archivo, el mismo criterio: el SQL se toma del código, no se copia). */
const SRC_BANDEJA = path.join(__dirname, '..', '..', '..', 'libs', 'finance', 'src', 'lib', 'customer-ledger', 'autorizacion-pedidos.service.ts');
const TIPOS_PREVIOS = ['cancela_oc', 'cancela_requisicion', 'cancela_solicitud_gasto', 'cliente', 'compra',
  'comprobacion_gasto', 'solicitud_gasto', 'telemarketing', 'traspaso', 'telefono_cliente'];

/** Una sentencia exportada del servicio (`export const NOMBRE = \`...\``), con `?` → `$n`. */
function delServicio(src, nombre) {
  const m = src.match(new RegExp(`export const ${nombre} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`no encontré ${nombre} en el servicio`);
  let n = 0;
  return m[1].replace(/\?/g, () => `$${++n}`);
}

/**
 * @param c       cliente con `query`
 * @param r       { P, F, NM } — reportan ✔, ✘ y NO MEDIDO
 * @param o       { tenant, otro, usuario } — el tenant de la prueba, otro para RLS y `current_user` de la sesión
 */
async function verificarBitacora(c, { P, F, NM }, { tenant, otro, usuario }) {
  const src = fs.readFileSync(SRC, 'utf8');
  const INSERTAR = delServicio(src, 'INSERTAR_DECISION');
  const CERRAR = delServicio(src, 'CERRAR_DECISION');
  const VENCER = delServicio(src, 'VENCER_PENDIENTES');
  const ULTIMA = delServicio(src, 'ULTIMA_AUTORIZACION');
  // Lo que arma `decidir` con el cuerpo del panel: (sucursal, serie, folio, cliente, importe, accion, automatica, motivo, regla, estado, created_by, updated_by)
  const fila = (folio, accion, estado, o = {}) => ['97', 1, folio, 'T-CLI-GPA2', 1500, accion, false, o.motivo ?? 'paga a tiempo',
    JSON.stringify({ decision: 'bandeja', motivos: [{ condicion: 2, texto: 'excede' }] }), estado, 'prueba', 'prueba'];
  const rechaza = async (nombre, sql, params, codigo) => {
    await c.query('SAVEPOINT n');
    try { await c.query(sql, params); F(`${nombre}: la base lo aceptó`); }
    catch (e) { if (!codigo || e.code === codigo) P(`${nombre}: rechazado (${e.code})`); else F(`${nombre}: falló con ${e.code}, se esperaba ${codigo}`); }
    await c.query('ROLLBACK TO SAVEPOINT n');
  };

  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);

  // 7. El interruptor y la llave
  const def = (await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
    WHERE conrelid = 'commercial.kepler_push_switch'::regclass AND conname = 'kepler_push_switch_tipo_ck'`)).rows[0]?.d || '';
  const tipos = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  if (tipos.includes('autorizacion')) P('el interruptor acepta autorizacion'); else F(`el CHECK no tiene autorizacion: ${tipos}`);
  const perdidos = TIPOS_PREVIOS.filter((t) => !tipos.includes(t));
  if (!perdidos.length) P('los tipos que ya existían siguen en la restricción'); else F(`la migración borró tipos: ${perdidos}`);
  const sw = (await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int on_, count(*) FILTER (WHERE tope_dia IS NULL)::int sin_tope
                               FROM commercial.kepler_push_switch WHERE tipo = 'autorizacion'`)).rows[0];
  if (sw.n === 9 && sw.on_ === 0 && sw.sin_tope === 9) P('9 renglones autorizacion, apagados y sin tope (sólo a mano, D-A14)');
  else if (sw.n === 0) NM('sin renglones autorizacion en esta base (tenant sin sembrar)');
  else F(`autorizacion: ${sw.n} renglones, ${sw.on_} encendidos, ${sw.sin_tope} sin tope (se esperaban 9, 0 y 9)`);
  const llave = (await c.query(`SELECT role_name FROM identity.role_permissions
    WHERE permissions -> 'FINANCE_PEDIDOS_AUTORIZAR' = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`)).rows.map((x) => x.role_name);
  const hayRol = (await c.query(`SELECT count(*)::int n FROM identity.role_permissions WHERE role_name = 'credito_cobranza' AND deleted_at IS NULL`)).rows[0].n;
  if (!hayRol) NM('esta base no tiene el rol credito_cobranza: la llave sólo quedó en superadmin');
  else if (llave.length === 1 && llave[0] === 'credito_cobranza') P('FINANCE_PEDIDOS_AUTORIZAR repartida a credito_cobranza y a nadie más (fuera de superadmin)');
  else F(`FINANCE_PEDIDOS_AUTORIZAR en: ${llave.join(', ') || '(nadie)'}`);

  // 1. Autorizar: pendiente → escrito; cerrar otra vez no toca nada
  const id = (await c.query(INSERTAR, fila('T-0000001', 'autorizar', 'pendiente'))).rows[0].id;
  const kepler = JSON.stringify({ estado: 'escrito', de: 'CREADO', a: 'AUTORIZADO' });
  const r1 = await c.query(CERRAR, ['escrito', kepler, 'prueba', id]);
  const r2 = await c.query(CERRAR, ['rechazado', '{}', 'prueba', id]);
  const v = (await c.query(`SELECT estado, kepler_resultado->>'a' a, regla->>'decision' d, tenant_id::text t FROM finance.order_authorizations WHERE id = $1`, [id])).rows[0];
  if (r1.rowCount === 1 && v.estado === 'escrito' && v.a === 'AUTORIZADO' && v.d === 'bandeja' && v.t === tenant) P('autorizar nace pendiente y se cierra escrito, con la regla y el tenant de la sesión');
  else F(`autorizar: ${JSON.stringify({ r1: r1.rowCount, ...v })}`);
  if (r2.rowCount === 0) P('cerrar una fila que ya no está pendiente no toca nada'); else F('se cerró dos veces');

  // 2. Dos escrituras a la vez
  await c.query(INSERTAR, fila('T-0000002', 'autorizar', 'pendiente'));
  await rechaza('dos escrituras en curso del mismo pedido', INSERTAR, fila('T-0000002', 'regresar', 'pendiente'), '23505');

  // 3. Rechazar / escalar
  const rech = (await c.query(INSERTAR, fila('T-0000003', 'rechazar', 'registrado', { motivo: 'debe 92 días' }))).rows[0].id;
  if (rech) P('rechazar nace registrado');
  await rechaza('rechazar que nace pendiente', INSERTAR, fila('T-0000003', 'rechazar', 'pendiente'), '23514');
  await rechaza('autorizar que nace registrado', INSERTAR, fila('T-0000003', 'autorizar', 'registrado'), '23514');

  // 4. La que se quedó a medias
  const a1 = await c.query(VENCER, ['97', 1, 'T-0000002', 2]);
  const a2 = await c.query(VENCER, ['97', 1, 'T-0000002', -1]);
  const venc = (await c.query(`SELECT estado FROM finance.order_authorizations WHERE folio = 'T-0000002' AND accion = 'autorizar'`)).rows[0];
  if (a1.rowCount === 0 && a2.rowCount === 1 && venc.estado === 'rechazado') P('la pendiente vencida se cierra rechazado; dentro del plazo, no');
  else F(`vencer: dentro=${a1.rowCount} vencida=${a2.rowCount} estado=${venc.estado}`);

  // 5. Regresar (D-A7)
  const u1 = (await c.query(ULTIMA, ['97', 1, 'T-0000001'])).rows;
  const reg = (await c.query(INSERTAR, fila('T-0000001', 'regresar', 'pendiente', { motivo: 'se pasó' }))).rows[0].id;
  await c.query(CERRAR, ['escrito', JSON.stringify({ estado: 'escrito', de: 'AUTORIZADO', a: 'CREADO' }), 'prueba', reg]);
  await c.query(`UPDATE finance.order_authorizations SET created_at = created_at + interval '1 second' WHERE id = $1`, [reg]);
  const u2 = (await c.query(ULTIMA, ['97', 1, 'T-0000001'])).rows;
  if (u1.length === 1 && u1[0].id === id && u2.length === 0) P('la autorización vigente se encuentra, y deja de estarlo al regresarse');
  else F(`ultima: antes=${JSON.stringify(u1)} después=${JSON.stringify(u2)}`);

  // 6. Negativas de la tabla
  await rechaza('decisión de una persona sin motivo', INSERTAR, fila('T-0000004', 'rechazar', 'registrado', { motivo: '  ' }), '23514');
  await rechaza('acción inventada', INSERTAR, fila('T-0000004', 'cancelar', 'pendiente'), '23514');
  const auto = (accion, quien) => ['97', 1, 'T-0000005', 'T-CLI-GPA2', 1500, accion, true, null, '{}', accion === 'autorizar' ? 'pendiente' : 'registrado', quien, quien];
  await c.query('SAVEPOINT a');
  try { await c.query(INSERTAR, auto('autorizar', null)); P('una automática (autorizar, sin persona ni motivo) entra'); } catch (e) { F(`la automática no entró: ${e.message}`); }
  await c.query('ROLLBACK TO SAVEPOINT a');
  await rechaza('automática que rechaza', INSERTAR, auto('rechazar', null), '23514');
  await rechaza('automática con persona', INSERTAR, auto('autorizar', 'prueba'), '23514');
  if (usuario === 'app_runtime') {
    await c.query('SAVEPOINT d');
    const del = await c.query(`DELETE FROM finance.order_authorizations WHERE id = $1`, [id]).then(() => 'borró', (e) => e.code);
    await c.query('ROLLBACK TO SAVEPOINT d');
    if (del === '42501') P('app_runtime no puede borrar la bitácora'); else F(`app_runtime borró o falló distinto: ${del}`);
  } else NM(`el DELETE de app_runtime (la sesión es ${usuario})`);

  // 9. `[GP.A.4b]` Lo que LEE la bandeja para no volver a pedir lo ya decidido, con el SQL del servicio.
  const srcBandeja = fs.readFileSync(SRC_BANDEJA, 'utf8');
  const VIGENTES = delServicio(srcBandeja, 'DECISIONES_VIGENTES_SQL');
  const HOY = delServicio(srcBandeja, 'AUTOMATICAS_HOY_SQL');
  const vig = (await c.query(VIGENTES, [['97', '97'], [1, 1], ['T-0000001', 'T-0000003'], tenant])).rows;
  const porFolio = Object.fromEntries(vig.map((x) => [x.folio, x.accion]));
  // T-0000001: autorizada y luego REGRESADA (paso 5) → la vigente es el regreso, que vuelve a esperar decisión.
  // T-0000003: rechazada → la vigente es el rechazo.
  if (vig.length === 2 && porFolio['T-0000001'] === 'regresar' && porFolio['T-0000003'] === 'rechazar') {
    P('la bandeja lee UNA decisión por pedido: la más nueva (el regreso gana a la autorización)');
  } else F(`decisiones vigentes: ${JSON.stringify(vig.map((x) => [x.folio, x.accion, x.estado]))}`);
  const fuera = (await c.query(VIGENTES, [['97'], [1], ['T-0000004'], tenant])).rows;
  if (fuera.length === 0) P('negativo: un pedido sin decisión no trae ninguna'); else F(`T-0000004 trajo ${fuera.length}`);
  const deOtroT = (await c.query(VIGENTES, [['97'], [1], ['T-0000001'], otro])).rows;
  if (deOtroT.length === 0) P('negativo: la decisión de otro tenant no se lee'); else F(`otro tenant leyó ${deOtroT.length}`);
  // El contador del tope del día: la automática del paso 6 se revirtió, así que hoy no hay ninguna escrita.
  const autoHoy = (await c.query(HOY, [tenant])).rows;
  const hoy97 = autoHoy.find((x) => x.sucursal === '97');
  if (!hoy97) P('negativo: el tope del día no cuenta automáticas que Kepler no aceptó ni las de otro día');
  else F(`el contador del día trajo ${hoy97.n} para la sucursal de prueba`);

  // 8. RLS
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [otro]);
  const deOtro = (await c.query(`SELECT count(*)::int n FROM finance.order_authorizations WHERE cliente_code = 'T-CLI-GPA2'`)).rows[0].n;
  if (usuario !== 'postgres') {
    if (deOtro === 0) P('con otro tenant no se ve nada'); else F(`otro tenant ve ${deOtro} fila(s)`);
  } else NM('RLS (la sesión es postgres: salta RLS)');
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
}

module.exports = { verificarBitacora, delServicio, TIPOS_PREVIOS };
