const supabase = require('../../config/supabase');
const { resolverPeriodo, rangoMes } = require('../../utils/periodo');
const {
  TIPOS_BASE, TIPOS_BASE_CERRADOS, TIPOS_BASE_FINALES, ESTADO_CANONICO_POR_TIPO_BASE,
  esTareaAbierta, esTareaFinal, esVisibleEnKanban,
} = require('../config/etapas');
const tareaAsignados = require('./tareaAsignados');
const tablerosService = require('./tablerosService');

// Columnas que devuelven los endpoints de tareas: la tarea, su etapa y sus asignados.
const SELECT_TAREA = `*, operativo_etapas(id, nombre, color, tipo_base, posicion), ${tareaAsignados.SELECT_ASIGNADOS}`;

// Campos de la tabla `tareas` que se auditan en tarea_historial.
// Cualquier cambio en estos campos genera un registro automático.
const CAMPOS_AUDITABLES = [
  'titulo', 'descripcion', 'estado', 'prioridad', 'asignado_a', 'fecha_limite',
  'fecha_inicio_planeada', 'fecha_inicio_real', 'fecha_fin_real',
];

// Campos de `tareas` que el cliente puede modificar con PUT /tareas/:id. Los
// demás se ignoran (el frontend reenvía el formulario completo, con tipo,
// propuesto_por y estado_propuesta incluidos):
//   - estado, fecha_inicio_real, fecha_fin_real: los deriva etapa_id.
//   - tipo, estado_propuesta, propuesto_por: solo cambian al crear la tarea o
//     al aprobar/rechazar la propuesta.
//   - asignado_a y asignados: se procesan aparte (ver actualizarTarea).
//   - tablero_id: no cambia (400 si se intenta).
//   - id, created_at y cualquier otro campo interno.
const CAMPOS_EDITABLES = [
  'titulo', 'descripcion', 'prioridad', 'etapa_id', 'fecha_limite', 'fecha_inicio_planeada',
];

const TIPOS_TAREA = ['asignacion', 'propuesta'];

// Valores de `vista` en GET /tareas (ver listarTareas).
const VISTAS_TAREAS = ['kanban', 'historial'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// La columna `estado` tiene un CHECK en la base que solo permite 4 valores
// (Pendiente, En Proceso, Completada, Cancelada; preexistente, no forma parte de la migración de etapas). Con etapas personalizables
// el nombre de la etapa puede ser cualquier texto, así que `estado` deja de reflejar el
// nombre literal de la etapa y pasa a reflejar el equivalente canónico de su tipo_base.
// Esto es lo que sigue usando Nexi (nexi/tools/operativoTools.js), que no se tocó.
// El mapeo tipo_base -> estado vive en operations/config/etapas.js.

// Normaliza valores para comparación: null, undefined y '' se tratan igual (sin valor).
// Evita falsos positivos cuando el frontend envía '' y la BD tiene null.
function normalizar(v) {
  return (v == null || v === '') ? '' : String(v);
}

// Agrega `dias_trabajo` (calculado, no se persiste) a una tarea: días corridos entre
// fecha_inicio_real y fecha_fin_real, ambas fechas incluidas. null si falta alguna.
function conDiasTrabajo(tarea) {
  if (!tarea) return tarea;
  let dias_trabajo = null;
  if (tarea.fecha_inicio_real && tarea.fecha_fin_real) {
    const inicio = new Date(tarea.fecha_inicio_real);
    const fin = new Date(tarea.fecha_fin_real);
    dias_trabajo = Math.round((fin - inicio) / 86400000) + 1;
  }
  return { ...tarea, dias_trabajo };
}

function error400(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

// solo_mias / solo_abiertas llegan por query string ("true"/"1") o como boolean.
function esVerdadero(v) {
  return v === true || v === 'true' || v === '1';
}

// Autor de un registro de tarea_historial: siempre el usuario autenticado,
// nunca datos del body. 'Sistema' solo cuando no hay sesión (llamadas internas).
function autor(user) {
  return { usuario_id: user?.id ?? null, usuario_nombre: user?.name || 'Sistema' };
}

function error409(mensaje) {
  return Object.assign(new Error(mensaje), { status: 409 });
}

// Ids de las tareas donde el usuario autenticado es responsable (filtro
// "Solo mis tareas"). Sin usuario, ninguna.
async function idsTareasPropias(user) {
  return user?.id ? tareaAsignados.idsTareasDePersona({ usuarioIds: [user.id] }) : [];
}

// Forma de respuesta de una tarea: asignados aplanados + dias_trabajo.
function formatearTarea(tarea) {
  return conDiasTrabajo(tareaAsignados.conAsignados(tarea));
}

class OperationsService {

  // ── Historial ──────────────────────────────────────────────────────────────

  // Inserta uno o más registros en tarea_historial.
  // Recibe un array de objetos con la estructura completa de la tabla.
  // No lanza error si falla — el historial no debe interrumpir la operación principal.
  async _registrarHistorial(entradas) {
    if (!entradas || entradas.length === 0) return;
    const { error } = await supabase.from('tarea_historial').insert(entradas);
    if (error) console.error('[Historial] Error al registrar:', error.message);
  }

  // Devuelve todo el historial de una tarea ordenado del más reciente al más antiguo.
  // Usado por GET /api/operations/tareas/:id/historial
  async obtenerHistorial(tarea_id, user) {
    await this._asegurarAccesoTarea(tarea_id, user);
    const { data, error } = await supabase
      .from('tarea_historial')
      .select('*')
      .eq('tarea_id', tarea_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  }

  // ── Tareas ─────────────────────────────────────────────────────────────────

  // Devuelve la etapa a usar para una tarea: la indicada por etapa_id, o si no
  // se mandó ninguna, la primera etapa (menor posición) de tipo_base 'pendiente'.
  async _resolverEtapa(etapa_id) {
    let query = supabase.from('operativo_etapas').select('id, nombre, color, tipo_base, posicion');
    query = etapa_id
      ? query.eq('id', etapa_id)
      : query.eq('tipo_base', 'pendiente').order('posicion', { ascending: true }).limit(1);

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) {
      throw Object.assign(
        new Error(etapa_id ? 'La etapa indicada no existe' : 'No hay ninguna etapa inicial configurada (tipo_base=pendiente)'),
        { status: 400 }
      );
    }
    return data[0];
  }

  // Completa fecha_inicio_real / fecha_fin_real en `campos` según el tipo_base de la
  // nueva etapa, solo si esa tarea todavía no las tenía cargadas (no se pisan fechas
  // reales ya registradas si la tarea vuelve a pasar por la misma etapa más adelante).
  // `actual` es la tarea tal como está hoy en la base (o un objeto vacío si es un alta).
  _aplicarFechasAutomaticas(campos, etapa, actual) {
    const hoy = new Date().toISOString().slice(0, 10);
    if (etapa.tipo_base === 'en_curso' && !actual.fecha_inicio_real) {
      campos.fecha_inicio_real = hoy;
    }
    if (etapa.tipo_base === 'completada' && !actual.fecha_fin_real) {
      campos.fecha_fin_real = hoy;
    }
  }

  // Mantiene tareas.fecha_finalizacion (Kanban de 7 días, migración
  // 2026-11-03_tareas_fecha_finalizacion) al pasar a `etapa`:
  //   - a un tipo_base final (completada/cancelada) desde otro tipo_base: ahora
  //     (reabrir y volver a finalizar reinicia el plazo);
  //   - a un tipo_base no final: NULL (solo si tenía fecha);
  //   - a la misma etapa u otra del mismo tipo_base final: sin cambios.
  // `actual` es la tarea en la base (objeto vacío si es un alta).
  async _aplicarFechaFinalizacion(campos, etapa, actual) {
    if (!TIPOS_BASE_FINALES.includes(etapa.tipo_base)) {
      if (actual.fecha_finalizacion) campos.fecha_finalizacion = null;
      return;
    }
    if (actual.etapa_id === etapa.id) return;
    let tipoBaseAnterior = null;
    if (actual.etapa_id) {
      const { data, error } = await supabase.from('operativo_etapas').select('tipo_base').eq('id', actual.etapa_id).maybeSingle();
      if (error) throw error;
      tipoBaseAnterior = data?.tipo_base ?? null;
    }
    if (tipoBaseAnterior !== etapa.tipo_base) campos.fecha_finalizacion = new Date().toISOString();
  }

  // Restringe `query` a las tareas de una persona (incluye tareas compartidas).
  // asignado_id = usuario_id; asignado_a = nombre (filtro legacy, ver tareaAsignados).
  // Devuelve null si la persona no tiene tareas.
  async _filtrarPorPersona(query, { asignado_id, asignado_a }) {
    if (!asignado_id && !asignado_a) return query;
    const ids = await tareaAsignados.idsTareasDePersona({
      usuarioIds: asignado_id ? [asignado_id] : [],
      nombre: asignado_a,
    });
    return ids.length ? query.in('id', ids) : null;
  }

  // Lee una tarea con su etapa y asignados, con la forma de respuesta de la API.
  async _obtenerTarea(id) {
    const { data, error } = await supabase.from('tareas').select(SELECT_TAREA).eq('id', id).single();
    if (error) throw error;
    return formatearTarea(data);
  }

  // ── Tableros ───────────────────────────────────────────────────────────────

  // Lee la tarea y verifica que el usuario pueda ver su tablero. Las tareas sin
  // tablero (creadas por un backend anterior a los tableros) solo las ve el
  // mando alto. Devuelve la fila de la tarea. 404 si no existe.
  async _asegurarAccesoTarea(id, user) {
    const { data: tarea, error } = await supabase.from('tareas').select('*').eq('id', id).maybeSingle();
    if (error) {
      if (error.code === '22P02') throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });
      throw error;
    }
    if (!tarea) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });

    if (tarea.tablero_id) {
      await tablerosService.asegurarAcceso(tarea.tablero_id, user);
    } else if (!tablerosService.esMandoAlto(user)) {
      throw Object.assign(new Error('No tenés acceso a esta tarea.'), { status: 403 });
    }
    return tarea;
  }

  // Los responsables que se agregan a una tarea deben ser miembros de su
  // tablero. `actuales` (en una edición) pueden mantenerse aunque ya no sean
  // miembros: quitar a alguien del tablero no le quita sus tareas.
  async _validarResponsablesMiembros(tableroId, ids, actuales = []) {
    const nuevos = ids.filter(id => !actuales.includes(id));
    if (!nuevos.length) return;
    const miembros = await tablerosService.idsMiembros(tableroId);
    const noMiembros = nuevos.filter(id => !miembros.includes(id));
    if (noMiembros.length) {
      throw error400(`El responsable debe ser miembro del tablero (no son miembros: ${noMiembros.join(', ')}).`);
    }
  }

  // Asignación legacy por nombre (`asignado_a`): con tableros, el nombre tiene
  // que identificar a un único usuario para poder verificar que sea miembro.
  async _resolverAsignadoLegacyEnTablero(asignado_a, tableroId, actuales = []) {
    const asignacion = await tareaAsignados.resolverAsignadoLegacy(asignado_a);
    if (asignacion.texto) {
      throw error400(`El responsable debe ser miembro del tablero: "${asignacion.texto}" no corresponde a un único usuario.`);
    }
    await this._validarResponsablesMiembros(tableroId, asignacion.ids, actuales);
    return asignacion;
  }

  // ── Tareas: listado y CRUD ─────────────────────────────────────────────────

  // Solo devuelve tareas directas (tipo = 'asignacion') — las propuestas van por su propio endpoint.
  // `tablero_id` es obligatorio y el usuario tiene que poder ver ese tablero.
  // `solo_mias` (opcional): solo las tareas donde el usuario es responsable.
  // `solo_abiertas` (opcional): solo las tareas en etapas abiertas (ver esTareaAbierta).
  // `vista` (opcional):
  //   - sin valor: todas las tareas (comportamiento histórico del endpoint).
  //   - 'kanban': oculta las completadas/canceladas hace 168 horas o más
  //     (ver esVisibleEnKanban); las que no tienen fecha confiable se muestran.
  //   - 'historial': solo las completadas/canceladas, sin límite de tiempo.
  // Se combinan entre sí y con el resto de los filtros (AND).
  async listarTareas({ estado, prioridad, asignado_a, asignado_id, etapa_id, tablero_id, solo_mias, solo_abiertas, vista } = {}, user) {
    if (vista != null && vista !== '' && !VISTAS_TAREAS.includes(vista)) {
      throw error400(`"vista" inválida: debe ser ${VISTAS_TAREAS.join(' o ')}.`);
    }
    await tablerosService.asegurarAcceso(tablero_id, user);

    let query = supabase
      .from('tareas')
      .select(SELECT_TAREA)
      .eq('tablero_id', tablero_id)
      .or('tipo.is.null,tipo.eq.asignacion')
      .order('created_at', { ascending: false });

    if (estado    && estado    !== 'Todos') query = query.eq('estado',    estado);
    if (prioridad && prioridad !== 'Todos') query = query.eq('prioridad', prioridad);
    if (etapa_id)   query = query.eq('etapa_id',   etapa_id);
    if (esVerdadero(solo_mias)) query = query.in('id', await idsTareasPropias(user));
    query = await this._filtrarPorPersona(query, { asignado_id, asignado_a });
    if (!query) return { data: [], total: 0 };

    const { data, error } = await query;
    if (error) throw error;
    let tareas = esVerdadero(solo_abiertas) ? data.filter(esTareaAbierta) : data;
    if (vista === 'kanban') {
      const ahora = Date.now();
      tareas = tareas.filter(t => esVisibleEnKanban(t, ahora));
    } else if (vista === 'historial') {
      tareas = tareas.filter(esTareaFinal);
    }
    return { data: tareas.map(formatearTarea), total: tareas.length };
  }

  // Crea una tarea nueva y registra el evento 'creacion' en tarea_historial
  // (autor: el usuario autenticado; usuario_nombre/usuario_id del body se ignoran).
  // `asignados` (array de usuario_id) define las personas asignadas; si no viene,
  // se acepta el `asignado_a` (nombre) histórico por compatibilidad.
  // `tablero_id` es obligatorio, el usuario tiene que poder ver ese tablero y
  // los responsables tienen que ser miembros.
  // `tipo` ('asignacion' por defecto o 'propuesta'): una propuesta nace siempre
  // pendiente y propuesta por el usuario autenticado; una asignación, sin datos
  // de propuesta. estado_propuesta y propuesto_por del body se ignoran.
  async crearTarea(body, user) {
    const {
      titulo, descripcion, prioridad, asignado_a, asignados, fecha_limite,
      etapa_id, fecha_inicio_planeada, tablero_id,
    } = body;
    const tipo = body.tipo || 'asignacion';
    if (!titulo) throw Object.assign(new Error('El título es obligatorio'), { status: 400 });
    if (!TIPOS_TAREA.includes(tipo)) throw error400(`"tipo" inválido: debe ser ${TIPOS_TAREA.join(' o ')}.`);
    const esPropuesta = tipo === 'propuesta';

    await tablerosService.asegurarAcceso(tablero_id, user);

    let asignacion;
    if (asignados !== undefined) {
      asignacion = { ids: await tareaAsignados.validarAsignados(asignados), texto: null };
      await this._validarResponsablesMiembros(tablero_id, asignacion.ids);
    } else {
      asignacion = await this._resolverAsignadoLegacyEnTablero(asignado_a, tablero_id);
    }

    const etapa = await this._resolverEtapa(etapa_id);

    const nuevaTarea = {
      titulo,
      descripcion,
      estado:                 ESTADO_CANONICO_POR_TIPO_BASE[etapa.tipo_base],
      etapa_id:                etapa.id,
      tablero_id,
      prioridad:               prioridad        || 'Media',
      // Con asignados vinculados, la sincronización completa este texto.
      asignado_a:              asignacion.texto,
      fecha_limite,
      fecha_inicio_planeada:   fecha_inicio_planeada || null,
      tipo,
      propuesto_por:           esPropuesta ? (user?.name || null) : null,
      estado_propuesta:        esPropuesta ? 'pendiente' : null,
    };
    // Si la tarea nace directamente en una etapa "en curso" o "completada"
    // (ej. se carga una tarea que ya se venía haciendo), completar sus fechas reales.
    this._aplicarFechasAutomaticas(nuevaTarea, etapa, {});
    await this._aplicarFechaFinalizacion(nuevaTarea, etapa, {});

    const { data: creada, error } = await supabase
      .from('tareas')
      .insert([nuevaTarea])
      .select('id')
      .single();
    if (error) throw error;

    if (asignacion.ids.length) {
      try {
        await tareaAsignados.sincronizar(creada.id, asignacion.ids);
      } catch (err) {
        // No dejar una tarea creada sin las personas pedidas.
        await supabase.from('tareas').delete().eq('id', creada.id);
        throw err;
      }
    }

    const data = await this._obtenerTarea(creada.id);

    // Registrar evento de creación — no incluye campo_modificado ni valores previos
    await this._registrarHistorial([{
      tarea_id:         data.id,
      ...autor(user),
      accion:           'creacion',
      campo_modificado: null,
      valor_anterior:   null,
      valor_nuevo:      null,
    }]);

    return data;
  }

  // Actualiza una tarea y genera un registro de historial por cada campo que cambió.
  // Pasos: 1) extrae datos de auditoría del body, 2) lee estado actual de la tarea,
  //         3) actualiza en BD, 4) compara campo a campo y registra diferencias.
  //
  // Asignados: `asignados` es la lista FINAL completa (agregar, quitar o reemplazar
  // personas = enviar la lista resultante). Si no viene y llega un `asignado_a`
  // distinto del actual, se trata como asignación legacy a una sola persona.
  //
  // El usuario tiene que poder ver el tablero de la tarea. Los responsables que
  // se agregan deben ser miembros del tablero; los que ya estaban se conservan
  // aunque hayan dejado de serlo. Una tarea no cambia de tablero.
  //
  // Solo se aplican los CAMPOS_EDITABLES; el resto del body se ignora (tipo y
  // datos de la propuesta, estado, fechas reales, usuario_nombre/usuario_id…).
  // El autor del historial es el usuario autenticado.
  async actualizarTarea(id, body, user) {
    const datos = body ?? {};
    const { asignados } = datos;
    const camposTarea = Object.fromEntries(
      CAMPOS_EDITABLES.filter(campo => campo in datos).map(campo => [campo, datos[campo]])
    );

    // Leer estado actual ANTES de actualizar: sirve para comparar en el historial y
    // para saber si fecha_inicio_real/fecha_fin_real ya estaban cargadas (no pisarlas)
    const tareaActual = await this._asegurarAccesoTarea(id, user);

    if ('tablero_id' in datos && datos.tablero_id !== tareaActual.tablero_id) {
      throw error400('No se puede cambiar el tablero de una tarea.');
    }

    // Validar asignados ANTES de escribir nada.
    let asignacion = null;
    if (asignados !== undefined) {
      const actuales = await tareaAsignados.usuarioIdsDeTarea(id);
      asignacion = { ids: await tareaAsignados.validarAsignados(asignados, actuales), texto: null };
      if (tareaActual.tablero_id) await this._validarResponsablesMiembros(tareaActual.tablero_id, asignacion.ids, actuales);
    } else if ('asignado_a' in datos && normalizar(datos.asignado_a) !== normalizar(tareaActual.asignado_a)) {
      const actuales = await tareaAsignados.usuarioIdsDeTarea(id);
      asignacion = tareaActual.tablero_id
        ? await this._resolverAsignadoLegacyEnTablero(datos.asignado_a, tareaActual.tablero_id, actuales)
        : await tareaAsignados.resolverAsignadoLegacy(datos.asignado_a);
    }
    // asignado_a lo mantiene la sincronización; un valor sin cambios se ignora
    // (clientes que reenvían el formulario completo).

    // Si viene etapa_id, resolverla, reflejar su nombre en `estado` (ver _resolverEtapa)
    // y completar fechas reales si corresponde
    if (camposTarea.etapa_id) {
      const etapa = await this._resolverEtapa(camposTarea.etapa_id);
      camposTarea.etapa_id = etapa.id;
      camposTarea.estado = ESTADO_CANONICO_POR_TIPO_BASE[etapa.tipo_base];
      this._aplicarFechasAutomaticas(camposTarea, etapa, tareaActual);
      await this._aplicarFechaFinalizacion(camposTarea, etapa, tareaActual);
    }

    // Aplicar la actualización en la tabla tareas
    if (Object.keys(camposTarea).length) {
      const { error } = await supabase.from('tareas').update(camposTarea).eq('id', id);
      if (error) throw error;
    }

    if (asignacion) {
      await tareaAsignados.sincronizar(id, asignacion.ids);
      if (asignacion.texto) {
        const { error } = await supabase.from('tareas').update({ asignado_a: asignacion.texto }).eq('id', id);
        if (error) throw error;
      }
    }

    const data = await this._obtenerTarea(id);

    // Comparar únicamente los campos auditables que fueron enviados en el body.
    // Si el valor normalizado cambió, se genera un registro individual por campo.
    const entradas = [];
    for (const campo of CAMPOS_AUDITABLES) {
      if (campo in camposTarea) {
        const anterior = normalizar(tareaActual[campo]);
        const nuevo    = normalizar(camposTarea[campo]);
        if (anterior !== nuevo) {
          entradas.push({
            tarea_id:         id,
            ...autor(user),
            accion:           'actualizacion',
            campo_modificado: campo,
            // Guardar null real cuando el campo estaba/quedó vacío
            valor_anterior:   (tareaActual[campo] != null && tareaActual[campo] !== '') ? String(tareaActual[campo]) : null,
            valor_nuevo:      (camposTarea[campo]  != null && camposTarea[campo]  !== '') ? String(camposTarea[campo])  : null,
          });
        }
      }
    }
    // asignado_a refleja la lista de asignados ("Ana, Juan"): se audita su cambio.
    if (asignacion && normalizar(tareaActual.asignado_a) !== normalizar(data.asignado_a)) {
      entradas.push({
        tarea_id:         id,
        ...autor(user),
        accion:           'actualizacion',
        campo_modificado: 'asignado_a',
        valor_anterior:   tareaActual.asignado_a || null,
        valor_nuevo:      data.asignado_a || null,
      });
    }
    await this._registrarHistorial(entradas);

    return data;
  }

  async eliminarTarea(id, user) {
    await this._asegurarAccesoTarea(id, user);
    // ON DELETE CASCADE en tarea_historial y tarea_asignados elimina historial y asignaciones
    const { error } = await supabase.from('tareas').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Tarea eliminada correctamente' };
  }

  // mes/anio son opcionales: si no llegan, se mantiene el comportamiento histórico
  // (métricas sobre todas las tareas, sin filtrar por fecha). Cuando se proveen, filtran
  // por fecha_limite (vencimiento), que es el campo relevante para el tablero operativo.
  //
  // Los totales ya no son fijos (pendientes/enProceso/completadas): con etapas
  // personalizables se devuelve `porEtapa` (una entrada por cada etapa configurada,
  // en el orden del tablero) y `porTipoBase` (agregado por tipo_base interno,
  // útil para tarjetas resumen). `vencida` = fecha_limite pasada y la etapa de la
  // tarea no es de un tipo_base cerrado (ver TIPOS_BASE_CERRADOS).
  //
  // Totales de las tarjetas: `pendientes`, `enProceso` y `completadas` agrupan
  // las etapas por su estado canónico (ESTADO_CANONICO_POR_TIPO_BASE; las
  // canceladas no entran en ninguno de los tres).
  //
  // `tablero_id` (opcional): limita a un tablero que el usuario pueda ver. Sin
  // él, totales globales (lo usa Nexi para el resumen del dashboard).
  // `solo_mias` (opcional): solo las tareas donde el usuario es responsable.
  // `solo_abiertas` (opcional): solo las tareas en etapas abiertas.
  async getMetricas({ mes, anio, tablero_id, solo_mias, solo_abiertas } = {}, user) {
    let query = supabase
      .from('tareas')
      .select('fecha_limite, estado, etapa_id, operativo_etapas(tipo_base)')
      .or('tipo.is.null,tipo.eq.asignacion');

    if (tablero_id) {
      await tablerosService.asegurarAcceso(tablero_id, user);
      query = query.eq('tablero_id', tablero_id);
    }
    if (esVerdadero(solo_mias)) query = query.in('id', await idsTareasPropias(user));

    const periodoProvisto = (mes ?? '') !== '' || (anio ?? '') !== '';
    if (periodoProvisto) {
      const { mes: targetMes, anio: targetAnio } = resolverPeriodo(mes, anio);
      const { desde, hasta } = rangoMes(targetMes, targetAnio);
      query = query.gte('fecha_limite', desde).lt('fecha_limite', hasta);
    }

    const [{ data: filas, error }, { data: etapas, error: errEtapas }] = await Promise.all([
      query,
      supabase.from('operativo_etapas').select('id, nombre, color, posicion, tipo_base').order('posicion', { ascending: true }),
    ]);
    if (error) throw error;
    if (errEtapas) throw errEtapas;
    const data = esVerdadero(solo_abiertas) ? filas.filter(esTareaAbierta) : filas;

    const hoy = new Date().toISOString().slice(0, 10);
    const porEtapa = etapas.map(e => ({
      etapa_id: e.id,
      nombre:   e.nombre,
      color:    e.color,
      posicion: e.posicion,
      tipo_base: e.tipo_base,
      cantidad: data.filter(t => t.etapa_id === e.id).length,
    }));

    const porTipoBase = Object.fromEntries(TIPOS_BASE.map(t => [t, 0]));
    for (const t of data) {
      const tipoBase = t.operativo_etapas?.tipo_base;
      if (tipoBase && tipoBase in porTipoBase) porTipoBase[tipoBase]++;
    }

    const vencidas = data.filter(t =>
      t.fecha_limite && t.fecha_limite < hoy &&
      t.operativo_etapas?.tipo_base && !TIPOS_BASE_CERRADOS.includes(t.operativo_etapas.tipo_base)
    ).length;

    const porEstado = { Pendiente: 0, 'En Proceso': 0, Completada: 0 };
    for (const [tipoBase, cantidad] of Object.entries(porTipoBase)) {
      const estado = ESTADO_CANONICO_POR_TIPO_BASE[tipoBase];
      if (estado in porEstado) porEstado[estado] += cantidad;
    }

    return {
      total: data.length,
      pendientes: porEstado.Pendiente,
      enProceso: porEstado['En Proceso'],
      completadas: porEstado.Completada,
      vencidas,
      porEtapa,
      porTipoBase,
    };
  }

  // ── Propuestas ─────────────────────────────────────────────────────────────

  // Con `tablero_id`, las propuestas de ese tablero (si el usuario lo ve); sin
  // él, las de todos los tableros que el usuario ve.
  async listarPropuestas({ propuesto_por, asignado_a, asignado_id, tablero_id } = {}, user) {
    let query = supabase
      .from('tareas')
      .select(`*, ${tareaAsignados.SELECT_ASIGNADOS}`)
      .eq('tipo', 'propuesta')
      .order('created_at', { ascending: false });

    if (tablero_id) {
      await tablerosService.asegurarAcceso(tablero_id, user);
      query = query.eq('tablero_id', tablero_id);
    } else {
      const visibles = await tablerosService.idsVisibles(user);
      if (visibles) {
        if (!visibles.length) return { data: [], total: 0 };
        query = query.in('tablero_id', visibles);
      }
    }

    if (propuesto_por) query = query.eq('propuesto_por', propuesto_por);
    query = await this._filtrarPorPersona(query, { asignado_id, asignado_a });
    if (!query) return { data: [], total: 0 };

    const { data, error } = await query;
    if (error) throw error;
    return { data: data.map(tareaAsignados.conAsignados), total: data.length };
  }

  // Quién puede aprobar o rechazar una propuesta (misma regla que la vista de
  // Propuestas del frontend): el mando alto (Dirección, Superadmin) y los
  // responsables propuestos (asignados; en tareas históricas sin asignados
  // vinculados, el nombre en asignado_a), salvo quien la creó aunque también
  // sea responsable (ver _autorPropuesta). Además tiene que poder ver el
  // tablero, y la tarea tiene que ser una propuesta todavía pendiente
  // (estado_propuesta NULL en propuestas antiguas cuenta como pendiente).
  async _asegurarPuedeResolverPropuesta(id, user) {
    const tarea = await this._asegurarAccesoTarea(id, user);
    if (tarea.tipo !== 'propuesta') throw error400('La tarea no es una propuesta.');
    if ((tarea.estado_propuesta || 'pendiente') !== 'pendiente') throw error409('La propuesta ya fue resuelta.');

    if (!tablerosService.esMandoAlto(user)) {
      const asignados = await tareaAsignados.usuarioIdsDeTarea(id);
      const esResponsable = asignados.length
        ? !!user?.id && asignados.includes(user.id)
        : !!user?.name && tarea.asignado_a?.trim() === user.name;
      if (!esResponsable) {
        throw Object.assign(new Error('Solo los responsables propuestos o Dirección pueden aprobar o rechazar esta propuesta.'), { status: 403 });
      }
      if (user?.id && await this._autorPropuesta(id) === user.id) {
        throw Object.assign(new Error('Quien creó la propuesta no puede aprobarla ni rechazarla.'), { status: 403 });
      }
    }
    return tarea;
  }

  // Autor de la propuesta: el usuario_id del evento 'creacion' de su historial,
  // solo si es un UUID (desde que el autor sale de la sesión). En propuestas
  // anteriores ese campo lo enviaba el cliente (email o vacío) y no es
  // confiable: devuelve null y no se aplica la restricción de autor. Nunca se
  // compara por nombre (propuesto_por) ni por email.
  async _autorPropuesta(id) {
    const { data, error } = await supabase
      .from('tarea_historial')
      .select('usuario_id')
      .eq('tarea_id', id)
      .eq('accion', 'creacion')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw error;
    const usuarioId = data?.[0]?.usuario_id;
    return typeof usuarioId === 'string' && UUID.test(usuarioId) ? usuarioId : null;
  }

  // Actualiza la propuesta solo si sigue pendiente: si dos personas la
  // resuelven a la vez, la segunda recibe 409 en vez de pisar a la primera.
  async _resolverPropuesta(id, cambios, select) {
    const { data, error } = await supabase
      .from('tareas')
      .update(cambios)
      .eq('id', id)
      .eq('tipo', 'propuesta')
      .or('estado_propuesta.is.null,estado_propuesta.eq.pendiente')
      .select(select)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw error409('La propuesta ya fue resuelta.');
    return data;
  }

  // Aprueba una propuesta (tipo → 'asignacion', estado_propuesta → 'aprobada', estado → 'Pendiente')
  // y registra el evento en tarea_historial. El body se ignora: el autor es el
  // usuario autenticado.
  async aprobarPropuesta(id, _body, user) {
    // Leer estado actual para registrar el valor anterior en historial
    const antes = await this._asegurarPuedeResolverPropuesta(id, user);

    // Al aprobar, la tarea entra al tablero en la etapa inicial (tipo_base 'pendiente')
    const etapaInicial = await this._resolverEtapa(null);

    const cambios = { tipo: 'asignacion', estado_propuesta: 'aprobada', estado: ESTADO_CANONICO_POR_TIPO_BASE[etapaInicial.tipo_base], etapa_id: etapaInicial.id };
    await this._aplicarFechaFinalizacion(cambios, etapaInicial, antes);
    const data = await this._resolverPropuesta(id, cambios, SELECT_TAREA);

    await this._registrarHistorial([{
      tarea_id:         id,
      ...autor(user),
      accion:           'aprobacion_propuesta',
      campo_modificado: 'estado_propuesta',
      valor_anterior:   antes.estado_propuesta || 'pendiente',
      valor_nuevo:      'aprobada',
    }]);

    return tareaAsignados.conAsignados(data);
  }

  // Rechaza una propuesta (estado_propuesta → 'rechazada')
  // y registra el evento en tarea_historial. El body se ignora.
  async rechazarPropuesta(id, _body, user) {
    // Leer estado actual para registrar el valor anterior en historial
    const antes = await this._asegurarPuedeResolverPropuesta(id, user);

    const data = await this._resolverPropuesta(id, { estado_propuesta: 'rechazada' }, `*, ${tareaAsignados.SELECT_ASIGNADOS}`);

    await this._registrarHistorial([{
      tarea_id:         id,
      ...autor(user),
      accion:           'rechazo_propuesta',
      campo_modificado: 'estado_propuesta',
      valor_anterior:   antes.estado_propuesta || 'pendiente',
      valor_nuevo:      'rechazada',
    }]);

    return tareaAsignados.conAsignados(data);
  }
}

module.exports = new OperationsService();
