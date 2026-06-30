# Kepler — catálogo de tablas relevantes (análisis tabla por tabla)

> Complemento de [`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md) (que detalla inventario + write-back).
> Aquí: barrido **tabla por tabla** del schema `md` de Kepler para decidir **qué integrar**.
> Schema `md` ofuscado: tablas `kdXX`, columnas `c1, c2, c3…` sin nombres. Mapeo inferido **desde los datos**.

## Fuente y método

- **DB analizada:** sucursal `md_03` (8ESQ) en `192.168.40.40:5432`, user `postgres`/`kepler123` (read-only `platform_ro` en prod). PostgreSQL 16.4.
- **Total:** 330 tablas en schema `md`. Muestreo de filas + `pg_class.reltuples` + `doctype` como llave maestra.
- **Fecha del barrido:** 2026-06-30.

### Conteo por familia

| Familia | Tablas | Filas (aprox) | Qué es |
|---|---:|---:|---|
| `kdm*` (documentos) | 20 | 1.5M | Encabezados/líneas de ventas, compras, inventario, notas |
| `kdpv_*` (punto de venta) | 12 | 1.5M | Bitácora precios, márgenes, promos, proveedor-producto, caja |
| `kdi*` (inventario/items) | 19 | 580k | Maestro productos, existencia, costo, kardex |
| `kdmx*` (XML por año) | 3 | 455k | **Store de CFDI XML timbrado** (fiscal) |
| `kdfe*` (CFDI/SAT) | 119 | 433k | Plomería de timbrado fiscal (SAT) |
| `orglog*` (audit) | 3 | 312k | Log de operaciones por año |
| `kdu*` (usuarios/cuentas) | 12 | 146k | Cuentas, usuarios, cobranza |
| `kdlog*` | 1 | 15k | Log de sync/movimientos |
| `kdc22*` (corte caja) | 23 | 8k | Corte de caja diario (1 tabla por mes) |
| `kdpord*` (pedidos) | 5 | 5k | **Pedidos / embarques con estado** |
| `kdc*` (contabilidad) | 17 | 2k | Catálogo contable + saldos |
| `kdx*` | 8 | 2k | Auxiliares |
| otros | 88 | <1k | Catálogos chicos, config, RH |

### Leyenda de relevancia

- ✅ **Ya integrado** a la plataforma · 🟢 **Alto valor, integrar** · 🟡 **Medio / a futuro** · ⚪ **Bajo / ignorar**

---

## Llave maestra: `doctype` (taxonomía de documentos)

⚪ como dato, pero **crítico para interpretar todo `kdm*`/`kdij`**. 81 filas. Mapea cada tipo de documento.

Estructura del **código de documento** = `{genero}{naturaleza}{grupo}{tipo}` → folio (`k_doc7`):
- **género** (`k_gender`): `S`=ventas (folio `U…`) · `P`=compras (folio `X…`) · `N`=neutral/inventario (folio `N…`).
- **naturaleza** (`k_nature`): `D`=cargo/salida · `C`=abono/entrada.

Documentos clave (columna `k_doc7` = prefijo de folio):

| Doc | Descripción | Folio | Género/Nat |
|---|---|---|---|
| `Sale1` | Venta directa (crédito) | `UD0501` | S/D |
| `Sale2` | Venta de contado | `UD0502` | S/D |
| `Invoice1` | Factura remisión | `UD2001` | S/D |
| `Remiss1` | Remisión | `UD4501` | S/D |
| `Order1` | Pedido de venta | `UD4001` | S/D |
| `Rtrn1` | Devolución de venta | `UA2001` | S/C |
| `CrNote1`/`DbNote1` | Nota crédito / débito cliente | `UA3501`/`UD5501` | S |
| `Collect1` | Cobranza (cash collection) | `UA0501` | S/C |
| `Purchas1`/`Purchas2` | Compra crédito / contado | `XA0501`/`XA0507` | P/C |
| `PurOrdr1` | Orden de compra | `XA3501` | P/C |
| `EntryOr1` | Orden de entrada | `XA4001` | P/C |
| `InvIn1` | Entrada de inventario (sobrante) | `NA2002` | N/C |
| `InvOut1` | Salida de inventario (merma) | `ND0502` | N/D |
| `InvTrsf1` | **Traspaso entre sucursales** | `ND2501` | N/D |
| `PhysInv1` | Inventario físico | `ND3001` | N/D |
| `Payment1` | Pago a proveedor | `XD2501` | P/D |

> Las ventas = `genero='U'/'S'`, `naturaleza='D'`. Filtrar por estos en `kdm1`/`kdij` da la venta real.

---

## Dominio: Documentos (ventas / compras / movimientos) — `kdm*`, `kdij`, `kdue`

| Tabla | Filas | Rel. | Qué es | Columnas inferidas |
|---|---:|:--:|---|---|
| **`kdm1`** | 173k | ✅🟢 | **Encabezados de documento** (venta/compra/inv). 200 cols. | `c1`=sucursal · `c2`=género (U/X/N) · `c3`=naturaleza (D/C) · `c4`=grupo · `c5`=tipo · `c6`=folio · `c9`=fecha · `c10`=forma_pago/cliente |
| **`kdm2`** | 1.3M | ✅🟢 | **Líneas de documento**. 70 cols. La fuente de `mart.ventas`. | `c1..c5`=llave doc · `c6`=folio · `c7`=**nº de línea** (NO cantidad) · `c8`=SKU · `c9`=cantidad · `c12`=precio · `c13`=importe |
| **`kdij`** | 553k | 🟢 | **Kardex / movimiento de inventario por SKU con costo**. Cada movimiento (venta/compra/ajuste) por producto. | `c1`=sucursal · `c3`=SKU · `c4`=género · `c5`=naturaleza · `c6`=grupo · `c8`=folio · `c9`=cantidad · `c10`=fecha · `c12`=unidad · `c14`=precio · `c15`=forma_pago · `c22`=costo · `c23`=ruta |
| **`kdue`** | 143k | 🟡 | **Cabecera de cuenta / cobranza por cliente** (cuentas por cobrar). | `c1`=suc · `c2`=cliente / forma_pago · `c4`=grupo · `c6`=folio · `c7`=fecha · `c11`=total · `c13`=IVA · `c28`=género · `c29`=nat |
| `kdm_m2` | 10k | 🟡 | Líneas de **movimiento de inventario** (traspasos/ajustes/entradas). | `c1`=suc · `c2`=N · `c3`=A/D · `c4`=grupo · `c6`=folio · `c8`=SKU · `c9`=cantidad · `c13`=nombre |
| `kdm5` | 1.3k | ⚪ | Notas / abonos (docs U/A). | `c1..c6`=llave · `c12`/`c13`=importe |
| `kdm6` | 262 | ⚪ | Gastos / pólizas contables (X/A). | `c8`=cuenta · `c9`=concepto · `c11`=monto |
| `kdmx_26` / `kdmx_25` | 359k/96k | ⚪ | **Store de CFDI XML timbrado por año** (blob fiscal). No es dato comercial. | `c1..c6`=llave doc · `c8`=XML completo · `c9`=fecha |

---

## Dominio: Inventario / catálogo — `kdi*`

| Tabla | Filas | Rel. | Qué es | Columnas inferidas |
|---|---:|:--:|---|---|
| **`kdii`** | 9.3k | ✅ | Maestro de productos. | `c1`=SKU · `c2`=nombre · `c7`=barcode (EAN) · `c8`=clave familia |
| **`kdil`** | 7.8k | ✅ | Existencia por sucursal. | `c1`=suc · `c3`=SKU · **`c9`=existencia** · `c6`/`c7`=última compra/venta |
| **`kdik`** | 7.8k | ✅ | Valuación / costo. | `c1`=suc · `c2`=SKU · `c6`=existencia · `c9`=valor a costo → costo unit = `c9/c6` |
| `kdig`/`kdif`/`kdie`/`kdid` | <600 | ⚪ | Sub-catálogos de inventario (familias/unidades). Pendiente decodificar a detalle. | — |

---

## Dominio: Punto de venta — `kdpv_*`

| Tabla | Filas | Rel. | Qué es | Columnas inferidas |
|---|---:|:--:|---|---|
| **`kdpv_bitacora_precios`** | 1.4M | 🟢 | **Bitácora de cambios de precio** (auditoría histórica). | `c1`=fecha · `c2`=hora · `c3`=SKU · `c4`=unidad · `c5`=nombre · `c6`=precio_anterior · `c7`=precio_nuevo · `c8`=delta · `c9`=usuario |
| **`kdpv_prod_util`** | 42k | 🟢 | **Margen / utilidad por producto** y nivel de precio. | `c1`=SKU · `c2`=unidad · `c3`=nivel · `c6`=margen % |
| **`kdpv_prov_prod`** | 9.4k | 🟡 | **Proveedor → producto** con costo de compra. | `c1`=proveedor · `c2`=SKU · `c4`=costo · `c8`=? |
| **`kdpv_descuxq`** | 10k | 🟢 | **Promo: descuento por cantidad** (con vigencia, por sucursal). | `c1`=suc · `c2`=SKU · `c4`=nombre · `c5`=cantidad mín · `c6`=descuento · `c7`/`c8`=vigencia |
| `kdpv_descuxm` | 507 | 🟡 | Promo: descuento por monto. | análogo a `descuxq` |
| **`kdpv_gratisxq`** | 5 | 🟢 | **Promo: producto gratis por cantidad** (NxM / bonificación). | `c2`=SKU · `c5`=cantidad · `c6`=SKU gratis · `c7`/`c8`=vigencia · `c11`=cant gratis |
| `kdpv_gratisxm` | 1 | 🟡 | Promo: gratis por monto. | análogo |
| `kdpv_folio_caja` | 718 | 🟡 | Sesiones / folios de caja POS (cortes). 49 cols. | `c1..`=suc/caja/folio/fecha/montos |
| `kdpv_gerentes` | 2 | ⚪ | Gerentes autorizadores. | `c1`=código · `c2`=nombre |
| `kdpv_kdku` | 143 | ⚪ | Auxiliar POS. | — |

---

## Dominio: Logística / rutas — `kdm_rutas*`, `kdm_chofer`, `kdm_transporte`, `kdpord*`

| Tabla | Filas | Rel. | Qué es | Columnas inferidas |
|---|---:|:--:|---|---|
| **`kdm_rutas`** | 30 | 🟢 | **Maestro de rutas** (R1=YURECUARO, R2=RIVERA, R3=TANHUATO…). | `c1`=código ruta · `c2`=destino/zona |
| `kdm_rutas2` | — | 🟡 | Detalle ruta → destino/secuencia. | `c1`=ruta · `c2`=destino · `c4`=orden |
| **`kdm_chofer`** | 8 | 🟢 | **Choferes**. | `c1`=código · `c2`=nombre |
| **`kdm_transporte`** | 12 | 🟢 | **Flota** con placas y chofer asignado. | `c1`=código · `c2`=descripción · `c3`=placa · `c4`=chofer |
| `kdm_cat_sur` | 4 | 🟡 | Surtidores (pickers). | `c1`=código · `c2`=nombre |
| `kdm_cat_che` | 3 | 🟡 | Checadores. | `c1`=código · `c2`=nombre |
| `kdm_cat_emb` | 1 | 🟡 | Embarcadores. | `c1`=código · `c2`=nombre |
| **`kdpord`** | 5k | 🟢 | **Pedidos / embarques con estado** (picking → EMBARCADO). | `c1`=folio (`PD-…`) · `c3`=SKU · `c9`=cantidad · `c10`=unidad · `c19`=suc · `c22`=destino/ruta · `c24`=folio doc · `c35`=**estado** (EMBARCADO) |
| `kdpord2`/`3`/`4`/`8` | — | 🟡 | Detalle/anexos del pedido de embarque. | — |
| `kdm_transporte`/`kdm_chofer` ya arriba | | | | |

---

## Dominio: Caja / cobranza / contabilidad

| Tabla | Filas | Rel. | Qué es | Columnas inferidas |
|---|---:|:--:|---|---|
| `kdc226XX` / `kdc225XX` | ~8k | 🟡 | **Corte de caja diario** (1 tabla por mes; `2260X`=2026 mes X, `2251X`=2025). | `c2`=fecha · `c3`=código · `c5`=monto · `c6`=concepto · `c8`=D/C · `c17`=grupo · `c19`=folio |
| `kdc125` / `kdc126` | <300 | ⚪ | **Catálogo contable** (cuentas: 160-001 LICENCIAS…). NO son clientes. 100 cols. | `c1`=cuenta · `c2`=nombre |
| `kdcn24`/`25`/`26` | <1.2k | ⚪ | **Saldos contables** por cuenta. | `c2`=cuenta · `c7`=saldo |
| `kdco` | 344 | ⚪ | Auxiliar contable. | — |

---

## Dominio: Fiscal / CFDI — `kdfe*`, `kdmx_*` ⚪ (ignorar como dato comercial)

- **119 tablas `kdfe*`** = plomería del **timbrado CFDI 4.0 / SAT** (`kdfe33sat*` = catálogos SAT, `kdfe33m1`/`pagm*` = comprobantes/pagos, certificados, PACs). Sirven a la facturación electrónica, no a la inteligencia comercial.
- **`kdmx_25/26`** = store del XML timbrado por documento/año.
- **No integrar.** Si algún día se requiere la factura PDF/XML de un pedido, se busca por la llave `(suc,género,nat,grupo,tipo,folio)`.

---

## Dominio: Auditoría / sistema ⚪

| Tabla | Filas | Qué es |
|---|---:|---|
| `orglogtbl_24/25/26` | 312k | Log de operaciones del ERP por año |
| `kdlogmov` | 15k | Log de sync/movimientos (`c4`=script `.kpl`, `c6`=usuario) |

## Dominio: Usuarios / RH ⚪🟡

- `kduf`/`kdud`/`kdug`/`kdudp`/`kdudent`/`kduv`/`kduj`/`kduk` — cuentas, usuarios, permisos del ERP. 🟡 si se quiere atribuir ventas a vendedor/usuario.
- `kdrhcon`/`kdrhtpmv`/`kdrhmcr` — recursos humanos / nómina. ⚪ fuera de alcance.
- `orgbranch` (2) — sucursal lógica (B001 Main branch / W01 Main store). `orgcurrency` (2) — monedas.

---

## Resumen accionable: qué integrar

| Prioridad | Tablas | Para qué |
|---|---|---|
| ✅ Hecho | `kdii`, `kdil`, `kdik`, `kdm1`, `kdm2` | Catálogo, stock, costo, ventas (mart.ventas) |
| 🟢 Siguiente | `kdij` (kardex+costo), `kdpv_prod_util` (margen), `kdpv_bitacora_precios` (historial precio) | **KV.4 margen** + inteligencia de precio |
| 🟢 Siguiente | `kdpv_descuxq`, `kdpv_gratisxq`, `kdpv_descuxm` | **Promos reales del ERP** (señal Thot / portal) |
| 🟢 Logística | `kdpord` (embarques+estado), `kdm_rutas`, `kdm_chofer`, `kdm_transporte` | Pedidos/embarques + dims de ruta/flota |
| 🟡 A futuro | `kdue` (cobranza), `kdpv_prov_prod` (proveedores), `kdc226XX` (caja) | Cartera / sourcing / corte de caja |
| ⚪ Ignorar | `kdfe*` (119), `kdmx_*`, `orglog*`, `kdrh*`, contabilidad `kdc125/126/kdcn*` | Fiscal, audit, RH, contable |

> **Mapeo a plataforma:** `kdii.c1` == `public.products.sku` dentro del tenant Mega Dulces.
> El pipeline corre **on-prem** (Railway no alcanza la red MD) y empuja agregados a prod por bulk
> (ver [`RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md`](RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md)).
