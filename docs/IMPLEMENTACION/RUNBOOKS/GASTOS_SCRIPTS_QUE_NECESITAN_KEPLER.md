# Tres preguntas abiertas de Gastos que necesitan lectura a Kepler

> **Para:** Edgar · **De:** sesión de Gastos (David) · **2026-10-03**
> **Qué se pide:** la credencial `KEPLER_RO_PASS`, o que alguien corra estos tres comandos
> donde ya esté configurada. Son **sólo lectura**; no escriben en Kepler ni en la plataforma.

---

## El bloqueo, en una línea

Los tres scripts están escritos y probados. **Ninguno se pudo correr** porque desde la máquina
de trabajo no hay lectura a los datos reales de Kepler.

Lo que sí se consiguió y lo que falta, medido el 2026-10-03:

| | Resultado |
|---|---|
| `192.168.0.222:5433` como `app_runtime` | ✅ conecta — se ven las 8 réplicas (`kepler_md_00`…`_08`) |
| Leer `md.kdm1` con ese rol | ⛔ **`permission denied for schema md`** |
| El rol que sí lee | **`platform_ro`** (confirmado en `database/importers/lib/kepler-branches.js:31`) |
| `KEPLER_RO_PASS` en el `.env` local | ⛔ **vacía** |
| SSH a `md` | ⛔ pide llave |
| `.245:5432` con `app_runtime` / `postgres` | ⛔ `28P01`, credencial rechazada |

**Con `KEPLER_RO_PASS` se destraban los tres.** No hace falta nada más.

> 💡 **Dato útil para quien los corra:** `kdm1` tiene índice `(c1, c2, c3, c4, c5, c6)`. Una
> consulta que **omita `c1`** (la sucursal) hace scan de 1.8 GB y se cuelga. Con la sucursal
> adelante es instantánea. Ya costó un timeout.

---

## 1 · ¿Quién autorizó un gasto, y a qué hora?

```bash
node database/scripts/huella-autorizacion-gasto.js --suc=01 --folio=0000010 --antes
#   ... se autoriza el renglón en Kepler ...
node database/scripts/huella-autorizacion-gasto.js --suc=01 --folio=0000010 --despues
```

**Por qué importa.** El 2026-10-03 se autorizó y se devolvió la solicitud `XA1501-0000010`
(sucursal PH, $10.00) desde la pantalla *Autorización Sol Gasto*. El Monto Autorizado se movió
de `9,621.19` a `9,611.19` y de vuelta — pero **el renglón quedó idéntico a como estaba**. Si
Kepler sólo mueve `c43` de `N` a `A`, entonces deshacer **borra la evidencia completa**: nadie
puede saber que ese gasto estuvo autorizado.

Eso es más grave que el dato faltante, y **todavía no está medido sobre el documento real**.

**Qué hace el script.** Fotografía las ~200 columnas del documento antes, y después las compara.
No mira sólo `kdm1`: busca el folio en todas las tablas del ODS donde pudiera aparecer y reporta
las que lo tienen después y no antes — mirar sólo `kdm1` daría «no hay huella» sin haber buscado.
Al final dice derecho si alguna columna trae **el usuario** o **fecha/hora**.

⚠️ Si el «después» sale idéntico, el script **no concluye** que no haya huella: el ODS es una
réplica y el cambio puede no haber llegado por el CDC. Lo dice y pide repetir.

⚠️ El `--antes` es obligatorio. Sin él, un campo lleno no se distingue de uno que ya estaba lleno.

⚠️ **`--suc=01` está sin confirmar.** «Sucursal PH» se asume `01` por la documentación
(`md_01/PH`) y porque el documento debería estar en `kepler_md_01`. No se pudo verificar.

**Probado:** con un documento desechable en la base local, simulando el `N → A`. El diff lo
detecta. Lo que falta es correrlo contra el real.

---

## 2 · Las 4 vistas que se quedaron en el corte del 1 de octubre

```bash
node database/scripts/check-corte-01oct.js
```

**Por qué importa.** Del 1-ene al 30-sep la sucursal `00` fue el **concentrador** de la migración
Wincaja→Kepler. Desde el 1-oct sólo recibe CEDIS, logística y corporativo, y cada centro de costo
opera por su cuenta.

⛔ **Cuatro vistas siguen filtrando `sucursal = '00'`.** Era correcto hasta septiembre; desde
octubre deja fuera a los centros nuevos **sin un solo error**: las pantallas no se rompen,
muestran menos filas.

| Vista | Anclas | Consumidores | Qué pasa si no se toca |
|---|---:|---:|---|
| `analytics.kepler_cancelled_docs` | 4 | 3 | ⛔ **el peor**: lo cancelado en plazas nuevas sigue contando como vivo. **Infla.** |
| `analytics.erp_supplier_payments` | 2 | **16** | pagos de centros nuevos invisibles |
| `analytics.erp_collections` | 2 | **11** | cobranza de plazas nuevas invisible |
| `finance.kepler_accounts` | 1 | 3 | las cuentas nuevas no existen para la app |

`analytics.erp_goods_receipts` **ya se corrigió** el 1-oct (`[DM.19.3]`), y de ahí sale el patrón:

```sql
-- quitar:  AND sucursal = '00' AND btrim(c1) = '00'
-- poner:   AND btrim(c1) = sucursal
```

⭐ **No lleva fecha de corte**, a propósito: mientras el `00` concentraba, esos documentos traían
`c1 = '00'`, así que la condición se cumple en las dos eras. Una variante con fecha metería la
constante en seis lugares **y** clasificaría mal, porque `kdm1.c9` puede venir con fecha futura
(medido: hasta 2026-12-31); la columna de ventanas es `c68`.

⛔ **El cabo suelto que decide el orden del trabajo:** el filtro y la **ingesta** producen la misma
pantalla vacía. Si la réplica de las plazas nuevas no está en el carril, desanclar las vistas no
cambia nada. **El script mide las dos cosas.** Si da cero documentos fuera del `00`, el problema
no es el filtro y el plan cambia entero.

⚠️ **Hay dos sesiones más en este corte** — `IC.CEDIS.1–12` (inventario) y `DM.19` (origen de
plaza). Esto se queda en **documentos** y no entra ahí. Coordinar antes de tocar.

Plan completo: [`FASE_PO_POST_CORTE_01OCT.md`](../FASES/FASE_PO_POST_CORTE_01OCT.md)

---

## 3 · ¿Qué vales de gasto tienen su CFDI?

```bash
node database/scripts/buscar-vales-con-cfdi.js
#   --dias=5   tolerancia de fecha   ·   --tol=0.50   tolerancia de importe
```

**La respuesta corta, ya medida sobre el esquema: Kepler NO guarda el CFDI.** El vale lleva el
RFC del acreedor (`kdm1.c22`) y el IVA, pero no hay UUID en su cadena. El CFDI vive en
`fiscal.cfdis`, que se llena del ADD de ContPAQi, no de Kepler.

Así que «el vale con su CFDI» **se deriva** por `RFC + importe + ventana de fecha`.

⭐ **El script mide su propio ruido.** Corre el mismo cruce contra una ventana desplazada un año,
donde no puede haber relación, y publica la **señal = real − placebo**. Un cruce por importe sin
piso de ruido no significa nada — en este ERP ya se midió **23–34 % de aciertos por puro azar**.
Si el ruido supera la mitad del match, el script lo dice y se niega a presentar el porcentaje.

**Lo primero que hay que mirar:** cuántos vales traen RFC. Es el único puente; si viene vacío el
cruce es sólo ruido.

---

## Cómo se comportan los tres si no pueden medir

Los tres imprimen **`NO MEDIDO`** y salen, en vez de un cero. «No encontré nada» y «está bien» no
son lo mismo — un cero acá se leería como «ningún vale tiene CFDI» o «ninguna vista está
anclada», que es lo contrario de lo que sabemos.

---

## Lo que NO necesita a Kepler

Ya está hecho, probado y **mergeado a `main`** (PR #242): el Expediente por persona con el protocolo forzoso, la
bandeja de aprobación limpia, la letra más grande, y dos defectos que aparecieron al usarlo. Sin
migraciones y sin permisos nuevos → **no hace falta re-login**, sólo redeploy de api+view.
