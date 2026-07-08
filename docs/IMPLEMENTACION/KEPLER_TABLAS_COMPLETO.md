# Kepler — catálogo COMPLETO de tablas (las 329)

> **Inventario exhaustivo** de las 329 tablas del schema `md` del ERP Kepler (Mega Dulces).
> Complementa a [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md) (versión curada "qué integrar") y a [`ERP_KEPLER_SCHEMA.md`](ERP_KEPLER_SCHEMA.md) (inventario + write-back).
> Generado el 2026-07-02 desde la DB `md_03` (dump de la sucursal 8 Esquinas, restaurado en `localhost:5433`). Row counts = `COUNT(*)` exacto.

## Método y advertencias

- Schema `md` **ofuscado a propósito**: tablas `kdXX`, columnas `c1, c2, c3…` sin nombres. Los significados se **infirieron de los datos de muestra** (3 filas/tabla) — tratar como *mejor esfuerzo*, no como contrato.
- Algunas tablas de sistema sí traen nombres reales (`doctype`, `org*`, `web*`, `syshd*`, `crd*`, columnas `k_*`).
- `Filas` = conteo real al 2026-07-02 en la sucursal `md_03`. Otras sucursales (`md_00`..`md_05`) comparten el **mismo esquema**; los volúmenes varían. `0` = tabla vacía en esta sucursal (puede tener datos en otra).
- **Llave maestra `doctype`**: código `{género}{naturaleza}{grupo}{tipo}`; `k_gender` S=ventas(U…)/P=compras(X…)/N=inventario(N…), `k_nature` D=cargo/C=abono. Interpreta todo `kdm*`/`kdij`. **Venta real = `kdm1.c2='U' AND c3='D' AND c4=10`.**

## Relevancia

✅ Ya integrado a la plataforma · 🟢 Alto valor, integrar · 🟡 Medio / a futuro · ⚪ Bajo / ignorar (config, plomería fiscal, logs, RH, vacías)

Distribución: **✅ 7** · **🟢 16** · **🟡 51** · **⚪ 255**  (total 329 tablas, 5,012,677 filas)

## Resumen por dominio

| Dominio | Tablas | Filas |
|---|---:|---:|
| Fiscal / CFDI (SAT) | 121 | 917,088 |
| Sistema / configuración / auxiliares / logs | 44 | 300,366 |
| Contabilidad / corte de caja / conceptos y cuentas | 34 | 10,795 |
| Documentos: ventas / compras / movimientos | 29 | 2,372,070 |
| Punto de venta / precios / promociones | 19 | 1,379,153 |
| Pedidos / compras / embarques | 19 | 5,009 |
| CRM / clientes / catálogos de venta | 19 | 23 |
| Inventario / catálogo de productos | 18 | 25,539 |
| Recursos humanos / nómina | 15 | 166 |
| Usuarios / cuentas de acceso | 11 | 2,468 |
| **TOTAL** | **329** | **5,012,677** |

---

### Documentos: ventas / compras / movimientos de inventario
Núcleo transaccional del ERP: encabezados y líneas de todos los documentos (ventas, compras, traspasos, inventario físico), kardex por SKU, CxC y pólizas contables. Las tablas auxiliares `kdm_*` registran catálogos operativos de logística y personal.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdij` | 761,171 | 41 | ✅ | Kardex por SKU: cada movimiento de entrada/salida de inventario | `c1`=sucursal · `c3`=SKU · `c4`=género (U/X/N) · `c5`=naturaleza (D/C) · `c8`=folio · `c9`=cantidad · `c10`=fecha · `c22`=costo · `c23`=ruta |
| `kdlogmov` | 16,877 | 9 | ⚪ | Log de sincronización/operaciones internas del ERP | `c1`=empresa · `c2`=fecha · `c3`=hora · `c4`=script ejecutado · `c6`=usuario/valor · `c8`=tabla afectada |
| `kdm_cat_che` | 3 | 2 | 🟡 | Catálogo de chequeadores (personal de verificación) | `c1`=id · `c2`=nombre |
| `kdm_cat_emb` | 1 | 2 | 🟡 | Catálogo de embarcadores | `c1`=id · `c2`=nombre |
| `kdm_cat_sur` | 4 | 2 | 🟡 | Catálogo de surtidores (personal de surtido) | `c1`=id · `c2`=nombre |
| `kdm_chofer` | 8 | 2 | 🟢 | Catálogo de choferes de reparto | `c1`=id · `c2`=nombre completo |
| `kdm_m2` | 7,179 | 35 | 🟡 | Líneas de pedidos/traspasos neutros (género N) con descripción de producto | `c1`=sucursal · `c2`=género · `c3`=naturaleza · `c4`=grupo · `c6`=folio · `c7`=nº línea · `c8`=SKU · `c9`=cantidad · `c10`=unidad · `c13`=descripción |
| `kdm_rutas` | 52 | 2 | 🟢 | Catálogo de rutas de distribución | `c1`=clave ruta (R1…) · `c2`=nombre destino/municipio |
| `kdm_rutas2` | 3 | 4 | 🟡 | Asignación de clientes/tiendas a rutas con orden de visita | `c1`=ruta · `c2`=cliente · `c3`=activo · `c4`=orden |
| `kdm_sucursales` | 0 | 7 | ⚪ | Config sucursales (sin datos en muestra) | — |
| `kdm_transporte` | 12 | 4 | 🟢 | Flota de vehículos de reparto | `c1`=id unidad · `c2`=descripción · `c3`=placa · `c4`=chofer_id |
| `kdm_ubi_suc_prod` | 0 | 4 | ⚪ | Ubicación producto×sucursal (sin datos) | — |
| `kdm_unico` | 1 | 23 | ⚪ | Config/control único de empresa (montos numéricos globales, opaco) | `c1`=tipo ('UNICO') · `c2`=folio · `c11..c20`=acumulados numéricos |
| `kdm1` | 162,782 | 200 | ✅ | Encabezados de todos los documentos (ventas, compras, traspasos, inventario) | `c1`=sucursal · `c2`=género (U/X/N) · `c3`=naturaleza (D/C) · `c4`=grupo · `c5`=tipo · `c6`=folio · `c9`=fecha · `c10`=cliente\|forma_pago · `c14`=subtotal · `c16`=total · `c63`=prefijo_folio (ej. UD1003-) |
| `kdm2` | 1,267,372 | 70 | ✅ | Líneas de documentos (ítems por folio): fuente de mart.ventas | `c1..c6`=llave doc · `c7`=nº línea · `c8`=SKU · `c9`=cantidad · `c10`=descripción · `c11`=unidad · `c12`=precio · `c13`=importe · `c62`=costo · `c65`=precio_venta |
| `kdm3` | 0 | 27 | ⚪ | Tabla auxiliar de documentos (sin datos, estructura similar a kdm2) | — |
| `kdm4` | 0 | 9 | ⚪ | Tabla auxiliar de documentos (sin datos) | — |
| `kdm5` | 1,508 | 14 | 🟡 | Aplicaciones/cruce de documentos (CxC: cargo aplicado a abono) | `c1`=suc · `c2`=género · `c3`=naturaleza · `c4`=grupo · `c6`=folio origen · `c8`=sentido (D/A) · `c11`=folio destino · `c12`=monto · `c13`=total |
| `kdm6` | 447 | 18 | 🟡 | Pólizas contables/gastos por documento | `c1`=suc · `c8`=cuenta contable · `c9`=concepto (GASTOS GENERALES/OPERATIVOS) · `c10`=signo (C/D) · `c11`=monto · `c13`=referencia |
| `kdm7` | 0 | 9 | ⚪ | Tabla auxiliar de documentos (sin datos) | — |
| `kdm8` | 0 | 11 | ⚪ | Tabla auxiliar de documentos (sin datos) | — |
| `kdm9` | 0 | 14 | ⚪ | Tabla auxiliar de documentos (sin datos) | — |
| `kdmensajes` | 0 | 12 | ⚪ | Mensajes internos del ERP (sin datos) | — |
| `kdmm` | 170 | 61 | 🟡 | Tipos de movimiento/documento configurados en el ERP con cuentas contables asociadas | `c1`=género · `c2`=naturaleza · `c3`=grupo · `c5`=descripción (Entrada Traspaso sucursal / Solic Pago…) · `c17`=clave KPL · `c19`=cuenta_debe · `c20`=cuenta_haber |
| `kdms` | 1 | 12 | ⚪ | Config de sucursal local (nombre, dirección, código postal) | `c1`=id_suc · `c2`=nombre · `c4`=dirección · `c9`=CP |
| `kdmt` | 0 | 20 | ⚪ | Tabla auxiliar de documentos (sin datos, posiblemente traspasos) | — |
| `kdmy` | 2 | 8 | 🟡 | Catálogo de monedas (PESOS y DLLS con cuentas contables) | `c1`=clave · `c2`=nombre · `c3`=símbolo · `c4..c5`=cuentas contables · `c8`=referencia SAT |
| `kdmz` | 2 | 4 | 🟡 | Tipos de cambio vigentes por moneda | `c1`=moneda · `c2`=fecha vigencia · `c4`=tasa (DLLS=20) |
| `kdue` | 154,475 | 31 | ✅ | Cuentas por cobrar: cabecera de cargo/abono por cliente | `c1`=suc · `c2`=cliente\|forma_pago · `c3`=naturaleza · `c6`=folio · `c7`=fecha · `c11`=total · `c13`=IVA · `c28`=género (U) · `c29`=tipo (C) |

---

### Inventario / catálogo de productos
Tablas que definen el maestro de artículos, existencias por sucursal, valuación a costo, y los sub-catálogos de clasificación (unidad, departamento, línea, proveedor). Son la fuente primaria para sync con `commercial.*`.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdib` | 0 | 4 | ⚪ | config/auxiliar (sin datos) | — |
| `kdid` | 12 | 2 | 🟡 | Catálogo de unidades de medida | `c1`=clave (CJA/KG/PAQ/PZA) · `c2`=nombre |
| `kdie` | 12 | 5 | 🟡 | Catálogo de departamentos/giros | `c1`=clave · `c2`=nombre (BOTANAS/BEBIDAS/DESECHABLES) · `c4`,`c5`=numéricos auxiliares |
| `kdif` | 230 | 4 | 🟡 | Catálogo de líneas de producto | `c1`=clave · `c2`=nombre línea (CHOCOLATE CONFITADO/SUAVIZANTES) · `c4`=numérico auxiliar |
| `kdig` | 542 | 4 | 🟡 | Catálogo de proveedores | `c1`=clave · `c2`=nombre proveedor · `c4`=numérico auxiliar |
| `kdii` | 9,249 | 103 | ✅ | Maestro de productos (SKU, nombre, barcode, familia, foto, **umbrales de reorden**) | `c1`=SKU · `c2`=nombre · `c7`=barcode EAN · `c8`=familia/depto · `c11`=unidad contenedor · **`c33`=mínimo · `c34`=punto de reorden · `c35`=máximo** (unidades; verificado 2026-07-08 contra el form Kepler `invcatprdpag.kpl` — `set("invMin","a33")`/`("PR","a34")`/`("invMax","a35")` — y contra datos: ratio 1:1.5:2, valores >> precio del SKU. **NO son precios**; los precios viven en `md.kdpv_prod_util`) · `c70`=ruta imagen · `c77`=costo unit · `c78`=costo caja · `c80`=unidad caja · `c81`=piezas×caja · `c82`=código interno · `c83`=unidad pieza · `c87`/`c88`=márgenes% |
| `kdiicte` | 0 | 7 | ⚪ | config/auxiliar (sin datos) | — |
| `kdik` | 7,745 | 109 | ✅ | Valuación y costo por sucursal×SKU (existencia agregada de todos los almacenes) | `c1`=sucursal · `c2`=SKU · `c4`=**existencia inicial** · `c5`=**entradas** · `c6`=**salidas** · `c9`=valor a costo · `c13`/`c14`/`c15`=fechas último mov · `c16`=**costo unitario** · `c34`=ventas mes actual · `c43`/`c44`/`c45`=ventas valor mes-1/2/3 · `c55`/`c56`/`c57`=ventas unidades periodos · **Existencia = c4 + c5 − c6** |
| `kdil` | 7,745 | 9 | ✅ | Existencia por sucursal×almacén×SKU | `c1`=sucursal · `c2`=almacén · `c3`=SKU · `c4`=**existencia inicial** · `c8`=**entradas** · `c9`=**salidas** · `c5`/`c6`/`c7`=fechas (alta/última entrada/última salida) · **Existencia = c4 + c8 − c9** |

> ⚠️ **kdil/kdik — cómo calcular existencia** (verificado 2026-07-03 contra el código fuente de Kepler `invrepexsrep.kpl`, reporte "Existencia por productos"):
> - Por **almacén**: `kdil.c4 + kdil.c8 − kdil.c9` (inicial + entradas − salidas). El doc anterior decía "c9 = existencia actual" — **incorrecto**: `c9` son las **salidas**.
> - Por **sucursal** (todos los almacenes): `kdik.c4 + kdik.c5 − kdik.c6`.
> - **NO usar `c9` (kdil) ni `c6` (kdik) solos** — son salidas, no existencia. (Ése era el bug de la vista `dic.stock`.)
> - **Caveat físicos:** `c4` (inicial) llega en **0** para todos los productos en el branch. Para productos con inventario físico previo (más salidas que entradas en el periodo), la fórmula da **negativo** — la existencia real la recalcula el reporte de Kepler desde el conteo físico. Para esos (~2–10% por sucursal) `kdil`/`kdik` no bastan; usar el CSV export del reporte de Kepler. Detalle en `project_existencia_feed_kepler_bug`.
| `kdilo` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdip` | 1 | 7 | ⚪ | Config pedimento aduanal (compras nacionales) | `c1`=clave (NOPEDIMENTO) · `c2`=descripción · `c3`=país · `c4`=fecha |
| `kdiq` | 2 | 4 | 🟡 | Almacenes internos por sucursal | `c1`=sucursal · `c2`=nº almacén · `c3`=nombre (ALMACÉN/SUCURSAL PADRE HIDALGO) |
| `kdis` | 0 | 25 | ⚪ | config/auxiliar (sin datos) | — |
| `kdis2` | 0 | 16 | ⚪ | config/auxiliar (sin datos) | — |
| `kdis7` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdis8` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdis9` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdiu` | 1 | 8 | ⚪ | Config agencia aduanal (importaciones) | `c1`=clave · `c2`=nombre agencia |

---

### Punto de venta / precios / promociones / caja POS
Tablas del módulo POS que controlan precios por unidad/volumen, promociones con vigencia, cortes de caja por cajero, y la bitácora de cambios de precio. Son las fuentes primarias para márgenes y política comercial en sucursal.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdpv_bitacora_precios` | 1,315,833 | 9 | 🟢 | Historial de cambios de precio por SKU/unidad | `c1`=fecha · `c2`=hora · `c3`=SKU · `c4`=unidad (CJA/PAQ) · `c5`=nombre producto · `c6`=precio anterior · `c7`=precio nuevo · `c8`=delta |
| `kdpv_descuxm` | 507 | 12 | 🟡 | Descuentos por monto mínimo de compra con vigencia | `c1`=suc · `c2`=SKU · `c3`=unidad · `c4`=nombre · `c5`/`c6`=desc/precio · `c7`/`c8`=vigencia_desde/hasta · `c9`/`c10`=montos mín/máx |
| `kdpv_descuxq` | 10,012 | 12 | 🟢 | Descuentos por cantidad con vigencia (promos por volumen) | `c1`=suc · `c2`=SKU · `c3`=unidad · `c4`=nombre · `c5`=qty_min · `c6`=precio_promo · `c7`/`c8`=vigencia_desde/hasta · `c9`/`c10`=montos |
| `kdpv_folio_caja` | 661 | 49 | 🟢 | **Corte/arqueo de caja POS** por cajero y turno (base del Plano 2 del supervisor de cuadre) | `c1`=suc · `c2`=caja · `c3`=folio · `c4`=tipo/seq · `c5`/`c10`=fecha_apertura/cierre · `c6`/`c11`=hora_apertura/cierre · `c7`=cajero_apertura · `c8`=cajero_cierre · `c12`=usuario_cierre · `c13`=turno · **`c15`=efectivo ESPERADO** · **`c25`=efectivo CONTADO (arqueo)** · **`c35`=DIFERENCIA (=c15−c25, faltante+/sobrante−)** · `c16`/`c26`=tarjeta esperado/contado · `c17`/`c27`=transferencia esp/cont · `c36`-`c40`=diffs otras formas · `c46`-`c48`=límites efectivo permitido · `c49`=total venta. **Corte abierto**: c10=`1800-01-01`, montos en 0 → filtrar `c25<>0`. Verificado en vivo 2026-07-07 (md_01/02/03) |
| `kdpv_gerentes` | 2 | 3 | 🟡 | Catálogo de gerentes/supervisores POS por sucursal | `c1`=suc · `c2`=clave_usuario · `c3`=nombre_completo |
| `kdpv_gratisxm` | 1 | 15 | 🟡 | Promociones "N lleva M gratis" por monto mínimo | `c1`=suc · `c2`=SKU_compra · `c3`=unidad · `c4`=nombre · `c5`=qty_trigger · `c6`=SKU_gratis · `c7`/`c8`=vigencia · `c9`/`c10`=qty_min/max · `c11`=qty_gratis · `c12`=unidad_gratis · `c14`=barcode |
| `kdpv_gratisxq` | 5 | 15 | 🟢 | Promociones "compra N lleva M gratis" con vigencia | `c1`=suc · `c2`=SKU_compra · `c3`=unidad · `c4`=nombre · `c5`=qty_trigger · `c6`=SKU_gratis · `c7`/`c8`=vigencia_desde/hasta · `c9`/`c10`=qty_min/max · `c11`=qty_gratis · `c12`=unidad_gratis · `c14`=barcode |
| `kdpv_kdku` | 142 | 5 | 🟡 | Catálogo de cajeros/usuarios POS con PIN | `c1`=clave_usuario · `c2`=nombre_completo · `c3`=PIN · `c4`=status |
| `kdpv_prod_promo` | 0 | 8 | ⚪ | config/auxiliar (sin datos) | — |
| `kdpv_prod_util` | 42,158 | 7 | 🟢 | Margen/utilidad por SKU y rango de cantidad | `c1`=SKU · `c2`=unidad · `c3`=nivel_precio · `c4`=qty_desde · `c5`=qty_hasta · `c6`=margen% · `c7`=utilidad |
| `kdpv_prov_prod` | 9,505 | 10 | 🟢 | Proveedor→producto con costo y condiciones | `c1`=proveedor · `c2`=SKU · `c3`=clave_interna · `c4`=costo · `c5`..`c7`=desc/bonif/otros · `c8`=flete · `c9`=costo_neto · `c10`=extra |
| `kdpv_unico` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `pos95caja` | 0 | 3 | ⚪ | Catálogo de cajas POS (sin datos en md_03) | — |
| `pos95cajamn` | 0 | 5 | ⚪ | Config moneda por caja POS (sin datos en md_03) | — |
| `pos95cajero` | 0 | 5 | ⚪ | Catálogo de cajeros POS (sin datos en md_03) | — |
| `pos95historico` | 0 | 11 | ⚪ | Histórico movimientos de caja POS (sin datos en md_03) | — |
| `pos95opeparamdoc` | 1 | 6 | 🟡 | Config tipo de documento POS (género/naturaleza/grupo/tipo) | `k_sucursal`=TODAS · `k_genero`=U · `k_naturaleza`=D · `k_grupo`=10 · `k_tipo`=1 (confirma patrón venta real) |
| `pv_suc_ip` | 7 | 10 | 🟡 | Directorio de sucursales con IP/hostname y DNS dinámico | `c1`=código_suc · `c2`=nombre · `c3`=hostname_ddns · `c4`=puerto · `c5`=flag_activa · `c7`=clave_TI |
| `sqliov` | 319 | 4 | 🟡 | Registro de folios/documentos sincronizados entre sucursales | `c1`=folio_doc (ej. KFUD1003.02) · `c2`/`c3`=flags sync · `c4`=contador |

---

### Pedidos / compras / embarques
Cubre el ciclo de pedidos de reparto (`kdpord*`), parámetros y documentos de órdenes de compra (`kdpc*`, `kdpd`, `kdpf`, `kdpi`, `kdpm`, `kdpo`, `kdpq`, `kdpu3`) y una tabla auxiliar de horarios/turnos (`kdpa`).

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdpa` | 3 | 43 | 🟡 | Horarios o turnos de reparto (horas inicio/fin por día) | `c4`=día semana · `c12`=hora inicio ("8:00") · `c13`=hora fin ("15:45") · `c14`=duración (0.25h) |
| `kdpc` | 0 | 21 | ⚪ | Parámetros de compra (config/auxiliar, sin datos) | — |
| `kdpc2` | 0 | 5 | ⚪ | Parámetro compra variante 2 (config/auxiliar, sin datos) | — |
| `kdpc3` | 0 | 5 | ⚪ | Parámetro compra variante 3 (config/auxiliar, sin datos) | — |
| `kdpc4` | 0 | 5 | ⚪ | Parámetro compra variante 4 (config/auxiliar, sin datos) | — |
| `kdpc5` | 0 | 5 | ⚪ | Parámetro compra variante 5 (config/auxiliar, sin datos) | — |
| `kdpcte` | 0 | 5 | ⚪ | Parámetro compra / proveedor/cliente (config/auxiliar, sin datos) | — |
| `kdpd` | 0 | 61 | ⚪ | Documento de compra masivo (61 cols float, sin datos) | — |
| `kdpf` | 0 | 4 | ⚪ | Documento/folio de compra (config/auxiliar, sin datos) | — |
| `kdpi` | 0 | 5 | ⚪ | Anexo de compra i (config/auxiliar, sin datos) | — |
| `kdpm` | 0 | 8 | ⚪ | Anexo de compra m (config/auxiliar, sin datos) | — |
| `kdpo` | 0 | 5 | ⚪ | Anexo de compra o (config/auxiliar, sin datos) | — |
| `kdpord` | 5,006 | 35 | 🟢 | Pedidos de reparto con líneas y estado de embarque | `c1`=folio PD- · `c3`=SKU · `c4`=cantidad · `c6`=fecha · `c10`=unidad · `c19`=sucursal · `c20`=género (U=venta) · `c21`=nat (D=cargo) · `c22`=ruta · `c24`=folio destino · `c35`=estado ("EMBARCADO") |
| `kdpord2` | 0 | 25 | ⚪ | Extensión pedido variante 2 (sin datos) | — |
| `kdpord3` | 0 | 25 | ⚪ | Extensión pedido variante 3 (sin datos) | — |
| `kdpord4` | 0 | 8 | ⚪ | Extensión pedido variante 4 (sin datos) | — |
| `kdpord8` | 0 | 11 | ⚪ | Extensión pedido variante 8 (sin datos) | — |
| `kdpq` | 0 | 7 | ⚪ | Documento/anexo de compra q (config/auxiliar, sin datos) | — |
| `kdpu3` | 0 | 17 | ⚪ | Documento/anexo de pedido u3 (config/auxiliar, sin datos) | — |

---

### Contabilidad / corte de caja / conceptos y cuentas
Agrupa el plan de cuentas contables, las pólizas de gastos mensuales por sucursal y los saldos de cuentas por año. Las tablas `kdc225XX`/`kdc226XX` son particionadas por mes (1 tabla/mes, sufijo = mes 01-12).

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdc125` | 205 | 100 | 🟡 | Catálogo de Cuentas contables 2025 con saldos mensuales | `c1`=cuenta · `c2`=nombre (LICENCIAS SOFTWARE/ANTICIPO A PROVEEDORES) · `c4`=flag · `c14..c86`=saldos numéricos por mes/concepto |
| `kdc126` | 263 | 100 | 🟡 | Catálogo de Cuentas contables 2026 con saldos mensuales | `c1`=cuenta · `c2`=nombre (ESTIMACION CUENTAS INCOBRABLES/DOCUMENTOS POR COBRAR) · `c4`=flag · `c14..c86`=saldos por mes |
| `kdc20012` | 0 | 50 | ⚪ | config/auxiliar (sin datos) | — |
| `kdc225` | 0 | 50 | ⚪ | Corte de caja diario 2025 — tabla raíz vacía (encabezado de partición) | — |
| `kdc22501` | 228 | 50 | 🟡 | Corte de caja diario 2025 enero — pólizas de gastos por cuenta | `c2`=fecha · `c3`=cuenta (603-001/602-003) · `c4`=tipo (C/A) · `c5`=monto · `c6`=descripción (JOSE SOTELO/TELMEX/GASOLINA MOTO) · `c8`=naturaleza (D) · `c10`=línea · `c13`=folio póliza · `c20`=clave concepto |
| `kdc22502` | 36 | 50 | 🟡 | Corte de caja diario 2025 febrero — pólizas de gastos por cuenta | `c2`=fecha · `c3`=cuenta · `c5`=monto · `c6`=descripción (NOMINA/RUTA PAULINA/GASOLINA) · `c13`=folio póliza |
| `kdc22503` | 37 | 50 | 🟡 | Corte de caja diario 2025 marzo — pólizas de gastos por cuenta | `c2`=fecha · `c3`=cuenta · `c5`=monto · `c6`=descripción (RECARGA/INVENTARIO/BASURA) · `c13`=folio póliza |
| `kdc22504` | 0 | 50 | ⚪ | Corte de caja diario 2025 abril — sin datos | — |
| `kdc22505` | 0 | 50 | ⚪ | Corte de caja diario 2025 mayo — sin datos | — |
| `kdc22506` | 0 | 50 | ⚪ | Corte de caja diario 2025 junio — sin datos | — |
| `kdc22507` | 0 | 50 | ⚪ | Corte de caja diario 2025 julio — sin datos | — |
| `kdc22508` | 0 | 50 | ⚪ | Corte de caja diario 2025 agosto — sin datos | — |
| `kdc22509` | 0 | 50 | ⚪ | Corte de caja diario 2025 septiembre — sin datos | — |
| `kdc22510` | 0 | 50 | ⚪ | Corte de caja diario 2025 octubre — sin datos | — |
| `kdc22511` | 0 | 50 | ⚪ | Corte de caja diario 2025 noviembre — sin datos | — |
| `kdc22512` | 287 | 50 | 🟡 | Corte de caja diario 2025 diciembre — pólizas con origen inventario/traspasos | `c2`=fecha · `c3`=cuenta (517-002/114) · `c4`=tipo · `c5`=monto · `c6`=descripción (Salida de almacén ND51/SUCURSAL PADRE HIDALGO) · `c15`=género doc (N/X/U) · `c16`=naturaleza · `c19`=folio |
| `kdc226` | 0 | 50 | ⚪ | Corte de caja diario 2026 — tabla raíz vacía (encabezado de partición) | — |
| `kdc22601` | 2,986 | 50 | 🟡 | Corte de caja diario 2026 enero — pólizas de compras y ventas | `c2`=fecha · `c3`=cuenta (201/511/115) · `c4`=tipo (A/C) · `c5`=monto · `c6`=descripción (CUERITOS LUPITA/AGRICOLA MAAS/CONTADO) · `c15`=género (X/U) · `c17`=grupo · `c19`=folio |
| `kdc22602` | 1,038 | 50 | 🟡 | Corte de caja diario 2026 febrero — pólizas de ventas contado | `c2`=fecha · `c3`=cuenta · `c5`=monto · `c6`=descripción (CONTADO) · `c15`=género (U=venta) · `c19`=folio |
| `kdc22603` | 884 | 50 | 🟡 | Corte de caja diario 2026 marzo — pólizas compras y gastos | `c2`=fecha · `c3`=cuenta · `c5`=monto · `c6`=descripción (PAPAS JOAQUIN) · `c7`=referencia (0116) · `c19`=folio |
| `kdc22604` | 1,632 | 50 | 🟡 | Corte de caja diario 2026 abril — pólizas con traspasos entre sucursales | `c2`=fecha · `c3`=cuenta · `c5`=monto · `c6`=descripción (SUCURSAL ZAMORA CANINDO) · `c7`=referencia folio (40-2844) · `c19`=folio |
| `kdc22605` | 947 | 50 | 🟡 | Corte de caja diario 2026 mayo — pólizas compras sucursales | `c2`=fecha · `c3`=cuenta · `c5`=monto · `c6`=descripción (SUCURSAL MORELIA ABASTOS/CEDIS) · `c19`=folio |
| `kdc22606` | 390 | 50 | 🟡 | Corte de caja diario 2026 junio — pólizas ventas contado | `c2`=fecha · `c3`=cuenta (115/205-001/403) · `c4`=tipo · `c5`=monto · `c6`=descripción (CONTADO) · `c19`=folio |
| `kdc22610` | 0 | 50 | ⚪ | Corte de caja diario 2026 octubre — sin datos | — |
| `kdc22611` | 0 | 50 | ⚪ | Corte de caja diario 2026 noviembre — sin datos | — |
| `kdc22612` | 4 | 50 | ⚪ | Corte de caja diario 2026 diciembre — sin datos | — |
| `kdc3` | 16 | 15 | ⚪ | config/auxiliar (sin datos / opaca) | — |
| `kdcecfdpol` | 0 | 10 | ⚪ | config/auxiliar (sin datos / opaca) — posible vínculo CFDI-póliza | — |
| `kdcn24` | 16 | 8 | ⚪ | Saldos contables por cuenta 2024 — sin datos visibles | — |
| `kdcn25` | 1,133 | 8 | ⚪ | Saldos contables por cuenta 2025 — sin datos visibles | — |
| `kdcn26` | 288 | 8 | ⚪ | Saldos contables por cuenta 2026 — sin datos visibles | — |
| `kdco` | 351 | 3 | 🟡 | Catálogo de Conceptos contables — clave, descripción y número de cuenta | `c1`=clave · `c2`=descripción (NOMINA BANCOS/GASOLINA) · `c3`=número de cuenta (601-001) |
| `kdcp` | 54 | 31 | ⚪ | config/auxiliar (sin datos / opaca) | — |
| `kdctesacum` | 0 | 4 | ⚪ | Acumulados de tesorería — sin datos visibles | — |

---

### CRM / clientes / catálogos de venta
Módulo CRM de Kepler (prefijo `kdcrm*`) y catálogos auxiliares de venta (prefijo `kdv*`): parámetros de seguimiento a clientes, medios de contacto, segmentación por tamaño, colonias/CP, cajas POS y títulos de cortesía.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdcrmcatcomen` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdcrmcatcompe` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `kdcrmcomen` | 0 | 5 | ⚪ | config/auxiliar (sin datos) | — |
| `kdcrmdoctos` | 0 | 5 | ⚪ | config/auxiliar (sin datos) | — |
| `kdcrmparam` | 1 | 3 | ⚪ | Parámetro de config CRM (una sola fila) | `c2`=clave (SEGURIDAD) · `c3`=valor (A) |
| `kdvalrfc40` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvcaucierr` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvcolonia` | 1 | 5 | 🟡 | Catálogo de colonias con CP y estado | `c1`=país (MEX) · `c2`=estado (MICH) · `c3`=clave localidad (LAP) · `c4`=colonia (SANTA FE) · `c5`=CP (59330) |
| `kdvcontactos` | 0 | 68 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvdoctos` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvmedios` | 1 | 7 | 🟡 | Catálogo de medios de contacto con vigencia | `c1`=código (001) · `c2`=nombre (WHATS APP) · `c3`=fecha_inicio · `c4`=fecha_fin · `c7`=tipo_medio (ELECT) |
| `kdvpresxven` | 0 | 16 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvsegmtoava` | 0 | 6 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvtacaj80` | 5 | 11 | 🟡 | Registro de cajas POS por sucursal con estado | `c1`=sucursal · `c2`=nº caja · `c3`=nombre caja · `c4`..`c7`=montos (0.00) · `c8`=género (N) · `c9`=naturaleza (D) |
| `kdvtamano` | 4 | 14 | 🟡 | Segmentación de clientes por tamaño de empresa | `c1`=código · `c2`=nombre (MICRO EMPRESA/PEQUEÑA/MEDIANA) · `c3`..`c8`=rangos empleados/ventas · `c9`..`c14`=rangos de monto por dimensión |
| `kdvtipocontacto` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdvtipomedio` | 4 | 2 | 🟡 | Catálogo de tipos de medio de contacto | `c1`=clave (ELECT/IMPRESO/RADIO) · `c2`=descripción (MEDIO ELECTRONICO/IMPRESO/RADIOFONICO) |
| `kdvtitulos` | 7 | 2 | 🟡 | Catálogo de títulos de cortesía para contactos | `c1`=abreviatura (ARQ/CP/DR) · `c2`=descripción (ARQUITECTO/CONTADOR/DOCTOR) |
| `kdvzip` | 0 | 7 | ⚪ | config/auxiliar (sin datos) | — |

---

### Usuarios / cuentas de acceso / permisos
Dominio `kdu*`: clientes comerciales del ERP (deudores, cuentas, rutas, zonas) y vendedores. No son usuarios de sistema operativo sino entidades del negocio: compradores, cuentas por cobrar y la fuerza de ventas.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kducliact` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `kdud` | 639 | 30 | 🟢 | Maestro de clientes con dirección y RFC | `c2`=código cliente · `c3`=nombre/razón social · `c4`=calle · `c5`=colonia · `c6`=ciudad · `c10`=RFC |
| `kdudent` | 158 | 13 | 🟡 | Puntos de entrega o entidades por cliente | `c1`=id · `c3`=nombre punto · `c5`=ciudad · `c8`=contacto · `c13`=clave sucursal destino |
| `kdudp` | 2 | 110 | 🟡 | Perfiles/plantillas de cliente o ruta (pocos registros) | `c2`=código · `c3`=nombre (cliente o ruta) · `c35`=estado (MICH) · `c82`=estatus (A=activo) · `c81`=fecha alta |
| `kduf` | 1,258 | 18 | 🟢 | Cuentas de crédito / documentos pendientes CxC por cliente | `c1`=suc · `c2`=código cliente · `c3`=fecha · `c4`=tipo · `c6`=folio · `c9`=folio correlativo · `c10`=monto · `c11`=monto aplicado |
| `kdug` | 367 | 58 | 🟢 | Estado de cuenta / saldos aging por cliente en moneda | `c1`=moneda (PESOS) · `c2`=suc · `c3`=cliente · `c4`/`c6`/`c7`=fechas · `c11`..`c58`=saldos por antigüedad |
| `kduj` | 19 | 3 | 🟢 | Catálogo de rutas de venta con clave contable | `c1`=código ruta · `c2`=nombre ruta · `c3`=clave contable |
| `kduk` | 4 | 2 | 🟢 | Catálogo de zonas de venta | `c1`=código zona · `c2`=nombre zona |
| `kdurevcxc` | 0 | 14 | ⚪ | Revisión CxC (sin datos) | — |
| `kdusegcli` | 0 | 12 | ⚪ | Segmentación de clientes (sin datos) | — |
| `kduv` | 21 | 21 | 🟢 | Maestro de vendedores con porcentajes de comisión | `c2`=código vendedor · `c3`=nombre · `c4`/`c6`=comisión % por tipo · `c16`=clave corta |

---

### Recursos humanos / nómina
Módulo `kdrh*` del ERP Kepler para gestión de empleados, puestos, conceptos de percepción/deducción y movimientos de nómina. Fuera del alcance comercial; casi todas las tablas están vacías en la sucursal analizada.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdrhasp` | 0 | 60 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhcon` | 136 | 13 | ⚪ | Catálogo de conceptos de nómina (percepciones/deducciones) | `c1`=clave · `c2`=nombre (ej. "Sueldos y Salarios") · `c4`=tipo (PER/PERNI) · `c5`=cuenta contable · `c6`=orden |
| `kdrhdep` | 0 | 11 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhdesp` | 0 | 25 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhdxe` | 0 | 21 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhemfe` | 0 | 9 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhemp` | 0 | 43 | ⚪ | Maestro de empleados (sin datos en esta sucursal) | — |
| `kdrhmcr` | 14 | 2 | ⚪ | Catálogo de modalidades de cálculo de nómina | `c1`=clave (MU/MXM/MXB) · `c2`=descripción (ej. "Monto Unico al Período") |
| `kdrhmxe` | 0 | 69 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhnom` | 0 | 9 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhper` | 0 | 13 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhpue` | 0 | 7 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhtpem` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `kdrhtpmv` | 16 | 21 | ⚪ | Catálogo de tipos de movimiento de empleado (alta/baja/etc.) | `c1`=aplica nómina · `c2`=grupo · `c3`=tipo · `c4`=descripción (ej. "Contratación", "Despido") · `c9`=concepto nómina ref. |
| `kdrhtur` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |

---

### Fiscal / CFDI — parte A (comprobantes kdfe33 + Carta Porte SAT)
Plomería del timbrado CFDI 4.0 SAT: comprobantes fiscales, complemento Carta Porte y sus catálogos oficiales SAT (estaciones, materiales peligrosos, configuraciones de transporte, etc.). Bajo valor comercial directo; útil solo para reimprimir facturas o generar Carta Porte.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdfe33can` | 0 | 20 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33catlog` | 52 | 10 | ⚪ | Catálogo de versiones de tablas SAT descargadas | `c1`=nombre tabla SAT · `c4`=sucursal · `c5`=versión Kepler · `c8`=total registros |
| `kdfe33cecolo` | 145,366 | 3 | ⚪ | Catálogo SAT colonias/asentamientos por CP | `c1`=estado · `c2`=CP · `c3`=nombre colonia |
| `kdfe33cedirfis` | 2 | 15 | ⚪ | Dirección fiscal del emisor (datos RFC del contribuyente) | `c2`=clave · `c5`=calle · `c8`=estado · `c11`=municipio · `c13`=CP |
| `kdfe33cefracaran` | 0 | 8 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33cefracaraprod` | 0 | 3 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33ceinco` | 0 | 4 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33celoc` | 664 | 5 | ⚪ | Catálogo SAT localidades por estado | `c1`=estado · `c2`=clave mun · `c3`=nombre localidad · `c4`=vigencia |
| `kdfe33cemovtras` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33cempio` | 2,463 | 5 | ⚪ | Catálogo SAT municipios por estado | `c1`=clave mun · `c2`=estado · `c3`=nombre municipio |
| `kdfe33cepedim` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33cetipopera` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33ceunimed` | 0 | 4 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33cpcomplemento` | 0 | 5 | ⚪ | Complemento Carta Porte: config (sin datos) | — |
| `kdfe33cpdocrel` | 0 | 17 | ⚪ | Carta Porte: documentos relacionados (sin datos) | — |
| `kdfe33cpkaereos` | 0 | 10 | ⚪ | Carta Porte: aerolíneas (sin datos) | — |
| `kdfe33cpkcarros` | 0 | 4 | ⚪ | Carta Porte: carros ferroviarios (sin datos) | — |
| `kdfe33cpkcontenecarro` | 0 | 4 | ⚪ | Carta Porte: contenedores en carro (sin datos) | — |
| `kdfe33cpkcontenedoresmar` | 0 | 4 | ⚪ | Carta Porte: contenedores marítimos (sin datos) | — |
| `kdfe33cpkfiguratransporte` | 0 | 18 | ⚪ | Carta Porte: figuras de transporte (sin datos) | — |
| `kdfe33cpknavios` | 0 | 21 | ⚪ | Carta Porte: navíos (sin datos) | — |
| `kdfe33cpkremolque` | 0 | 4 | ⚪ | Carta Porte: remolques (sin datos) | — |
| `kdfe33cpkvehiculo` | 0 | 14 | ⚪ | Carta Porte: vehículos registrados (sin datos) | — |
| `kdfe33cpm1` | 0 | 9 | ⚪ | Carta Porte: encabezado de movimiento (sin datos) | — |
| `kdfe33cprelprodkcp` | 0 | 24 | ⚪ | Carta Porte: relación producto-concepto (sin datos) | — |
| `kdfe33docprv` | 7 | 16 | ⚪ | Relación doc previo → CFDI generado (venta→factura) | `c1`=suc · `c2/c3/c4/c5/c6`=llave doc origen · `c15`=serie folio · `c16`=folio CFDI |
| `kdfe33docsec` | 0 | 21 | ⚪ | Secuencias de documentos CFDI (sin datos) | — |
| `kdfe33fol` | 2 | 4 | ⚪ | Folios de series CFDI por sucursal | `c2`=serie · `c3`=clave serie · `c4`=último folio usado |
| `kdfe33folxdoc` | 20 | 14 | ⚪ | Folios CFDI asignados por tipo de documento | `c2`=serie · `c3`=género · `c4`=naturaleza · `c5`=tipo · `c8`=método pago · `c11`=email |
| `kdfe33m1` | 3,308 | 69 | ⚪ | Comprobantes CFDI 4.0 timbrados (encabezado) | `c1`=suc · `c2`=serie · `c3`=folio · `c6`=fecha · `c19`=subtotal · `c24`=total · `c30`=RFC emisor · `c34`=RFC receptor · `c44`=IVA · `c51`=ruta XML · `c54`=UUID SAT |
| `kdfe33m1rel` | 17 | 7 | ⚪ | CFDIs relacionados entre sí (notas de crédito / sustituciones) | `c1`=suc · `c2`=serie · `c3`=folio · `c6`=tipo relación · `c7`=UUID relacionado |
| `kdfe33m2` | 0 | 20 | ⚪ | Líneas de concepto del CFDI (sin datos en suc 03) | — |
| `kdfe33m2imp` | 0 | 12 | ⚪ | Impuestos por línea CFDI (sin datos) | — |
| `kdfe33m2ped` | 0 | 7 | ⚪ | Pedimento aduanal por línea CFDI (sin datos) | — |
| `kdfe33m2pte` | 0 | 21 | ⚪ | Parte del complemento Carta Porte por línea (sin datos) | — |
| `kdfe33m2pteimp` | 0 | 12 | ⚪ | Impuestos de la parte Carta Porte (sin datos) | — |
| `kdfe33pagm1` | 787 | 25 | ⚪ | Complemento de pago: encabezado (PPD / pago diferido) | `c1`=suc · `c2`=serie · `c3`=folio · `c6`=versión · `c7`=fecha pago · `c8`=forma pago · `c9`=moneda · `c12`=monto |
| `kdfe33pagm2` | 813 | 22 | ⚪ | Complemento de pago: documentos relacionados (CxC) | `c1`=suc · `c2`=serie · `c3`=folio · `c7/c8`=género/nat doc origen · `c13`=UUID CFDI origen · `c18`=método pago · `c20`=importe pagado |
| `kdfe33params` | 21 | 2 | ⚪ | Parámetros de configuración del módulo fiscal | `c1`=clave (XMLPATH/XMLNAME…) · `c2`=valor |
| `kdfe33reladu` | 0 | 2 | ⚪ | config/auxiliar (sin datos) | — |
| `kdfe33relmn` | 2 | 2 | ⚪ | Relación moneda interna→clave SAT (PESOS=MXN, DLLS=USD) | `c1`=moneda interna · `c2`=clave SAT |
| `kdfe33relped` | 0 | 4 | ⚪ | Relación pedido→CFDI (sin datos) | — |
| `kdfe33relprd` | 9,420 | 6 | ⚪ | Relación SKU→clave SAT de producto y unidad de medida | `c1`=SKU · `c2`=clave producto SAT · `c3`=clave unidad SAT · `c4`=objeto impuesto · `c6`=suc |
| `kdfe33relum` | 0 | 2 | ⚪ | Relación unidad interna→clave SAT (sin datos) | — |
| `kdfe33satadu` | 50 | 4 | ⚪ | Catálogo SAT Carta Porte: aduanas (50 puntos fronterizos) | `c1`=clave · `c2`=descripción aduana · `c3`=vigencia |
| `kdfe33satcp` | 95,748 | 16 | ⚪ | Catálogo SAT Carta Porte: estaciones (ferroviarias/marítimas) | `c1`=clave · `c2`=estado · `c3`=municipio · `c4`=tipo · `c8`=zona horaria · `c12`=offset UTC |
| `kdfe33satcpautmar` | 319 | 3 | ⚪ | Catálogo SAT Carta Porte: autorizaciones marítimas SCT | `c1`=folio SCT · `c2`=fecha inicio · `c3`=fecha fin |
| `kdfe33satcpcodaereo` | 160 | 6 | ⚪ | Catálogo SAT Carta Porte: aerolíneas IATA | `c1`=clave · `c2`=región · `c3`=nombre aerolínea · `c4`=código IATA |
| `kdfe33satcpconfigauto` | 34 | 7 | ⚪ | Catálogo SAT Carta Porte: configuraciones de vehículo automotor | `c1`=clave · `c2`=descripción tipo (vehículo ligero / camión) · `c3`=ejes · `c4`=llantas |
| `kdfe33satcpconfigmar` | 15 | 4 | ⚪ | Catálogo SAT Carta Porte: tipos de embarcación | `c1`=clave · `c2`=descripción (abastecedor/barcaza/granelero…) |
| `kdfe33satcpcontenedormar` | 12 | 4 | ⚪ | Catálogo SAT Carta Porte: tipos de contenedor marítimo | `c1`=clave · `c2`=descripción (refrigerado 20FT / estándar…) |
| `kdfe33satcpderechovia` | 119 | 8 | ⚪ | Catálogo SAT Carta Porte: derechos de vía ferroviaria | `c1`=clave · `c3`=origen (km) · `c4`=destino (km) · `c5`=rol · `c6`=vía |
| `kdfe33satcpembalaje` | 59 | 4 | ⚪ | Catálogo SAT Carta Porte: tipos de embalaje para mat. peligroso | `c1`=clave · `c2`=descripción (tambor acero / bidón aluminio…) |
| `kdfe33satcpestaciones` | 5,280 | 8 | ⚪ | Catálogo SAT Carta Porte: estaciones por municipio y país | `c1`=clave · `c2`=nombre · `c3`=estado · `c4`=país |
| `kdfe33satcpfigtransp` | 5 | 4 | ⚪ | Catálogo SAT Carta Porte: figuras de transporte (operador/propietario…) | `c1`=clave · `c2`=descripción |
| `kdfe33satcpmatpeligroso` | 2,337 | 7 | ⚪ | Catálogo SAT Carta Porte: materiales peligrosos ONU | `c1`=nº ONU · `c2`=descripción · `c3`=clase riesgo |
| `kdfe33satcppartetransp` | 12 | 4 | ⚪ | Catálogo SAT Carta Porte: partes/tipos de transporte terrestre | `c1`=clave · `c2`=descripción (camión unitario / tractocamión…) |
| `kdfe33satcpproductos` | 48,757 | 6 | ⚪ | Catálogo SAT: claves de productos y servicios (completo) | `c1`=clave SAT · `c2`=descripción · `c3`=agrupación |
| `kdfe33satcpservicios` | 4 | 5 | ⚪ | Catálogo SAT Carta Porte: tipos de servicio ferroviario | `c1`=clave · `c2`=descripción (carros ferroviarios / tren unitario…) |
| `kdfe33satcptipocarga` | 6 | 4 | ⚪ | Catálogo SAT Carta Porte: tipos de carga marítima | `c1`=clave · `c2`=descripción (CGS/CGC/GMN…) |
| `kdfe33satcptipocarro` | 11 | 5 | ⚪ | Catálogo SAT Carta Porte: tipos de carro ferroviario | `c1`=clave · `c2`=descripción (Furgón/Góndola/Tolva…) |

---

### Fiscal / CFDI — parte B (catálogos SAT + kdfe4 + emisor kdfece* + XML kdmx)
Plomería del timbrado CFDI 4.0: catálogos oficiales SAT (Carta Porte, formas de pago, unidades, países, regímenes), config del emisor (certificados, PACs, plan de cuentas), y store del XML timbrado por año. Bajo valor comercial salvo las cuentas propias y los XMLs para reimprimir facturas.

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `kdfe33satcptipocontenedor` | 5 | 5 | ⚪ | Catálogo SAT Carta Porte: tipos de contenedor | `c1`=clave (TC01/02/03) · `c2`=código tamaño (20'/40'/45') · `c3`=descripción longitud |
| `kdfe33satcptipoestacion` | 3 | 5 | ⚪ | Catálogo SAT Carta Porte: tipos de estación de ruta | `c1`=clave · `c2`=nombre (Origen Nacional/Intermedia/Destino Final) |
| `kdfe33satcptipopermiso` | 26 | 5 | ⚪ | Catálogo SAT Carta Porte: tipos de permiso SCT autotransporte | `c1`=clave TPAF · `c2`=descripción permiso · `c3`=modalidad |
| `kdfe33satcptiporemolque` | 31 | 4 | ⚪ | Catálogo SAT Carta Porte: tipos de remolque | `c1`=clave CTR · `c2`=nombre (Caballete/Caja/Caja Abierta…) |
| `kdfe33satcptipotrafico` | 4 | 4 | ⚪ | Catálogo SAT Carta Porte: tipos de tráfico | `c1`=clave TT · `c2`=nombre (local/interlineal remitido/recibido…) |
| `kdfe33satcptransporte` | 4 | 4 | ⚪ | Catálogo SAT Carta Porte: medios de transporte | `c1`=clave · `c2`=nombre (Autotransporte/Marítimo/Aéreo/Ferroviario) |
| `kdfe33satcpunidades` | 472 | 8 | ⚪ | Catálogo SAT Carta Porte: unidades de peso/embalaje | `c1`=clave UN · `c2`=nombre · `c3`=descripción · `c8`=categoría (Embalaje…) |
| `kdfe33satedo` | 95 | 5 | ⚪ | Catálogo SAT: estados/entidades federativas + internacionales | `c1`=clave (AGU/BCN…) · `c2`=país (MEX) · `c3`=nombre estado |
| `kdfe33satexp` | 4 | 4 | ⚪ | Catálogo SAT: tipo de exportación CFDI | `c1`=clave · `c2`=descripción (No aplica/Definitiva A1/Temporal…) |
| `kdfe33satfopg` | 22 | 14 | ⚪ | Catálogo SAT: formas de pago con validaciones de campos | `c1`=clave (01=Efectivo/02=Cheque/03=TEF…) · `c2`=nombre · `c3..c12`=flags y regex por campo |
| `kdfe33satimp` | 3 | 7 | ⚪ | Catálogo SAT: tipos de impuesto federal | `c1`=clave · `c2`=nombre (ISR/IVA/IEPS) · `c5`=ámbito (Federal) |
| `kdfe33satmes` | 18 | 4 | ⚪ | Catálogo SAT: meses del año (incluyendo bimestres) | `c1`=clave 01..18 · `c2`=nombre (Enero/Febrero…) |
| `kdfe33satmn` | 183 | 6 | ⚪ | Catálogo SAT: monedas internacionales | `c1`=ISO (AED/AFN/ALL…) · `c2`=nombre · `c3`=decimales · `c4`=límite |
| `kdfe33satmto` | 2 | 4 | ⚪ | Catálogo SAT: métodos de pago CFDI (PUE/PPD) | `c1`=clave · `c2`=descripción (pago único / parcialidades) |
| `kdfe33satobjimp` | 5 | 4 | ⚪ | Catálogo SAT: objeto de impuesto por línea CFDI | `c1`=clave · `c2`=descripción (No objeto/Sí objeto/No obligado desglose…) |
| `kdfe33satpais` | 250 | 6 | ⚪ | Catálogo SAT: países ISO (solo c1+c2 poblados) | `c1`=clave ISO (AFG/ALA/ALB…) · `c2`=nombre país — resto vacío |
| `kdfe33satpatadu` | 3,328 | 3 | ⚪ | Catálogo SAT: patentes aduanales vigentes | `c1`=clave numérica · `c2`=fecha alta · `c3`=fecha baja |
| `kdfe33satpedadu` | 51,173 | 6 | ⚪ | Catálogo SAT: pedimentos aduaneros (51k filas) | `c1`=aduana · `c2`=sección · `c3`=año · `c4`=folio |
| `kdfe33satper` | 5 | 4 | ⚪ | Catálogo SAT: periodicidades de pago nómina | `c1`=clave · `c2`=nombre (Diario/Semanal/Quincenal…) |
| `kdfe33satprd` | 52,513 | 9 | ⚪ | Catálogo SAT: claves de productos y servicios (52k) | `c1`=clave SAT (01010101…) · `c2`=descripción · `c8`=flag IVA · `c9`=segmento |
| `kdfe33satrf` | 19 | 6 | ⚪ | Catálogo SAT: regímenes fiscales RFC | `c1`=clave (601/603…) · `c2`=nombre · `c3`=PM · `c4`=PF |
| `kdfe33sattpc` | 6 | 6 | ⚪ | Catálogo SAT: tipos de comprobante CFDI | `c1`=clave (I=Ingreso/E=Egreso/T=Traslado…) · `c2`=nombre · `c3`=monto máx |
| `kdfe33sattpr` | 7 | 4 | ⚪ | Catálogo SAT: tipos de relación entre CFDIs | `c1`=clave · `c2`=descripción (nota crédito/débito/devolución…) |
| `kdfe33satum` | 2,418 | 7 | ⚪ | Catálogo SAT: unidades de medida CFDI (2418 claves) | `c1`=clave · `c2`=nombre · `c4`=nota vigencia — c3/c7 vacíos |
| `kdfe33satuso` | 24 | 7 | ⚪ | Catálogo SAT: usos de CFDI por receptor | `c1`=clave (G01/G02/G03…) · `c2`=descripción · `c7`=regímenes válidos |
| `kdfe4cp3kremccp` | 0 | 4 | ⚪ | Config/auxiliar CFDI 4.0 Carta Porte (sin datos) | — |
| `kdfe4imp` | 5,013 | 15 | ⚪ | CFDI 4.0: desglose de impuestos por línea de comprobante | `c1`=suc · `c2`=folio doc · `c3`=nº comprobante · `c11`=tipo imp (002=IVA/003=IEPS) · `c12`=tipo (Tasa) · `c14`=tasa · `c15`=importe |
| `kdfe4pagm0` | 787 | 16 | ⚪ | CFDI 4.0: complemento de pago (encabezado montos) | `c1`=suc · `c2`=folio · `c3`=nº pago · `c5`=versión CFDI · `c16`=total pagado |
| `kdfe4satcp3conespeciales` | 4 | 4 | ⚪ | Catálogo SAT CP3: condiciones de temperatura especial | `c1`=clave · `c2`=nombre (Congelados/Refrigerados/Temp controlada…) |
| `kdfe4satcp3docaduanero` | 20 | 4 | ⚪ | Catálogo SAT CP3: tipos de documento aduanero | `c1`=clave · `c2`=descripción (Pedimento/Importación temporal…) |
| `kdfe4satcp3frfarmaceutica` | 20 | 4 | ⚪ | Catálogo SAT CP3: formas farmacéuticas (complemento salud) | `c1`=clave · `c2`=nombre (Tableta/Cápsulas/Comprimidos…) |
| `kdfe4satcp3regaduanero` | 10 | 5 | ⚪ | Catálogo SAT CP3: regímenes aduaneros Carta Porte | `c1`=clave (IMD/EXD/ITR…) · `c2`=descripción · `c3`=dirección (Entrada/Salida) |
| `kdfe4satcp3registmo` | 6 | 4 | ⚪ | Catálogo SAT CP3: registros de movimiento portuario | `c1`=clave · `c2`=nombre puerto (Coatzacoalcos I/II/Texistepec…) |
| `kdfe4satcp3seccofepris` | 5 | 4 | ⚪ | Catálogo SAT CP3: secciones COFEPRIS para farmacéutica | `c1`=clave · `c2`=nombre (Medicamento/Precursores/Psicotrópicos…) |
| `kdfe4satcp3tipomateria` | 5 | 4 | ⚪ | Catálogo SAT CP3: tipos de materia en Carta Porte | `c1`=clave · `c2`=nombre (Materia prima/procesada/terminada…) |
| `kdfeaddeconfig` | 0 | 4 | ⚪ | Config/auxiliar CFDI addenda (sin datos) | — |
| `kdfeaddexcli` | 0 | 3 | ⚪ | Config/auxiliar excepciones cliente addenda (sin datos) | — |
| `kdfeceban` | 0 | 3 | ⚪ | Cuentas bancarias del emisor (sin datos) | — |
| `kdfececonfig` | 10 | 3 | ⚪ | Config emisor CFDI: parámetros clave-valor | `c1`=clave (BCODEST/BLZ13/CTADEST…) · `c2`=descripción · `c3`=valor |
| `kdfececta` | 331 | 3 | 🟡 | Plan de cuentas propio mapeado a catálogo SAT | `c1`=cuenta propia (111-3041-001-001…) · `c2`=código SAT (102=Bancos) · `c3`=D/C (naturaleza) |
| `kdfecedoc` | 17 | 6 | ⚪ | Config emisor: mapeo de tipos de doc a campos CFDI | `c1`=género (U/N) · `c2`=tipo · `c3..c5`=campos destino |
| `kdfecedocuuid` | 0 | 9 | ⚪ | Config emisor: UUID por doc CFDI (sin datos) | — |
| `kdfecerep` | 0 | 14 | ⚪ | Representaciones impresas CFDI (sin datos) | — |
| `kdfecert` | 1 | 10 | ⚪ | Certificado CSD activo del emisor | `c2`=nº certificado · `c3`=ruta .key · `c4`=ruta .cer · `c5`=contraseña · `c9`=fecha inicio · `c10`=fecha expiración (2029-04-23) |
| `kdfecesatban` | 94 | 4 | ⚪ | Catálogo SAT: bancos (clabe/SPEI) | `c1`=clave (002/006…) · `c2`=clave corta (BANAMEX…) · `c3`=nombre completo |
| `kdfecesatcta` | 1,079 | 2 | 🟡 | Catálogo agrupador SAT de cuentas contables (1079 entradas) | `c1`=código SAT (100/100.01/101…) · `c2`=nombre (Activo/Activo a corto plazo/Caja…) |
| `kdfecesatmon` | 175 | 2 | ⚪ | Catálogo SAT: monedas (versión emisor, solo clave+nombre) | `c1`=ISO · `c2`=nombre moneda |
| `kdfecesatmto` | 19 | 2 | ⚪ | Catálogo SAT: métodos de pago (versión emisor simplificada) | `c1`=clave · `c2`=nombre (Efectivo/Cheque/Transferencia…) |
| `kdfecfd` | 0 | 95 | ⚪ | Comprobantes CFDI generados (95 cols, sin datos en esta suc) | — |
| `kdfecfdcom` | 0 | 13 | ⚪ | Complementos de comprobantes CFDI (sin datos) | — |
| `kdfeconf` | 2 | 16 | ⚪ | Config módulo fiscal: params generales del emisor | `c1`=suc · `c15`=régimen fiscal (612) — resto opaco |
| `kdfedfprov` | 1 | 5 | ⚪ | Config: tipo de divisa/proveedor fiscal | `c1`=clave (TI005) · `c3`=ámbito (Nacional) |
| `kdfedir` | 403 | 19 | ⚪ | Directorio fiscal de receptores/emisor (domicilios CFDI) | `c1`=id · `c13`=CP · `c19`=razón social — mayoría de cols opacas |
| `kdfefol` | 0 | 8 | ⚪ | Control de folios CFDI (sin datos) | — |
| `kdfefolxdoc` | 0 | 7 | ⚪ | Folios por tipo de documento CFDI (sin datos) | — |
| `kdfenoti` | 1 | 6 | ⚪ | Notificaciones PAC/SAT recibidas | `c1`=suc · `c2`=fecha · `c3`=estado · `c4`=nº certificado |
| `kdfepacs` | 4 | 29 | ⚪ | PACs configurados para timbrado (4 proveedores) | `c1`=clave PAC · `c2`=nombre · `c3`=alias · `c7`=URL · `c8`=instrucciones |
| `kdmx` | 0 | 9 | ⚪ | Store XML CFDI timbrado (tabla base sin datos) | — |
| `kdmx_25` | 95,606 | 9 | ⚪ | Store XML CFDI timbrado año 2025 (95k registros) | `c1`=suc · `c2`=género · `c3`=nat · `c4..c6`=llave doc · `c7`=nº chunk · `c8`=XML/base64 · `c9`=fecha |
| `kdmx_26` | 386,983 | 9 | ⚪ | Store XML CFDI timbrado año 2026 (387k registros, tabla más grande) | `c1`=suc · `c2`=género · `c3`=nat · `c4..c6`=llave doc · `c7`=nº chunk · `c8`=XML/base64 · `c9`=fecha |

---

### Sistema / configuración / auxiliares / logs
Tablas de soporte del ERP Kepler: configuración global, catálogos geográficos, activos fijos, usuarios web, crédito, cuentas por pagar, log de auditoría y auxiliares de demanda. La mayoría son ⚪ (config/plomería interna), con excepción de `doctype` (taxonomía maestra crítica) y los logs anuales `orglogtbl_*` (auditoría operacional).

| Tabla | Filas | Cols | Rel. | Qué es | Columnas clave |
|---|---:|---:|:--:|---|---|
| `crdcredit` | 0 | 42 | ⚪ | Crédito: parámetros de financiamiento por cliente | — (sin datos; k_branch=sucursal · k_cust=cliente · k_m=monto · k_int=tasa interés, inferido de cols) |
| `crdcreditvar` | 0 | 8 | ⚪ | Crédito: variaciones/disposiciones de línea de crédito | — (sin datos; k_balance=saldo · k_disp=monto disponible, inferido) |
| `datfisparams` | 5 | 2 | ⚪ | Config de notificación para actualizar datos fiscales del cliente (URL portal) | `k_code`=clave parámetro · `k_param`=valor (título/contenido/URL interna 127.0.0.1) |
| `doctype` | 81 | 21 | ⚪ | **Taxonomía maestra de todos los documentos del ERP.** Código jerárquico `{género}{nat}{grupo}{tipo}`; `k_gender` S/P/N, `k_nature` D/C, `k_doc7`=prefijo folio (UD0501 venta crédito, ND3001 inv. físico). CRÍTICA para interpretar kdm1/kdm2/kdij. | `k_code`=clave doc · `k_parent`=padre jerárquico · `k_dscr`=descripción · `k_gender`=S/P/N · `k_nature`=D/C · `k_doc7`=prefijo folio |
| `kdactiv` | 0 | 16 | ⚪ | Activos fijos: registro de alta (opaco, sin datos) | — |
| `kdb1` | 20 | 12 | ⚪ | Catálogo de cuentas bancarias (BANAMEX/BAJIO en PESOS) | `c1`=número cuenta · `c2`=descripción banco · `c3`=CLABE · `c4`=moneda · `c5`=cuenta contable · `c9`=RFC banco |
| `kdb2` | 0 | 8 | ⚪ | Movimientos bancarios (sin datos) | — |
| `kdb3` | 0 | 8 | ⚪ | Movimientos bancarios auxiliar (sin datos) | — |
| `kdconfig` | 48 | 4 | ⚪ | Config global del ERP: parámetros CXC/CXP (tipo límite, restrictivo/informativo) | `c1`=módulo (CXC/CXP) · `c2`=clave parámetro · `c3`=valor · `c4`=descripción larga |
| `kdderip` | 0 | 68 | ⚪ | Auxiliar de derechos/permisos por perfil (opaco, sin datos) | — |
| `kdderip2` | 0 | 16 | ⚪ | Auxiliar de derechos/permisos secundario (sin datos) | — |
| `kddpest` | 4 | 5 | ⚪ | Catálogo de métodos de estimación de demanda (PM/PP/PS: promedio móvil/ponderado/simple) | `c1`=clave método · `c2`=nombre · `c3`=descripción · `c5`=periodos default |
| `kddplin` | 0 | 5 | ⚪ | Config de demanda por línea (sin datos) | — |
| `kddpprd` | 0 | 5 | ⚪ | Config de demanda por producto (sin datos) | — |
| `kdfavoritos` | 0 | 23 | ⚪ | Favoritos/atajos de usuario en la UI del ERP (sin datos) | — |
| `kdflujosdesc` | 19 | 10 | ⚪ | Flujos de documentos: describe transiciones entre tipos doc (COT→PED→factura) | `c1`=código flujo · `c2`=módulo (V=ventas) · `c3`=descripción · `c4`=género · `c5`=naturaleza · `c6`=grupo doc · `c9`=predecesor |
| `kdfolio` | 2 | 3 | 🟡 | Contador/secuencia de folios activos: PD- (pedidos, último 20344) y ORC- (órdenes, último 4) | `c1`=prefijo folio · `c2`=último número asignado · `c3`=fecha último folio |
| `kdgue` | 32 | 3 | ⚪ | Catálogo geográfico: estados de México (clave ISO + nombre) | `c1`=país (MEX) · `c2`=clave estado (AGS/BCN…) · `c3`=nombre estado |
| `kdgum` | 19 | 6 | ⚪ | Catálogo geográfico: municipios de Querétaro con zona horaria | `c1`=país · `c2`=estado (QRO) · `c3`=clave municipio · `c4`=nombre · `c5`=flag · `c6`=offset TZ (-6) |
| `kdgup` | 2 | 5 | ⚪ | Catálogo de países: México y EUA con lada, idioma y moneda | `c1`=clave país · `c2`=nombre oficial · `c3`=lada · `c4`=idioma · `c5`=moneda |
| `kdrutman` | 3 | 6 | ⚪ | Log de ejecución de rutinas automáticas (cierres contables FINANIOCNT) con rango horario y cuentas procesadas | `c1`=clave rutina · `c2`=sucursal (MD) · `c3`=fecha · `c4`=hora inicio · `c5`=hora fin · `c6`=cuentas afectadas (lista CSV) |
| `kdt1` | 108 | 18 | ⚪ | Catálogo de activos fijos: cámaras de seguridad, escaleras, extintores con costo y fecha alta | `c1`=clave activo · `c2`=descripción · `c4`=vida útil (meses) · `c5`=valor original · `c8`=fecha alta · `c15`=categoría (ECE/EAL/MOB) |
| `kdt2` | 0 | 3 | ⚪ | Depreciación de activos fijos (sin datos) | — |
| `kdtact` | 9 | 5 | ⚪ | Categorías de activos fijos con tasa de depreciación anual (MOBILIARIO 10%, EQUIPO REPARTO 25%) | `c1`=clave categoría · `c2`=nombre · `c3`=cuenta contable · `c4`=subcuenta · `c5`=tasa depreciación % |
| `kdtriggers` | 0 | 18 | ⚪ | Triggers/automatizaciones del ERP (sin datos) | — |
| `kdxd` | 630 | 36 | 🟡 | Catálogo de proveedores CXP: nombre, dirección, RFC, límite de crédito | `c1`=sucursal · `c2`=clave proveedor · `c3`=nombre · `c4`=dirección · `c6`=ciudad · `c7`=teléfono · `c10`=RFC · `c15`=límite crédito · `c35`=activo (S/N) |
| `kdxe` | 1,700 | 31 | 🟡 | CxP: estado de cuenta por proveedor (saldos, vencimientos, folios de doc) | `c1`=sucursal · `c2`=proveedor · `c3`=letra doc · `c4`=grupo · `c6`=folio · `c7`=fecha doc · `c8`=moneda · `c11..c15`=importes (cargo/abono/saldo) · `c16`=ref interna |
| `kdxf` | 250 | 11 | 🟡 | CxP: líneas/aplicaciones de pago a proveedores con importes parciales | `c1`=sucursal · `c2`=proveedor · `c3`=fecha · `c4`=grupo · `c6`=folio pago · `c9`=folio doc aplicado · `c10`=monto aplicado · `c11`=saldo restante |
| `kdxg` | 94 | 58 | 🟡 | CxP: saldos mensuales acumulados por proveedor/moneda (48 columnas numéricas = 24 meses × cargo/abono) | `c1`=moneda · `c2`=sucursal · `c3`=proveedor · `c4`=fecha · `c11..c58`=importes por periodo mensual |
| `kdxj` | 0 | 3 | ⚪ | Auxiliar CxP (sin datos, opaco) | — |
| `kdxk` | 0 | 2 | ⚪ | Auxiliar CxP (sin datos, opaco) | — |
| `kdxrevcxp` | 0 | 14 | ⚪ | Revisión/conciliación CxP (sin datos) | — |
| `kdxv` | 12 | 3 | ⚪ | Catálogo de conceptos de gasto CxP (COMPRAS MORELIA, COMPRAS ZAMORA, REPARACIÓN SISTEMAS) | `c2`=clave · `c3`=descripción concepto |
| `newsdashboard` | 0 | 13 | ⚪ | Noticias/avisos del dashboard ERP (sin datos) | — |
| `orgbranch` | 2 | 7 | ⚪ | Sucursal lógica del ERP: rama B001 (Main branch) y W01 (Main store) | `k_code`=clave · `k_dscr`=descripción · `k_level`=nivel (B=branch/S=store) · `k_brn7`=código 2 dígitos (01) |
| `orgcurrency` | 2 | 9 | ⚪ | Monedas activas: MXN y USD con cuentas contables y código SAT | `k_code`=ISO · `k_dscr`=nombre · `k_short`=abreviatura · `k_account`=cuenta · `k_satcode`=código SAT |
| `orglogtbl_24` | 29,147 | 7 | ⚪ | Log de operaciones ERP 2024 (INS/UPD/DEL por tabla, usuario, timestamp, campos afectados) | `k_table`=tabla · `k_mode`=INS/UPD/DEL · `k_date`=timestamp · `k_user`=usuario · `k_str1`=campos · `k_str2`=valores/where |
| `orglogtbl_25` | 102,571 | 7 | ⚪ | Log de operaciones ERP 2025 (misma estructura que _24) | `k_table`=tabla · `k_mode`=INS/UPD/DEL · `k_date`=timestamp · `k_user`=usuario · `k_str1`=campos · `k_str2`=valores/where |
| `orglogtbl_26` | 165,599 | 7 | ⚪ | Log de operaciones ERP 2026 en curso (más activo: 165k filas) | `k_table`=tabla · `k_mode`=INS/UPD/DEL · `k_date`=timestamp · `k_user`=usuario · `k_str1`=campos · `k_str2`=valores/where |
| `orgmail` | 1 | 14 | ⚪ | Config SMTP del ERP: cuenta Gmail sucursal La Piedad Abastos (puerto 465 SSL) | `k_mail`=cuenta · `k_server`=smtp.gmail.com · `k_port`=465 · `k_ssl`=1 · `k_user`/`k_pass`=credenciales |
| `syshdassigned` | 0 | 2 | ⚪ | Mesa de ayuda: asignación de tickets a usuarios (sin datos) | — |
| `syshddeptos` | 5 | 2 | ⚪ | Mesa de ayuda: departamentos con perfiles autorizados (IT, ACCOUNTING, SALES) | `k_code`=depto · `k_profiles`=roles autorizados (CSV) |
| `webuser` | 0 | 18 | ⚪ | Usuarios del portal web Kepler (sin datos en esta sucursal) | — (k_usr/k_psw/k_name/k_type/k_status/k_branch/k_mail1, inferido de cols) |
| `webusrtypes` | 1 | 2 | ⚪ | Tipos de usuario web: solo SUPERADMIN definido | `k_code`=tipo · `k_dscr`=descripción |

---

## Mapeo a la plataforma

- `kdii.c1` == `public.products.sku` (tenant Mega Dulces). Stock `kdil.c9`, costo `kdik.c9/c6`.
- Ventas: `kdm1`⋈`kdm2` por `c1..c6` → `mart.ventas` (pipeline on-prem, ver [`RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md`](RUNBOOKS/KEPLER_CONSOLIDADO_PROD.md)).
- El pipeline corre **on-prem** (Railway no alcanza la red MD) y empuja agregados a prod por bulk.

> Para "qué priorizar / integrar" ver la versión curada [`KEPLER_CATALOGO_TABLAS.md`](KEPLER_CATALOGO_TABLAS.md).
