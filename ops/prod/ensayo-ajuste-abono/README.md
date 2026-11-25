# Ensayo del Ajuste Abono `U-A-30` en el Kepler vivo (`[GP.R.3]`)

Escribe un Ajuste Abono **de verdad** contra Kepler —folio del contador real, encabezado clonado, renglón de cartera
y una aplicación por factura— comprueba que el saldo de la factura baja lo aplicado, y **lo deshace**. El `ROLLBACK`
es **incondicional, en `finally`**: no hay ningún camino que confirme. Mismo empaquetado que los otros ensayos
(`ops/prod/ensayo-nota-kepler/README.md`): Kepler sólo acepta a `kepler_push` desde `md`.

Anexo: [`FASE_GP_ANEXO_RESTOS_DE_COBRO.md`](../../../docs/IMPLEMENTACION/FASES/FASE_GP_ANEXO_RESTOS_DE_COBRO.md).

## ⛔ Lo que este ensayo NO puede descubrir

Medido el 2026-11-24: `kdm1`, `kdm5`, `kdud`, `kdue` y `sqliov` tienen **cero disparadores**. Todo lo hace el
programa de Kepler. Así que **lo que la aplicación mueve al postear un ajuste —acumulados, póliza— no se ve acá**:
lo movería ella, y en el ensayo no participa. Eso se mira sobre un ajuste **real capturado por una persona**, con
foto antes/después por `xmin`. Acá se prueban **permisos, folio, llaves, `rowCount` y el efecto en el saldo**.

## Antes

1. El permiso: [`ops/prod/kepler-grants/gpr0c_ajuste_abono.sql`](../kepler-grants/gpr0c_ajuste_abono.sql)
   (aplicado el 2026-11-24 en 8 de 9; CEDIS sin `pg_hba` para `sa`). Sin él termina en «permiso denegado», y eso
   también es un resultado.
2. Una **plantilla**: un `U-A-30` vivo en ese servidor, con su renglón de `kdue` y al menos una aplicación de
   `kdm5`. Sin plantilla el ensayo se niega — no inventa un documento.
3. Un **resto real**: sucursal, cliente, y la factura con su resto (de `analytics.customer_receivables_current`).

## Cómo se corre

La URL **se queda en `md`**: se lee del secreto ahí y se le pasa al contenedor por stdin.

```bash
node ops/prod/ensayo-ajuste-abono/empaquetar.js /tmp/ensayo-rc.cjs     # no lleva credenciales
scp /tmp/ensayo-rc.cjs superoot@192.168.0.222:/tmp/ensayo-rc.cjs
ssh superoot@192.168.0.222 'bash -s' <<'EOF'
U=$(kubectl -n prod get secret kepler-push -o "jsonpath={.data.KEPLER_PUSH_URL_08}" | base64 -d)
J='{"sucursal":"08","cliente":"C2043","facturas":[{"tipo":8,"serie":1,"folio":"0000470","monto":7.20}]}'
{ echo "$U"; echo "$J"; } | docker run --rm -i --network host \
  -v /tmp/ensayo-rc.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs
EOF
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-rc.cjs'
```

## Cómo se lee

- `ANTES`: el saldo de cada factura y el contador, con su propia conexión.
- `pasos`: cada operación con sus filas. Los tres `INSERT INTO md.*` tienen que dar **1** (o N aplicaciones).
- `contador`: `contadorAntes`, el `maximo` y si venía **atrasado** (síntoma del KR, se registra).
- `saldos_dentro`: el saldo **dentro** de la transacción. Para un resto cerrado completo tiene que dar **0.00**.
- La última línea es el **control**, con una tercera conexión: documentos del ensayo = **0**, contador **IGUAL** y
  saldos **IGUALES**. Si algo cambió sale con código 2 y hay que avisar a quien administra Kepler.
- Código 3 = el ensayo falló por dentro pero **el control pasó** (no se escribió nada). Es un resultado útil.

## Lo que ya encontró (2026-11-24, Morelia Abastos)

✅ **Pasó de punta a punta**: folio `0000002` del contador real (antes 2, máximo 1, no atrasado) · encabezado,
`kdue` y `kdm5` escritos (1 fila cada uno) · **el saldo de la factura `8-1-0000470` pasó de $7.20 a $0.00** ·
control: 0 documentos, contador igual, saldos iguales.

Y dos restricciones reales que sólo aparecen escribiendo, las dos **cazadas sin escribir nada**:

| | Lo que pasó | La lección para el adaptador (GP.R.3) |
|---|---|---|
| 1 | `llave duplicada viola pk_kdm1` al clonar **directo** a `md.kdm1` | ⛔ `clonarFila` **inserta y después pisa**, así que el folio de la plantilla entra tal cual y choca. Hay que **armar en una temporal sin llave** y volcar a `md` al final — es el patrón de `kepler-nota-sink.adapter.ts` (`_h0` → `_h` → `md`) |
| 2 | `el valor es demasiado largo para character varying(20)` | ⛔ **`kdm1.c11` es `varchar(20)`**: la llave de idempotencia de la Suite **tiene que caber en 20 caracteres** |
