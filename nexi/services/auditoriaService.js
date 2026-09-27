const supabase = require('../../config/supabase');

// Auditoría de llamadas a herramientas de Nexi (public.nexi_tool_calls).
// Solo guarda argumentos ya validados (enums, enteros, ids, períodos) o, si la
// llamada fue rechazada, únicamente los nombres de las claves recibidas.
// Nunca guarda resultados, tokens ni claves.

const ESTADOS = ['OK', 'DENEGADO', 'ERROR'];

class AuditoriaService {
  async registrar({ conversacionId, usuarioId, herramienta, argumentos, estado, motivo, duracionMs }) {
    if (!ESTADOS.includes(estado)) throw new Error(`Estado de auditoría inválido: ${estado}`);
    const { error } = await supabase.from('nexi_tool_calls').insert([{
      conversacion_id: conversacionId || null,
      usuario_id: usuarioId || null,
      herramienta: String(herramienta || '').slice(0, 100) || '(sin nombre)',
      argumentos: argumentos || {},
      resultado_estado: estado,
      motivo: motivo || null,
      duracion_ms: Math.max(0, Math.round(duracionMs || 0)),
    }]);
    // La auditoría no interrumpe la respuesta, pero el fallo queda en el log.
    if (error) console.error('[Nexi] Error al registrar auditoría de herramienta:', error.message);
  }
}

module.exports = new AuditoriaService();
