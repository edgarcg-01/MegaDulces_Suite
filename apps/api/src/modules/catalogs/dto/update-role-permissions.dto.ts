/**
 * Mapa de permisos `{ [PERMISSION_KEY]: boolean }`. La whitelist contra el
 * enum `Permission` se aplica en el service para evitar guardar claves
 * arbitrarias en el JSONB. El DTO documenta la forma esperada.
 *
 * Nota: los decoradores de TS no son válidos sobre index signatures, así que
 * no podemos usar `@ApiProperty` aquí. La forma queda documentada en este
 * JSDoc; Swagger lo verá como objeto libre.
 */
export class UpdateRolePermissionsDto {
  [permission: string]: boolean | undefined;
}
