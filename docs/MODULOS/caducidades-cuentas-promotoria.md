# Comercial › Caducidades — cuentas de promotoría por marca y zona (P2.6.13)

## Problema

Las promotoras de las marcas (gente del proveedor que trabaja en la sucursal) revisan caducidades, pero no tenían cómo
capturarlas en la Suite. Darles un perfil existente de empleado (`promotor_ruta`) les abría precios, clientes, pedidos y gastos.

## Solución

- Una cuenta por **marca y zona**: 40 marcas × 3 zonas = 120 cuentas, `promo.<marca>.<zona>` (`lp` La Piedad, `zam` Zamora, `mor` Morelia).
  La comparten las promotoras de esa marca en esa zona.
- Cada cuenta ve **sólo Caducidades** y captura en **las sucursales de su zona** (al capturar elige la sucursal; el servidor no le deja escribir fuera).
- Departamento `externo`, para distinguirlas del personal.

## Cómo se implementó

- Sin migración ni perfil nuevo: `database/scripts/alta-promotoras-marca.js` crea cada cuenta **por la API** (mismas validaciones, hash y bitácora que /admin/users):
  perfil `etiquetas_anaquel` (el más chico) + permisos propios que dejan sólo `COMMERCIAL_EXPIRY_CAPTURAR` + alcance propio de sucursal `listed` con las de su zona.
- Después de cada alta lee lo **efectivo** (permisos y sucursales) y se detiene si no cuadra. Es repetible: una cuenta que ya es de promotoría se retoma; si el usuario es de otra persona, no se toca.
- `--solo <usuario>` crea una sola cuenta para entrar con ella antes de crear el resto. Sin `--aplicar` sólo revisa.
- La entrada (CSV) y el PDF de consulta con los usuarios viven fuera del repo (es público). La contraseña va sólo en `PASSWORD_INICIAL` al correrlo.

## Por qué así

- **Por API y no por INSERT:** las cuentas pasan por el mismo camino que un alta a mano.
- **Por marca y no por persona:** decisión de la operación; se sabe qué marca capturó, no qué promotora.
- **Sin limitar por marca por ahora:** sólo 12 de 40 nombres coinciden exacto con la tabla de marcas (mezcla marcas y razones sociales).
  Consecuencia aceptada: cada cuenta ve en Caducidades las hojas de toda su zona, también las de otras marcas. Se puede limitar después con `marcas` en la entrada.
- ⚠️ **Contraseña común sin cambio obligatorio** (la web hoy no lo exige ni tiene pantalla para cambiarla): una marca puede entrar con la cuenta de otra. Riesgo a confirmar con Edgar; si una marca deja de venir, se desactiva su cuenta.
