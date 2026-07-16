# FE — Checklist de despliegue (poner la facturación en vivo)

> Runbook para llevar a PROD todo lo construido en la Fase FE (emisión/timbrado CFDI 4.0,
> contabilidad electrónica CodAgrupador, portal self-service). **Nada de esto corre en
> Railway todavía** — el código está compilado (builds verdes) pero los servicios tienen
> la versión anterior.
>
> Regla de oro: **arrancar en el ambiente de PRUEBAS de SW** (no timbra CFDI reales),
> validar el flujo end-to-end, y recién entonces flipear a PRODUCCIÓN.

---

## 0. Lo que necesito de vos (prerequisitos — sin esto no se puede)

- [ ] **CSF del emisor** (`LOGL851014AQ5`) en PDF o los 3 datos exactos: **razón social**, **régimen fiscal** (clave SAT), **CP** (lugar de expedición). → se cargan en Facturar → Emisor.
- [ ] **Credenciales SW de PRODUCCIÓN** (Conectia): `SW_TOKEN` infinito **o** `SW_USER`/`SW_PASSWORD`. El token que probamos es de **sandbox** y NO sirve en prod.
- [ ] **Confirmar que el CSD real de Mega Dulces está cargado en la cuenta SW de prod** (debería, porque Kepler ya timbra ahí). Si no, hay que subirlo (`/certificates/save type=stamp`).
- [ ] **Cadena de conexión de la DB prod** (para aplicar la migración `20260716160000`). La pegás cuando lleguemos al paso 2.
- [ ] *(Solo si además querés activar la descarga masiva FE.9)* La **e.firma (FIEL)** del contribuyente en la bóveda de prod. Independiente de la emisión.

---

## 1. Variables de entorno del API (Railway → servicio api)

Empezar en **PRUEBAS**:

| Variable | Valor (PRUEBAS) | Nota |
|---|---|---|
| `SW_BASE_URL` | `https://services.test.sw.com.mx` | endpoint de timbrado |
| `SW_TOKEN` | *(token sandbox)* | **o** usar `SW_USER`+`SW_PASSWORD` |
| `SW_PDF_BASE_URL` | *(opcional)* | si se omite, el adapter deriva `services.`→`api.` |
| `FISCAL_SAT_CLIENT` | *(omitir)* | default = `@nodecfdi` (FE.9); `reference` vuelve al impl viejo |

- [ ] Set en Railway (servicio api).
- [ ] `SW_TOKEN` y `SW_USER`/`SW_PASSWORD` son **específicos por ambiente** — no mezclar test/prod.

---

## 2. Aplicar la migración pendiente (FE.11)

Quedan **dos** migraciones de esta sesión sin aplicar. Las de FE.1 (`20260716120000`, Batch 124) y FE.5 (`20260716140000`, Batch 125) ya están en prod.

- [ ] `20260716160000_fe11_cod_agrupador.js` — crea `fiscal.cod_agrupador_map` (RLS) + permiso `FISCAL_CONTAB_GESTIONAR`.
- [ ] `20260716180000_fe10_cancel.js` — columnas `cancel_*` en `fiscal.cfdis` (motivo/sustitución/acuse/estatus). Aditiva.

```bash
NODE_ENV=production DATABASE_URL_NEW='<cadena-de-conexión-prod>' \
  npx knex migrate:latest --knexfile database/knexfile-newdb.js
```

- [ ] Verificar: `SELECT COUNT(*) FROM fiscal.cod_agrupador_map;` (0 filas, tabla creada) + el permiso backfilleado en `role_permissions`.

> ⚠️ Aplicar migraciones a prod requiere que **pegues la cadena de conexión** en el chat (gesto de autorización). No lo hago solo.

---

## 3. Redeploy de los 3 servicios

El código nuevo toca los 3 deployables:

- [ ] **api** — emisión, PAC SW, @nodecfdi, auto-factura, global, cod-agrupador, self-invoice.
- [ ] **view** (admin) — tab Facturar, datos fiscales del cliente, botón Facturar en el pedido, panel CodAgrupador.
- [ ] **portal** (B2B, servicio Railway aparte) — "Facturar mi pedido" + descarga PDF/XML.

> El redeploy de api es obligatorio (módulos nuevos). view/portal solo necesitan redeploy para servir el frontend nuevo (no llevan env de SW).

---

## 4. Re-login + configurar el emisor

- [ ] **Re-login** de tu usuario admin (para que el JWT traiga los permisos nuevos: `FISCAL_FACTURAR_*`, `FISCAL_CONTAB_GESTIONAR`).
- [ ] **Facturar → Emisor**: capturar RFC `LOGL851014AQ5` + razón social + régimen + CP **exactos de la CSF**. Guardar como default.

---

## 5. Smoke test en PRUEBAS (matriz)

Con SW en `services.test.sw.com.mx` — no se timbra nada real:

| # | Flujo | Dónde | Esperado |
|---|---|---|---|
| 1 | Cargar tab Facturar | view `/contabilidad/facturar` | lista vacía, sin 403 |
| 2 | Emitir **global** (público general) | Facturar → Emitir | UUID de prueba + aparece en la bandeja |
| 3 | Descargar **PDF** y **XML** | Facturar (fila) | archivos válidos |
| 4 | Capturar datos fiscales de un cliente | view `/comercial` → editar cliente | RFC/régimen/uso/CP guardan |
| 5 | Entregar un pedido de ese cliente | view pedido → Marcar entregado | auto-factura (chip CFDI) o botón **Facturar** |
| 6 | **Global del día** | Facturar → "Global del día" | 1 CFDI con los mostrador del día |
| 7 | **CodAgrupador**: auto-sugerir + descargar catálogo | `/contabilidad/contabilidad` | cobertura sube; XML con `CodAgrupador` mapeado |
| 8 | **Portal**: cliente factura su pedido | portal → pedido entregado → Solicitar factura | CFDI + descarga PDF |
| 9 | *(opcional)* Descarga masiva | view `/contabilidad` descarga | requiere FIEL en bóveda |

- [ ] 1–8 verdes en PRUEBAS.

---

## 6. Flip a PRODUCCIÓN

Recién cuando el smoke en pruebas pase:

- [ ] `SW_BASE_URL=https://services.sw.com.mx` + `SW_TOKEN` (o user/pass) de **producción**.
- [ ] Redeploy api (cambió env).
- [ ] Emitir **1 CFDI real de prueba** (un pedido chico o una global) → verificar UUID en el portal del SAT.
- [ ] *(Si algo sale mal)* cancelar ese CFDI (`POST /fiscal/facturas/:uuid/cancelar`).

---

## 7. Post-deploy (configuración de datos, sin bloquear)

- [ ] **CodAgrupador**: que el contador revise el mapeo auto-sugerido (`cod = cuenta mayor` es solo punto de partida) y corrija los que no correspondan al catálogo SAT.
- [ ] Activar el **cron de la global de mostrador** (hoy es manual a propósito) una vez confiando en la emisión.
- [ ] Capturar `regimen_fiscal`/`uso_cfdi`/CP de los clientes que facturan nominativa (o dejar que se auto-capture en el portal self-service).

---

## Anexo A — Rollback rápido

- **Timbrado descontrolado / error de datos del emisor** → borrar `SW_TOKEN` (el API sigue vivo, solo deja de timbrar: `tryAutoInvoice` es best-effort, el fulfill del pedido no se rompe).
- **Volver al cliente de descarga viejo** → `FISCAL_SAT_CLIENT=reference`.
- **La migración FE.11 no es destructiva**: su `down` solo dropea `fiscal.cod_agrupador_map` y quita el permiso.

## Anexo B — Deudas operacionales (no bloquean el deploy)

- [ ] Rotar los 3 passwords de Railway expuestos.
- [ ] Renovar la FIEL (~vence 2026-07-26) para la descarga masiva.
- [ ] FE.8 (REP automático) sigue **bloqueada** hasta que exista `PaymentsService`.

## Anexo C — Referencia de endpoints nuevos

- Emisión: `POST/GET /fiscal/facturas`, `GET :uuid/xml|pdf`, `POST :uuid/cancelar` · `PUT /fiscal/facturas/issuer`
- Global mostrador: `POST /commercial/orders/global-invoice`
- Auto/manual pedido: `POST /commercial/orders/:id/facturar`
- Portal self-service: `POST /commercial/orders/:id/self-invoice` · `GET :id/cfdi-xml|cfdi-pdf`
- CodAgrupador: `GET/POST suggest/PUT/DELETE /fiscal/contabilidad-electronica/cod-agrupador`
