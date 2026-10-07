const supabase = require('../../config/supabase');
const { BUCKET_REPORTES } = require('../config/reportes');
const { errorPublico } = require('../utils/errores');

// Persistencia de los reportes generados por Nexi:
//   - public.nexi_reportes: metadatos + auditoría (usuario, tipo, secciones
//     incluidas/excluidas, período, estado, motivo, duración, ubicación).
//     Nunca guarda el contenido ni los datos del reporte.
//   - Supabase Storage, bucket privado `nexi-reportes`: el archivo, en
//     <usuario_id>/<reporte_id>.pdf. Solo el backend (service role) accede.
// Toda lectura filtra por el usuario autenticado: un reporte ajeno se trata
// igual que uno inexistente (404).

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNAS_PUBLICAS = 'id, tipo, titulo, secciones, secciones_excluidas, periodo_etiqueta, periodo_desde, periodo_hasta, formato, estado, archivo_bytes, created_at';

function noEncontrado() {
  return errorPublico(404, 'Reporte no encontrado.', 'REPORTE_NO_ENCONTRADO');
}

class ReportesRepositorio {
  async crear({ usuarioId, conversacionId, tipo, titulo, secciones, excluidas, periodo, formato }) {
    const { data, error } = await supabase
      .from('nexi_reportes')
      .insert([{
        usuario_id: usuarioId,
        conversacion_id: conversacionId || null,
        tipo,
        titulo,
        secciones,
        secciones_excluidas: excluidas,
        periodo_desde: periodo.desde,
        periodo_hasta: periodo.hasta,
        periodo_etiqueta: periodo.etiqueta,
        comparacion_desde: periodo.comparacion?.desde || null,
        comparacion_hasta: periodo.comparacion?.hasta || null,
        formato,
        estado: 'EN_PROCESO',
      }])
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  async finalizar(id, { estado, motivo = null, archivoPath = null, archivoBytes = null, duracionMs }) {
    const { error } = await supabase
      .from('nexi_reportes')
      .update({
        estado,
        motivo,
        archivo_path: archivoPath,
        archivo_bytes: archivoBytes,
        duracion_ms: Math.max(0, Math.round(duracionMs || 0)),
        finalizado_at: new Date().toISOString(),
      })
      .eq('id', id);
    // El fallo de auditoría no oculta el resultado, pero queda en el log.
    if (error) console.error('[Nexi] No se pudo actualizar el estado del reporte:', error.message);
  }

  // Reportes del usuario creados desde `desdeIso` (para el límite por hora).
  async contarRecientes(usuarioId, desdeIso) {
    const { count, error } = await supabase
      .from('nexi_reportes')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .gte('created_at', desdeIso);
    if (error) throw error;
    return count || 0;
  }

  async subirArchivo(ruta, buffer, contentType) {
    const { error } = await supabase.storage.from(BUCKET_REPORTES).upload(ruta, buffer, { contentType, upsert: false });
    if (error) throw new Error(`No se pudo guardar el archivo del reporte: ${error.message}`);
  }

  async listarPropios(usuarioId, limite = 20) {
    const { data, error } = await supabase
      .from('nexi_reportes')
      .select(COLUMNAS_PUBLICAS)
      .eq('usuario_id', usuarioId)
      .order('created_at', { ascending: false })
      .limit(limite);
    if (error) throw error;
    return data || [];
  }

  async obtenerPropio(id, usuarioId) {
    if (!usuarioId) throw errorPublico(401, 'No autenticado.', 'NO_AUTENTICADO');
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) throw noEncontrado();
    const { data, error } = await supabase
      .from('nexi_reportes')
      .select(`${COLUMNAS_PUBLICAS}, archivo_path`)
      .eq('id', id)
      .eq('usuario_id', usuarioId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw noEncontrado();
    return data;
  }

  async descargarArchivo(ruta) {
    const { data, error } = await supabase.storage.from(BUCKET_REPORTES).download(ruta);
    if (error || !data) throw new Error(`No se pudo leer el archivo del reporte: ${error?.message || 'vacío'}`);
    return Buffer.from(await data.arrayBuffer());
  }
}

module.exports = new ReportesRepositorio();
