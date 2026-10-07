const PDFDocument = require('pdfkit');
const { formatear, variacion } = require('./reporteFormato');

// Generación del archivo PDF de un reporte. Recibe la estructura ya validada y
// calculada (reportesService) y SOLO la dibuja: no consulta datos ni calcula.
//
// Usa las fuentes estándar de PDF (Helvetica, codificación WinAnsi): los textos
// se sanean para que caracteres fuera de esa codificación no rompan el archivo.

const COLOR = { texto: '#1F2937', tenue: '#6B7280', acento: '#1D4ED8', borde: '#D1D5DB', fondo: '#F3F4F6', alerta: '#B45309' };
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

function sanear(texto) {
  return String(texto ?? '')
    .replace(/[\t\r]/g, ' ')
    .replace(/./gu, c => {
      const code = c.codePointAt(0);
      if (c === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WINANSI_EXTRA.includes(c)) return c;
      if (c === '−') return '-';
      return '?';
    });
}

function crearDocumento(titulo) {
  return new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    bufferPages: true,
    info: { Title: sanear(titulo), Author: 'Nexi - NexaCore', Creator: 'NexaCore' },
  });
}

function anchoUtil(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function asegurarEspacio(doc, alto) {
  if (doc.y + alto > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function titulo(doc, texto, tamanio = 13) {
  asegurarEspacio(doc, 40);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(tamanio).fillColor(COLOR.acento).text(sanear(texto), doc.page.margins.left);
  doc.moveDown(0.25).fillColor(COLOR.texto);
}

function parrafo(doc, texto, { tamanio = 9.5, color = COLOR.texto, fuente = 'Helvetica' } = {}) {
  doc.font(fuente).fontSize(tamanio).fillColor(color).text(sanear(texto), doc.page.margins.left, doc.y, { width: anchoUtil(doc) });
  doc.fillColor(COLOR.texto);
}

function vinietas(doc, items, opciones = {}) {
  for (const item of items) {
    asegurarEspacio(doc, 16);
    parrafo(doc, `•  ${item}`, opciones);
    doc.moveDown(0.15);
  }
}

// Cifras principales: etiqueta, valor y comparación (si existe).
function cifras(doc, lista) {
  if (!lista.length) return;
  const x = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  for (const c of lista) {
    asegurarEspacio(doc, 18);
    const y = doc.y;
    const comparacion = c.variacion_pct !== undefined
      ? `${variacion(c.variacion_pct)} (antes: ${formatear(c.anterior, c.formato)})`
      : '';
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.tenue).text(sanear(c.etiqueta), x, y, { width: ancho * 0.45 });
    doc.font('Helvetica-Bold').fillColor(COLOR.texto).text(sanear(formatear(c.valor, c.formato)), x + ancho * 0.45, y, { width: ancho * 0.25 });
    doc.font('Helvetica').fillColor(COLOR.tenue).text(sanear(comparacion), x + ancho * 0.7, y, { width: ancho * 0.3 });
    doc.x = x;
    doc.y = Math.max(doc.y, y + 14);
  }
  doc.fillColor(COLOR.texto).moveDown(0.3);
}

function tabla(doc, t) {
  if (!t.filas.length) return;
  titulo(doc, t.titulo, 10.5);
  const x0 = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const n = t.columnas.length;
  // Primera columna más ancha (suele ser el nombre).
  const primera = n > 1 ? Math.min(ancho * 0.4, ancho / n * 1.6) : ancho;
  const resto = n > 1 ? (ancho - primera) / (n - 1) : 0;
  const anchos = t.columnas.map((_, i) => (i === 0 ? primera : resto));
  const pad = 4;

  const fila = (celdas, { encabezado = false } = {}) => {
    doc.font(encabezado ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const textos = celdas.map((c, i) => sanear(encabezado ? c : formatear(c, t.columnas[i].formato)));
    const alto = Math.max(...textos.map((tx, i) => doc.heightOfString(tx, { width: anchos[i] - pad * 2 }))) + pad * 2;
    if (doc.y + alto > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      if (!encabezado) fila(t.columnas.map(c => c.titulo), { encabezado: true });
      doc.font('Helvetica').fontSize(8.5);
    }
    const y = doc.y;
    if (encabezado) doc.rect(x0, y, ancho, alto).fill(COLOR.fondo);
    let x = x0;
    textos.forEach((tx, i) => {
      // Columnas numéricas (con formato) alineadas a la derecha, encabezado incluido.
      const numerica = !!t.columnas[i].formato;
      doc.fillColor(COLOR.texto).text(tx, x + pad, y + pad, { width: anchos[i] - pad * 2, align: numerica ? 'right' : 'left' });
      x += anchos[i];
    });
    doc.moveTo(x0, y + alto).lineTo(x0 + ancho, y + alto).lineWidth(0.5).strokeColor(COLOR.borde).stroke();
    doc.x = x0;
    doc.y = y + alto;
  };

  fila(t.columnas.map(c => c.titulo), { encabezado: true });
  for (const f of t.filas) fila(f);
  if (t.nota) {
    doc.moveDown(0.2);
    parrafo(doc, t.nota, { tamanio: 8, color: COLOR.tenue });
  }
  doc.moveDown(0.4);
}

function encabezado(doc, reporte) {
  parrafo(doc, 'NexaCore · Reporte generado por Nexi', { tamanio: 8.5, color: COLOR.tenue });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(COLOR.texto).text(sanear(reporte.titulo));
  doc.moveDown(0.4);
  const p = reporte.periodo;
  const lineas = [
    `Período: ${p.etiqueta}${p.en_curso ? ' (en curso, datos parciales)' : ''}`,
    p.comparacion ? `Comparado con: ${p.comparacion.etiqueta}` : null,
    `Emitido: ${reporte.emitido}`,
    `Solicitado por: ${reporte.solicitante}`,
  ].filter(Boolean);
  for (const l of lineas) parrafo(doc, l, { tamanio: 9.5, color: COLOR.tenue });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(1).strokeColor(COLOR.acento).stroke();
  doc.moveDown(0.5);
}

function piePaginas(doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const margenInferior = doc.page.margins.bottom;
    // Sin margen inferior para que el pie no genere una página nueva.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(COLOR.tenue).text(
      `Página ${i - start + 1} de ${count} · Datos de NexaCore calculados por el backend. Nexi no estima ni completa valores.`,
      doc.page.margins.left, doc.page.height - 40, { width: anchoUtil(doc), align: 'center' }
    );
    doc.page.margins.bottom = margenInferior;
  }
}

// reporte: { titulo, periodo, emitido, solicitante, excluidas[], resumen?, secciones[] }
function generarPdf(reporte) {
  return new Promise((resolve, reject) => {
    const doc = crearDocumento(reporte.titulo);
    const partes = [];
    doc.on('data', c => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    try {
      encabezado(doc, reporte);

      if (reporte.excluidas.length) {
        titulo(doc, 'Secciones no incluidas', 11);
        vinietas(doc, reporte.excluidas.map(e => `${e.titulo}: ${e.motivo}`), { color: COLOR.alerta });
      }

      if (reporte.resumen) {
        titulo(doc, 'Resumen ejecutivo', 14);
        if (reporte.resumen.variaciones.length) {
          tabla(doc, {
            titulo: 'Principales variaciones',
            columnas: [{ titulo: 'Métrica' }, { titulo: 'Período' }, { titulo: 'Anterior' }, { titulo: 'Variación' }],
            filas: reporte.resumen.variaciones.map(v => [v.etiqueta, formatear(v.actual, v.formato), formatear(v.anterior, v.formato), variacion(v.variacion_pct)]),
          });
        }
        titulo(doc, 'Conclusiones', 10.5);
        vinietas(doc, reporte.resumen.conclusiones);
      }

      for (const s of reporte.secciones) {
        titulo(doc, s.titulo, 15);
        cifras(doc, s.cifras);
        for (const t of s.tablas) tabla(doc, t);
        if (s.observaciones.length) {
          titulo(doc, 'Observaciones', 10.5);
          vinietas(doc, s.observaciones);
        }
        if (s.notas.length) {
          doc.moveDown(0.2);
          vinietas(doc, s.notas, { tamanio: 8, color: COLOR.tenue });
        }
      }

      piePaginas(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generarPdf, sanear };
