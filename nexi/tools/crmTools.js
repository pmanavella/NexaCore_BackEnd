const nexiDatos = require('../services/nexiDatos');
const { PARAM_MES, PARAM_ANIO, resolverMes } = require('./comunes');

// Herramientas de CRM: solo conteos. Nunca nombres, empresas, emails,
// teléfonos ni notas de contactos.

const TIPOS = ['Cliente', 'Prospecto', 'Proveedor', 'Socio'];
const ESTADOS = ['Activo', 'Inactivo', 'En negociación'];

const metricasCrm = {
  nombre: 'metricas_crm',
  descripcion: 'Cantidad de contactos del CRM por tipo (Cliente, Prospecto, Proveedor, Socio) y por estado. Con mes/anio cuenta solo los contactos creados en ese mes; sin parámetros = todos.',
  parametros: {
    type: 'object',
    properties: { mes: PARAM_MES, anio: PARAM_ANIO },
    additionalProperties: false,
  },
  requisitos: [{ modulo: 'crm', permiso: 'lector' }],
  alcance: 'AGREGADA',
  async handler(args, { hoy }) {
    const conPeriodo = args.mes !== undefined || args.anio !== undefined;
    const periodo = conPeriodo ? resolverMes(args, hoy) : null;
    // contactos.created_at es timestamptz: se ancla a UTC, igual que crmService.
    const rango = periodo
      ? { desde: `${periodo.desde}T00:00:00.000Z`, hasta: `${periodo.hasta}T00:00:00.000Z` }
      : {};

    const [total, porTipo, porEstado] = await Promise.all([
      nexiDatos.contarContactos(rango),
      Promise.all(TIPOS.map(tipo => nexiDatos.contarContactos({ ...rango, tipo }))),
      Promise.all(ESTADOS.map(estado => nexiDatos.contarContactos({ ...rango, estado }))),
    ]);

    return {
      periodo: periodo ? { clave: periodo.clave, criterio: 'contactos creados en el mes' } : 'todos los contactos',
      total,
      por_tipo: Object.fromEntries(TIPOS.map((t, i) => [t, porTipo[i]])),
      por_estado: Object.fromEntries(ESTADOS.map((e, i) => [e, porEstado[i]])),
    };
  },
};

module.exports = [metricasCrm];
