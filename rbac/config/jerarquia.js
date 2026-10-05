// Relación rol funcional → nivel jerárquico interno.
//
// Fuente de verdad: columna public.roles.nivel_jerarquico
// (migración 2026-10-05_roles_nivel_jerarquico.sql). Este módulo es el único
// lugar del backend que interpreta esa relación: el resto del código debe usar
// resolverNivelJerarquico() / NIVELES_JERARQUICOS en vez de comparar nombres de rol.

const NIVELES_JERARQUICOS = Object.freeze({
  HIGH:   'HIGH',   // Mando alto
  MEDIUM: 'MEDIUM', // Mando medio
  LOW:    'LOW',    // Mando bajo
  NONE:   'NONE',   // Sin mando (externos)
});

// Roles definitivos seleccionables (deben coincidir con public.roles.nombre).
const ROLES = Object.freeze({
  SUPERADMIN: 'Superadmin',
  DIRECCION:  'Dirección',
  COMERCIAL:  'Comercial',
  CONTABLE:   'Contable',
  OPERATIVO:  'Operativo',
  AUDITOR:    'Auditor / Lector',
  PASANTE:    'Pasante',
  EXTERNO:    'Externo',
});

// Respaldo por nombre: solo se usa cuando la fila de roles todavía no trae
// nivel_jerarquico (backend desplegado antes de correr la migración). Debe
// coincidir con el backfill de la migración. Incluye los roles legacy mientras
// existan usuarios que los tengan asignados.
const NIVEL_POR_ROL = Object.freeze({
  [ROLES.SUPERADMIN]: NIVELES_JERARQUICOS.HIGH,
  [ROLES.DIRECCION]:  NIVELES_JERARQUICOS.HIGH,
  [ROLES.COMERCIAL]:  NIVELES_JERARQUICOS.MEDIUM,
  [ROLES.CONTABLE]:   NIVELES_JERARQUICOS.LOW,
  [ROLES.OPERATIVO]:  NIVELES_JERARQUICOS.LOW,
  [ROLES.AUDITOR]:    NIVELES_JERARQUICOS.LOW,
  [ROLES.PASANTE]:    NIVELES_JERARQUICOS.LOW,
  [ROLES.EXTERNO]:    NIVELES_JERARQUICOS.NONE,
  // Legacy
  'Director':    NIVELES_JERARQUICOS.HIGH,
  'Operario':    NIVELES_JERARQUICOS.LOW,
  'Mando Medio': NIVELES_JERARQUICOS.MEDIUM,
});

// Recibe la fila de roles ({ nombre, nivel_jerarquico }) o solo el nombre.
// Devuelve null si no hay rol. Un rol desconocido sin nivel cargado se trata
// como LOW (mismo criterio que la migración: nunca otorga privilegios de mando).
function resolverNivelJerarquico(rol) {
  if (!rol) return null;
  const fila = typeof rol === 'string' ? { nombre: rol } : rol;
  if (NIVELES_JERARQUICOS[fila.nivel_jerarquico]) return fila.nivel_jerarquico;
  if (!fila.nombre) return null;
  return NIVEL_POR_ROL[fila.nombre] ?? NIVELES_JERARQUICOS.LOW;
}

// Un rol sin columna `activo` (antes de la migración) se considera seleccionable.
function rolEsSeleccionable(rol) {
  return !!rol && rol.activo !== false;
}

module.exports = {
  NIVELES_JERARQUICOS,
  ROLES,
  resolverNivelJerarquico,
  rolEsSeleccionable,
};
