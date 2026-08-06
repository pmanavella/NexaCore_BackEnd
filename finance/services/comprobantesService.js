const supabase = require('../../config/supabase');
const crypto = require('crypto');
const movimientosService = require('./movimientosService');
const { analyzeDocument } = require('./geminiDocumentService');
const { validateExtraction, hasAllowedSignature } = require('./documentExtraction');

const BUCKET = 'comprobantes';
const SIGNED_URL_TTL_SECONDS = 60 * 10;

class ComprobantesService {
  async crearUrlFirmada(storagePath) {
    if (!storagePath) return null;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (error) throw new Error(`No se pudo generar acceso seguro al comprobante: ${error.message}`);
    return data.signedUrl;
  }

  async presentar(comprobante) {
    if (!comprobante) return comprobante;
    return { ...comprobante, archivo_url: await this.crearUrlFirmada(comprobante.storage_path) };
  }

  async persistir({ file, storagePath, extraction, estado, diagnostico, fingerprint = null, duplicateOfId = null }) {
    const { data, error } = await supabase
      .from('comprobantes')
      .insert([{
        nombre_archivo: file.originalname,
        tipo_archivo: file.mimetype,
        storage_path: storagePath,
        estado_analisis: estado,
        extraccion: extraction,
        diagnostico,
        document_fingerprint: fingerprint,
        duplicate_of_id: duplicateOfId
      }])
      .select('*, comprobante_items(*), movimientos(id, descripcion, tipo, monto, fecha)')
      .single();
    if (error) throw error;
    return data;
  }

  async persistirItems(comprobanteId, items) {
    const rows = items.map((item, orden) => ({
      comprobante_id: comprobanteId,
      orden: orden + 1,
      codigo: item.code,
      descripcion: item.description,
      cantidad: item.quantity,
      precio_unitario: item.unitPrice,
      bonificacion: item.discount,
      alicuota_iva: item.ivaRate,
      importe: item.lineTotal
    }));
    if (!rows.length) return;
    const { error } = await supabase.from('comprobante_items').insert(rows);
    if (error) throw error;
  }

  async buscarDuplicado(fingerprint) {
    const { data, error } = await supabase
      .from('comprobantes')
      .select('id')
      .eq('document_fingerprint', fingerprint)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async subirArchivo(file, email = null) {
    if (!hasAllowedSignature(file.buffer, file.mimetype)) {
      throw Object.assign(new Error('El contenido del archivo no coincide con el formato declarado.'), { status: 400 });
    }

    const extension = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype === 'image/png' ? 'png' : 'jpg';
    const storagePath = `comprobantes/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) throw new Error(`No se pudo guardar el comprobante: ${uploadError.message}`);

    let extraction;
    try {
      extraction = await analyzeDocument(file.buffer, file.mimetype);
    } catch (error) {
      const comprobante = await this.persistir({
        file, storagePath, extraction: null, estado: 'error',
        diagnostico: { errors: [error.message], auto_created: false }
      });
      return { comprobante: await this.presentar(comprobante), movimiento: null, analysis: comprobante.diagnostico };
    }

    const validation = validateExtraction(extraction, process.env.COMPANY_CUIT);
    const duplicate = await this.buscarDuplicado(validation.fingerprint);
    if (duplicate) {
      const diagnostico = {
        errors: ['El comprobante ya fue cargado anteriormente.'],
        auto_created: false,
        duplicate_of_id: duplicate.id
      };
      const comprobante = await this.persistir({
        file, storagePath, extraction, estado: 'requiere_revision', diagnostico, duplicateOfId: duplicate.id
      });
      await this.persistirItems(comprobante.id, extraction.items);
      return { comprobante: await this.presentar(comprobante), movimiento: null, analysis: diagnostico };
    }

    const estado = validation.valid ? 'procesado' : 'requiere_revision';
    const diagnostico = { errors: validation.errors, auto_created: false };
    let comprobante;
    try {
      comprobante = await this.persistir({
        file, storagePath, extraction, estado, diagnostico, fingerprint: validation.fingerprint
      });
    } catch (error) {
      if (error.code !== '23505') throw error;
      const existing = await this.buscarDuplicado(validation.fingerprint);
      const duplicateRecord = await this.persistir({
        file, storagePath, extraction, estado: 'requiere_revision',
        diagnostico: { errors: ['El comprobante fue cargado simultáneamente por otro usuario.'], auto_created: false, duplicate_of_id: existing?.id || null },
        duplicateOfId: existing?.id || null
      });
      await this.persistirItems(duplicateRecord.id, extraction.items);
      return { comprobante: await this.presentar(duplicateRecord), movimiento: null, analysis: duplicateRecord.diagnostico };
    }
    await this.persistirItems(comprobante.id, extraction.items);

    if (!validation.valid) {
      return { comprobante: await this.presentar(comprobante), movimiento: null, analysis: diagnostico };
    }

    try {
      const movimiento = await movimientosService.crear(validation.movimiento, email);
      const finalDiagnostico = { errors: [], auto_created: true };
      const { data, error } = await supabase
        .from('comprobantes')
        .update({ movimiento_id: movimiento.id, diagnostico: finalDiagnostico })
        .eq('id', comprobante.id)
        .select('*, comprobante_items(*), movimientos(id, descripcion, tipo, monto, fecha)')
        .single();
      if (error) throw error;
      return { comprobante: await this.presentar(data), movimiento, analysis: finalDiagnostico };
    } catch (error) {
      const finalDiagnostico = { errors: [`No se pudo crear el movimiento automático: ${error.message}`], auto_created: false };
      const { data, error: updateError } = await supabase
        .from('comprobantes')
        .update({ estado_analisis: 'requiere_revision', diagnostico: finalDiagnostico })
        .eq('id', comprobante.id)
        .select('*, comprobante_items(*), movimientos(id, descripcion, tipo, monto, fecha)')
        .single();
      if (updateError) throw updateError;
      return { comprobante: await this.presentar(data), movimiento: null, analysis: finalDiagnostico };
    }
  }

  async listar() {
    const { data, error } = await supabase
      .from('comprobantes')
      .select('*, movimientos(id, descripcion, tipo, monto, fecha), comprobante_items(*)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data: await Promise.all((data || []).map(item => this.presentar(item))) };
  }

  async eliminar(id) {
    const { data: comp, error: readError } = await supabase.from('comprobantes').select('storage_path').eq('id', id).single();
    if (readError) throw readError;
    if (comp?.storage_path) {
      const { error } = await supabase.storage.from(BUCKET).remove([comp.storage_path]);
      if (error) throw new Error(`No se pudo eliminar el archivo: ${error.message}`);
    }
    const { error } = await supabase.from('comprobantes').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Comprobante eliminado' };
  }

  async limpiarVencidos() {
    const fechaLimite = new Date();
    fechaLimite.setMonth(fechaLimite.getMonth() - 6);
    const { data: vencidos, error } = await supabase
      .from('comprobantes').select('id, storage_path')
      .lt('created_at', fechaLimite.toISOString()).not('storage_path', 'is', null);
    if (error) throw error;
    const paths = (vencidos || []).map(item => item.storage_path).filter(Boolean);
    if (!paths.length) return { eliminados: 0 };
    const { error: deleteError } = await supabase.storage.from(BUCKET).remove(paths);
    if (deleteError) throw deleteError;
    const { error: updateError } = await supabase.from('comprobantes').update({ storage_path: null }).in('id', vencidos.map(item => item.id));
    if (updateError) throw updateError;
    return { eliminados: paths.length };
  }
}

module.exports = new ComprobantesService();
