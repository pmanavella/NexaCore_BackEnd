const supabase = require('../../config/supabase');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');

class ComprobantesService {
  async ocrImagen(buffer) {
    try {
      const { data: { text } } = await Tesseract.recognize(buffer, 'spa+eng', { logger: () => {} });
      return text;
    } catch (err) {
      console.error('OCR error:', err.message);
      return null;
    }
  }

  async parsePDF(buffer) {
    try {
      const data = await pdfParse(buffer);
      return data.text;
    } catch (err) {
      console.error('PDF parse error:', err.message);
      return null;
    }
  }

  extraerDatosOCR(texto) {
    if (!texto) return { fecha: null, monto: null, proveedor: null };
    const resultado = { fecha: null, monto: null, proveedor: null };

    const montoPatterns = [
      /(?:total|importe|monto|precio)\s*:?\s*\$?\s*([\d.,]+)/i,
      /\$\s*([\d.,]+)/,
      /(?:ars|pesos)\s*([\d.,]+)/i,
    ];
    for (const p of montoPatterns) {
      const match = texto.match(p);
      if (match) {
        const raw = match[1].replace(/\./g, '').replace(',', '.');
        const val = parseFloat(raw);
        if (!isNaN(val) && val > 0) { resultado.monto = val; break; }
      }
    }

    const fechaPatterns = [/(\d{2})\/(\d{2})\/(\d{4})/, /(\d{4})-(\d{2})-(\d{2})/, /(\d{2})-(\d{2})-(\d{4})/];
    for (const p of fechaPatterns) {
      const match = texto.match(p);
      if (match) {
        try {
          let fecha;
          if (match[0].includes('-') && match[1].length === 4) {
            fecha = new Date(`${match[1]}-${match[2]}-${match[3]}`);
          } else {
            fecha = new Date(`${match[3]}-${match[2]}-${match[1]}`);
          }
          if (!isNaN(fecha.getTime())) { resultado.fecha = fecha.toISOString().split('T')[0]; break; }
        } catch { continue; }
      }
    }

    const proveedorStopWords = [
      'INFORMACION DEL CLIENTE', 'INFORMACIÓN DEL CLIENTE', 'CONDICIONES DE VENTA',
      'CLIENTE:', 'DIRECCION:', 'DIRECCIÓN:', 'CUIT:', 'IVA RESPONSABLE',
      'FACTURA', 'CAE', 'TELEFONO:', 'TELÉFONO:', 'EMAIL:', 'IIBB:',
    ];
    const cortarEnEncabezado = (str) => {
      const upper = str.toUpperCase();
      let corte = str.length;
      for (const stop of proveedorStopWords) {
        const idx = upper.indexOf(stop);
        if (idx !== -1 && idx < corte) corte = idx;
      }
      return str.substring(0, corte).trim();
    };

    // Membrete: primera línea "limpia" del documento (nombre de empresa sin
    // dígitos ni etiquetas). Suele ser el proveedor real, y tiene prioridad
    // porque "Razón social:" a veces describe al cliente, no al emisor.
    const primeraLinea = (texto.split('\n').map(l => l.trim()).find(l => l.length > 0)) || '';
    const esMembreteLimpio = /^[A-ZÁÉÍÓÚ][A-Za-záéíóúñÑ0-9\s.&-]{1,59}$/.test(primeraLinea);
    if (esMembreteLimpio) resultado.proveedor = primeraLinea.substring(0, 100);

    if (!resultado.proveedor) {
      const proveedorPatterns = [
        // "Razón social:" — se descarta si pertenece al bloque del cliente
        // (reconocible porque ahí le sigue "Documento:", ej. plantillas AFIP
        // donde el emisor no repite su nombre bajo esa etiqueta).
        { regex: /razón social\s*:?\s*([A-ZÁÉÍÓÚa-záéíóú\s.]{3,150})/i, esRazonSocial: true },
        { regex: /(?:empresa|proveedor|emisor|nombre)\s*:?\s*([A-ZÁÉÍÓÚa-záéíóú\s.]{3,150})/i },
        { regex: /([A-ZÁÉÍÓÚ][A-Za-záéíóúñÑ\s.]{3,150}?)\s*(?:Dirección|Direccion)\s*:/i },
        { regex: /^([A-ZÁÉÍÓÚ][A-Za-záéíóúñÑ\s.]{5,150})$/m },
      ];
      for (const { regex, esRazonSocial } of proveedorPatterns) {
        const match = texto.match(regex);
        if (!match) continue;
        if (esRazonSocial) {
          // Ventana desde el inicio del match (incluye lo ya capturado, por si
          // "Documento" quedó absorbido dentro del grupo) hasta 40 chars después.
          const ventana = texto.substring(match.index, match.index + match[0].length + 40);
          if (/documento\s*:/i.test(ventana)) continue;
        }
        const cortado = cortarEnEncabezado(match[1]);
        if (cortado.length >= 3) { resultado.proveedor = cortado.substring(0, 100); break; }
      }
    }

    return resultado;
  }

  async subirArchivo(file, movimiento_id) {
    const ext = file.originalname.split('.').pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;
    const storagePath = `comprobantes/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('comprobantes')
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) throw new Error(`Storage error: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from('comprobantes').getPublicUrl(storagePath);

    let ocrTexto = null, ocrEstado = 'pendiente', ocrFecha = null, ocrMonto = null, ocrProveedor = null;
    try {
      ocrTexto = file.mimetype === 'application/pdf'
        ? await this.parsePDF(file.buffer)
        : await this.ocrImagen(file.buffer);
      if (ocrTexto) {
        const datos = this.extraerDatosOCR(ocrTexto);
        ocrFecha = datos.fecha; ocrMonto = datos.monto; ocrProveedor = datos.proveedor;
        ocrEstado = 'procesado';
      }
    } catch (ocrErr) {
      console.error('OCR falló:', ocrErr.message);
      ocrEstado = 'error';
    }

    const { data: comprobante, error: dbError } = await supabase
      .from('comprobantes')
      .insert([{
        movimiento_id: movimiento_id || null,
        nombre_archivo: file.originalname,
        tipo_archivo: file.mimetype,
        url_archivo: urlData.publicUrl,
        storage_path: storagePath,
        ocr_estado: ocrEstado,
        ocr_texto: ocrTexto ? ocrTexto.substring(0, 5000) : null,
        ocr_fecha: ocrFecha, ocr_monto: ocrMonto, ocr_proveedor: ocrProveedor
      }])
      .select()
      .single();
    if (dbError) throw dbError;

    return { comprobante, ocr: { estado: ocrEstado, fecha: ocrFecha, monto: ocrMonto, proveedor: ocrProveedor } };
  }

  async listar() {
    const { data, error } = await supabase
      .from('comprobantes')
      .select('*, movimientos(id, descripcion, tipo, monto, fecha)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  }

  async vincular(id, movimiento_id) {
    const { data, error } = await supabase
      .from('comprobantes')
      .update({ movimiento_id })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async eliminar(id) {
    const { data: comp } = await supabase.from('comprobantes').select('storage_path').eq('id', id).single();
    if (comp?.storage_path) await supabase.storage.from('comprobantes').remove([comp.storage_path]);
    const { error } = await supabase.from('comprobantes').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Comprobante eliminado' };
  }

  async limpiarVencidos() {
    const fechaLimite = new Date();
    fechaLimite.setMonth(fechaLimite.getMonth() - 6);
    const fechaLimiteISO = fechaLimite.toISOString();

    const { data: vencidos, error } = await supabase
      .from('comprobantes')
      .select('id, storage_path')
      .lt('created_at', fechaLimiteISO)
      .not('storage_path', 'is', null);

    if (error) throw error;
    if (!vencidos || vencidos.length === 0) return { eliminados: 0 };

    const paths = vencidos.map(c => c.storage_path).filter(Boolean);
    if (paths.length > 0) {
      await supabase.storage.from('comprobantes').remove(paths);
    }

    const ids = vencidos.map(c => c.id);
    await supabase
      .from('comprobantes')
      .update({ url_archivo: null, storage_path: null })
      .in('id', ids);

    console.log(`[Comprobantes] ${ids.length} archivos vencidos eliminados del storage.`);
    return { eliminados: ids.length };
  }
}

module.exports = new ComprobantesService();
