const supabase = require('../../config/supabase');
const { resolverPeriodo, rangoMes } = require('../../utils/periodo');

const TIPOS_VALIDOS   = ['Cliente', 'Prospecto', 'Proveedor', 'Socio'];
const ESTADOS_VALIDOS = ['Activo', 'Inactivo', 'En negociación'];
const WHITELIST       = ['nombre', 'empresa', 'email', 'telefono', 'tipo', 'estado',
                         'notas', 'ultimo_contacto', 'proximo_contacto'];

// Strings vacíos o solo espacios → null. Mismo patrón que
// 2026-07-05_fix_optional_employee_contact_unique_constraints.
function norm(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

// Valida que val sea null/undefined/string vacío, o una fecha real en formato
// YYYY-MM-DD. Rechaza fechas inexistentes como 2026-02-30.
function validarFecha(val, campo) {
  if (val === null || val === undefined || val === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val))
    throw Object.assign(
      new Error(`${campo}: formato inválido, se espera YYYY-MM-DD`),
      { status: 400 }
    );
  const d = new Date(`${val}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== val)
    throw Object.assign(
      new Error(`${campo}: fecha inexistente (${val})`),
      { status: 400 }
    );
  return val;
}

// Elimina caracteres que rompen la sintaxis .or() de PostgREST.
function sanitizarSearch(s) {
  return s.replace(/[%,()]/g, '');
}

class CrmService {
  async listarContactos({ tipo, estado, search, orden } = {}) {
    let query = supabase.from('contactos').select('*');

    if (tipo && tipo !== 'Todos')     query = query.eq('tipo', tipo);
    if (estado && estado !== 'Todos') query = query.eq('estado', estado);
    if (search) {
      const s = sanitizarSearch(search.trim());
      if (s) query = query.or(`nombre.ilike.%${s}%,empresa.ilike.%${s}%,email.ilike.%${s}%`);
    }

    if (orden === 'proximo_contacto') {
      query = query.order('proximo_contacto', { ascending: true, nullsFirst: false });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;
    return { data, total: data.length };
  }

  async crearContacto(body) {
    const nombre           = norm(body.nombre);
    const empresa          = norm(body.empresa);
    const email            = norm(body.email);
    const telefono         = norm(body.telefono);
    const notas            = norm(body.notas);
    const tipo             = norm(body.tipo);
    const estado           = norm(body.estado);
    const ultimo_contacto  = validarFecha(body.ultimo_contacto,  'ultimo_contacto');
    const proximo_contacto = validarFecha(body.proximo_contacto, 'proximo_contacto');

    if (!nombre)
      throw Object.assign(new Error('El nombre es obligatorio'), { status: 400 });
    if (tipo && !TIPOS_VALIDOS.includes(tipo))
      throw Object.assign(
        new Error(`Tipo inválido. Valores permitidos: ${TIPOS_VALIDOS.join(', ')}`),
        { status: 400 }
      );
    if (estado && !ESTADOS_VALIDOS.includes(estado))
      throw Object.assign(
        new Error(`Estado inválido. Valores permitidos: ${ESTADOS_VALIDOS.join(', ')}`),
        { status: 400 }
      );

    const { data, error } = await supabase
      .from('contactos')
      .insert([{
        nombre, empresa, email, telefono, notas,
        tipo:             tipo   || 'Cliente',
        estado:           estado || 'Activo',
        ultimo_contacto,
        proximo_contacto,
      }])
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async actualizarContacto(id, body) {
    const campos = {};
    for (const key of WHITELIST) {
      if (!(key in body)) continue;
      if (key === 'ultimo_contacto' || key === 'proximo_contacto') {
        campos[key] = validarFecha(body[key], key);
      } else {
        campos[key] = norm(body[key]);
      }
    }

    if (Object.keys(campos).length === 0)
      throw Object.assign(new Error('No se enviaron campos para actualizar'), { status: 400 });

    if ('nombre' in campos && !campos.nombre)
      throw Object.assign(new Error('El nombre no puede quedar vacío'), { status: 400 });
    if ('tipo' in campos) {
      if (!campos.tipo)
        throw Object.assign(new Error('El tipo no puede quedar vacío'), { status: 400 });
      if (!TIPOS_VALIDOS.includes(campos.tipo))
        throw Object.assign(
          new Error(`Tipo inválido. Valores permitidos: ${TIPOS_VALIDOS.join(', ')}`),
          { status: 400 }
        );
    }
    if ('estado' in campos) {
      if (!campos.estado)
        throw Object.assign(new Error('El estado no puede quedar vacío'), { status: 400 });
      if (!ESTADOS_VALIDOS.includes(campos.estado))
        throw Object.assign(
          new Error(`Estado inválido. Valores permitidos: ${ESTADOS_VALIDOS.join(', ')}`),
          { status: 400 }
        );
    }

    const { data, error } = await supabase
      .from('contactos')
      .update(campos)
      .eq('id', id)
      .select()
      .single();
    if (error) {
      if (error.code === 'PGRST116')
        throw Object.assign(new Error('Contacto no encontrado'), { status: 404 });
      throw error;
    }
    return data;
  }

  async eliminarContacto(id) {
    const { error } = await supabase
      .from('contactos')
      .delete()
      .eq('id', id)
      .select('id')
      .single();
    if (error) {
      if (error.code === 'PGRST116')
        throw Object.assign(new Error('Contacto no encontrado'), { status: 404 });
      throw error;
    }
    return { message: 'Contacto eliminado correctamente' };
  }

  // mes/anio son opcionales: si no llegan, se mantiene el comportamiento histórico
  // (métricas sobre todos los contactos, sin filtrar por fecha).
  async getMetricas({ mes, anio } = {}) {
    let query = supabase.from('contactos').select('tipo, estado');

    const periodoProvisto = (mes ?? '') !== '' || (anio ?? '') !== '';
    if (periodoProvisto) {
      const { mes: targetMes, anio: targetAnio } = resolverPeriodo(mes, anio);
      const { desde, hasta } = rangoMes(targetMes, targetAnio);
      // contactos.created_at es timestamptz: se ancla explícitamente a UTC para no depender
      // de la zona horaria de la sesión.
      query = query.gte('created_at', `${desde}T00:00:00.000Z`).lt('created_at', `${hasta}T00:00:00.000Z`);
    }

    const { data, error } = await query;
    if (error) throw error;
    const total      = data.length;
    const clientes   = data.filter(c => c.tipo === 'Cliente').length;
    const prospectos = data.filter(c => c.tipo === 'Prospecto').length;
    const proveedores= data.filter(c => c.tipo === 'Proveedor').length;
    return { total, clientes, prospectos, proveedores };
  }
}

module.exports = new CrmService();