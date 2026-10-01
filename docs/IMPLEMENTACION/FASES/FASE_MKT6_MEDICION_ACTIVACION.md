# `[MKT.6]` — Medición de la activación: ¿la promoción movió la aguja?

> **Estado:** 🧪 EN CÓDIGO y PROBADO EN LOCAL · 2026-09-28
> **Depende de:** `[MKT.1]` (acuerdos con proveedor / formato MKTN001), sin mergear todavía.
> **Hereda:** ADR-056 (lo que no se pudo medir se DECLARA) · ADR-059 (el dinero arbitra) ·
> ADR-055 / ADR-057 (la unidad se resuelve una vez, y no se suma a ciegas) · ADR-050 (alcance).

---

## 1. Por qué existe

`[MKT.1]` digitaliza el formato **MKTN001**: el acuerdo negociado con el proveedor, sus códigos,
los canales participantes y la evidencia que sube cada plaza. Eso prueba que la promoción
**se ejecutó**. No dice si **sirvió**.

El flujo en papel sí intentaba medirlo, y lo hacía **fotografiando tickets y tecleando el
importe**. Eso tiene tres defectos que no se arreglan con más disciplina:

| Defecto del papel | Por qué no se arregla con disciplina |
|---|---|
| Sólo ve los tickets que alguien fotografió | Es un **muestreo sesgado**, no una medición |
| Ordena por PIEZAS, que es el campo que menos se captura | Una plaza que vendió bien con ese campo vacío **desaparece del ranking**, y la ausencia se lee como "ahí no se vendió" |
| El número es **bruto** | $80,000 durante la promo no dice nada si antes ya se vendían $78,000 |

La venta real ya está derivada del ERP en `analytics.v_sellout_daily` — la definición única del
universo del sell-out, con sus tres piernas y su dedup de cutover horneados. Medir desde ahí no
cuesta captura: cuesta un JOIN.

---

## 2. Qué se construyó

| Pieza | Archivo |
|---|---|
| Vista de medición | `database/migrations-newdb/20260928150000_v_promo_agreement_sellout.js` |
| Servicio (lectura, rollup, diagnóstico, conciliación) | `libs/commercial/src/lib/commercial-promo-sellout/promo-sellout.service.ts` |
| Controlador (5 rutas, **sin permisos nuevos**) | `…/promo-sellout.controller.ts` |
| Módulo | `…/commercial-promo-sellout.module.ts` |
| **Pantalla** `/mkt/resultado` (pestaña «Resultado») | `apps/view/…/comercial/pages/mkt-resultado.component.ts` |
| Servicio del frontend | `apps/view/…/comercial/promo-sellout.service.ts` |
| Pruebas unitarias backend (16) | `…/promo-sellout.resumen.spec.ts` · `…/promo-sellout.scope.spec.ts` |
| Prueba de la pantalla (9, con TestBed) | `…/pages/mkt-resultado.component.spec.ts` |
| Smoke de base (29 aserciones) | `database/tests/test-newdb-promo-sellout.js` |
| Smoke HTTP (24 aserciones) | `database/tests/http-promo-sellout-test.js` |
| Semilla de desarrollo (para poder VER la pantalla) | `database/scripts/dev-seed-promo-sellout.js` |
| Helper de migración local | `database/scripts/apply-one-migration-local.js` |

**Grano: el CANAL**, que es la misma unidad del expediente. Así "¿esta plaza ejecutó **y**
vendió?" se contesta con una sola fila, sin cruzar dos granos distintos.

**Línea base:** exactamente los mismos días inmediatamente anteriores a la vigencia. No "el mes
pasado" ni "el año anterior": una ventana de distinto largo no es comparable.

---

## 3. Las seis maneras de mentir con un número de resultado

Cada una está rota a propósito en el smoke — *un candado sin prueba negativa es una intención*.

1. **Dar por medido lo que no se pudo mirar.** `sin_alcance` (ningún código ligado al catálogo) y
   `sin_venta` (hubo alcance y no hubo ventas) son **conclusiones opuestas**: un solo estado
   haría que un acuerdo a medio capturar se lea como un fracaso comercial.
2. **Publicar un bruto disfrazado de uplift.** Sin línea base el uplift va `NULL`, no el bruto.
3. **Dividir entre cero.** Base en 0 con venta positiva no es `+infinito%`: es "no había base".
4. **Mover la ventana.** Se prueba el **borde**: el día anterior al arranque de la base no entra.
   Medido: incluirlo cambiaría la base de **$5,366.25 a $5,697.50**.
5. **Sumar peras con manzanas.** `units` sólo se publica si todo el alcance comparte un único
   `unit_kind`; si se mezclan va `NULL` con `unidad_estado='mixta'`. El dinero, que siempre es
   conmensurable, se sigue publicando.
6. **Medir 2 de 6 códigos como si fuera el acuerdo entero.** `codigos_ligados / codigos_total`
   declara cuánto se está mirando de verdad.

Y el candado transversal: **la cifra se compara contra un recálculo independiente** escrito con
otra consulta. Un test que reusa el SQL de la vista sólo prueba que Postgres es determinista.

---

## 4. Lo medido

Contra el Docker local (`platform_local`, 558 MB, con `kepler_ods` y sell-out real
2026-07-01 → 2026-08-26):

- **Aritmética verificada**: ventana `$5,443.63` == recálculo independiente; base `$5,366.25` ==
  recálculo; uplift `+$77.38` (**+1.44 %**) sobre `RUTA-22 × SKU 17084`, 14 días.
- **Smoke `test-newdb-promo-sellout.js`: 29/29**, con 3 bloques declarados `NO MEDIDO`.
- **Smoke HTTP `http-promo-sellout-test.js`: 24/24** contra la API real levantada en `:3402`.
  Cierra el `NO MEDIDO` de la capa HTTP: el `null` **sobrevive el viaje** (un canal `sin_venta`
  llega con `monto_ventana: null`, no `0` ni con la clave ausente) y tiene su control positivo
  (un canal medido llega con `19245.89`); sin token da **401**; el rollup por HTTP cuadra
  (`31576.87` == suma de los medidos).
- **Pruebas unitarias: 16/16** (`npx vitest run src/lib/commercial-promo-sellout` desde
  `libs/commercial`). **Prueba negativa de la prueba**: al mutar `resumir()` para que cuente
  todos los canales como medidos, 3 specs se ponen en rojo; restaurado, 16 en verde.
- **Prueba de la pantalla: 9/9** (`apps/view`). **Encontró un defecto real antes de que nadie
  abriera el navegador:** el template usaba `pTemplate="header|body|emptymessage"`, que
  **PrimeNG 22 ignora** — la tabla montaba sin una sola fila y `nx build view` pasaba en verde.
  El repo ya había migrado a `#header`/`#body` en **144 archivos**; quedaban 2 con la sintaxis
  vieja y yo escribí la tercera. Es exactamente el modo de falla que la compuerta
  `check-primeng-api.js` existe para cazar, y la única forma de verlo es montar el componente.
- `nx build api` y `nx build view` verdes (dos errores de tipos propios encontrados y
  corregidos: un `reduce` que inferí­a `number | null`, y `unknown[]` donde knex exige
  `RawBinding`).

### ⭐ Hallazgo: los 21 canales del seed dan `sin_alcance`

Corrida contra los 5 acuerdos sembrados por `[MKT.1]` (Mondelez, Canel's, Klassco, Alteño folio
1013, DELICIATE): **los 21 canales devuelven `sin_alcance`**, porque
`promo_agreement_codes.product_id` está en NULL en los 6 códigos.

Sin la cobertura declarada, la pantalla habría dicho *"no vendió"* en las 21 plazas.

Y los seis códigos **resuelven exacto contra el catálogo por `sku`** (medido: `09003`, `09068`,
`20054` ×2, `20061` ×2; cuatro resuelven además por `barcode`). O sea: la liga existe, el flujo
de captura no la escribe. Es de `[MKT.1]`, no de acá — por eso el servicio expone
`GET …/acuerdo/:id/cobertura` como **diagnóstico** (cuántos se podrían ligar) y **no** liga nada:
resolver el mismo código en dos lugares distintos garantiza que un día digan cosas distintas.

---

## 5. Lo que NO se pudo medir, declarado

| Qué | Por qué | Estado |
|---|---|---|
| Conciliación negociado ↔ acreditado | `analytics.erp_purchase_adjustments` está en **0 filas** en la base local (su importer nunca corrió acá) | **Construida, NO medida** — el servicio devuelve `estado: 'fuente_vacia'`, nunca `$0` |
| Validación contra datos de staging | `platform_test` **y** `platform_replica` dan **3D000** y `pg_database_size` NULL: figuran en `pg_database` y no aceptan conexión (2026-09-28) | No ejecutada |
| Caso `unidad_estado='mixta'` | Ningún (plaza, producto) del fixture mezcla peldaños | `NO MEDIDO` en el smoke |
| Corte por alcance sobre datos reales | El usuario del smoke es `superadmin` y ve todas las plazas | `NO MEDIDO` en el smoke HTTP — lo cubre `promo-sellout.scope.spec.ts` con dobles, que es donde vive la decisión de cortar |
| **La pantalla en el navegador** | Las dos API locales (`:3334` y `:3401`) las levantó **otra sesión** y sirven un `dist` anterior a este build: contestan **404** en `/commercial/promo-sellout`. No se reiniciaron para no interrumpir su prueba | Verificada por prueba de componente y por HTTP en `:3402`; **falta la mirada en el navegador** |

### Para verlo en el navegador

1. Reiniciar la API que la vista local consume — `apps/view/src/environments/environment.ts`
   apunta a `http://localhost:3401/api`, y ese proceso es de otra sesión.
2. `node database/scripts/dev-seed-promo-sellout.js` (idempotente, **se niega a correr fuera de
   local**): liga los 6 códigos por SKU y siembra un acuerdo cuya vigencia cae dentro del rango
   con sell-out real. Sin esto la pantalla es correcta pero sale entera en `sin_alcance`.
3. `/mkt/resultado`, pestaña **Resultado**.

Medido tras la semilla: **2 canales `medida`** (`RUTA-22` **+$497.14 / +2.65 %** y `RUTA-27`
**−$3,807.52 / −23.59 %**), 19 `sin_venta` y 2 `sin_alcance` — o sea, la pantalla enseña los
cuatro estados y un uplift en verde y otro en rojo, que es lo que había que poder juzgar.

---

## 6. Decisiones de coordinación (checkout compartido)

`[MKT.1]` y esto se escribieron **a la vez en el mismo working tree**. Por eso:

- **Módulo aparte** (`commercial-promo-sellout/`) en vez de archivos dentro de
  `commercial-promo-agreements/`. No es una decisión de arquitectura: comparten tablas, permisos
  y dominio. **Fundirlos en un solo módulo cuando `[MKT.1]` llegue a `main` es un movimiento de
  dos líneas y queda declarado como pendiente.**
- **Cero permisos nuevos.** Reusa `MKT_AGREEMENTS_VER` (Mercadotecnia, ve el monto negociado) y
  `MKT_AGREEMENT_EVIDENCE_SUBIR` (la plaza, sólo su ruta `/sucursal/:code`). Una clave nueva
  sería una puerta más que alguien tendría que acordarse de abrir — la lección de `[LC.6.2]`.
- Se **descartó** un módulo paralelo propio (`trade.promo_*`, 5 tablas + vista) que se había
  construido antes de detectar `[MKT.1]`. Se revirtió entero: 0 objetos en la base, 0 filas en
  `knex_migrations`, 0 rastros en los archivos de authz. Dos módulos del mismo hecho, con dos
  familias de permisos y dos rutas, es exactamente lo que la regla de "cada permiso vive en un
  solo módulo" existe para impedir.

---

## 7. Pendientes

- [ ] Correr el smoke contra **staging** cuando `platform_test` vuelva (hoy: 3D000).
- [ ] Medir la conciliación con el espejo de notas de crédito poblado (**$20.3M / 1,154 docs en
      2026** según la Fase RE — ahí está el "apoyo de marca" que cierra el ciclo del dinero).
- [ ] Ejercer la capa HTTP con la API levantada.
- [ ] Fundir el módulo con `[MKT.1]` tras su merge.
- [ ] **Mirar la pantalla en el navegador** (ver el recuadro de arriba: hace falta reiniciar la
      API de `:3401`, que es de otra sesión).
- [ ] ⚠️ `node scripts/check-primeng-api.js` está **rojo**: `styleClass` sobre `p-table` va en
      289 usos contra un techo de 283. Es deuda del repo, no de esta fase —sin mi tabla serían
      288, igual por encima—, pero conviene saber que la compuerta no está en verde.
- [ ] **Para `[MKT.1]`:** ligar `promo_agreement_codes.product_id` al capturar — hoy los 6
      códigos del seed resuelven por SKU y ninguno está ligado, así que la medición no ve nada.
- [ ] Aplicar `20260928150000` a Railway (después de la migración de `[MKT.1]`).
