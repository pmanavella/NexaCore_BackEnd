const crypto = require('crypto');

const CATEGORIAS_VALIDAS = ['Tecnología', 'RRHH', 'Insumos', 'Servicios', 'Inversión', 'Otros', 'Suscripción'];
const TIPOS_DOCUMENTO_VALIDOS = ['factura_a', 'factura_b', 'factura_c', 'ticket'];
const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'application/pdf'];

const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'documentType', 'issuer', 'recipient', 'pointOfSale', 'documentNumber', 'cae',
    'issueDate', 'currency', 'subtotal', 'discountsTotal', 'ivaTotal', 'otherTaxesTotal',
    'total', 'items', 'suggestedCategory', 'suggestedTransactionType', 'description'
  ],
  properties: {
    documentType: { type: 'string', enum: [...TIPOS_DOCUMENTO_VALIDOS, 'otro'] },
    issuer: {
      type: 'object', additionalProperties: false, required: ['name', 'cuit'],
      properties: { name: { type: ['string', 'null'] }, cuit: { type: ['string', 'null'] } }
    },
    recipient: {
      type: 'object', additionalProperties: false, required: ['name', 'cuit'],
      properties: { name: { type: ['string', 'null'] }, cuit: { type: ['string', 'null'] } }
    },
    pointOfSale: { type: ['string', 'null'] },
    documentNumber: { type: ['string', 'null'] },
    cae: { type: ['string', 'null'] },
    issueDate: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    subtotal: { type: ['number', 'null'] },
    discountsTotal: { type: ['number', 'null'] },
    ivaTotal: { type: ['number', 'null'] },
    otherTaxesTotal: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'description', 'quantity', 'unitPrice', 'discount', 'ivaRate', 'lineTotal'],
        properties: {
          code: { type: ['string', 'null'] }, description: { type: ['string', 'null'] },
          quantity: { type: ['number', 'null'] }, unitPrice: { type: ['number', 'null'] },
          discount: { type: ['number', 'null'] }, ivaRate: { type: ['number', 'null'] },
          lineTotal: { type: ['number', 'null'] }
        }
      }
    },
    suggestedCategory: { type: ['string', 'null'] },
    suggestedTransactionType: { type: ['string', 'null'], enum: ['Ingreso', 'Gasto', null] },
    description: { type: ['string', 'null'] }
  }
};

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalizeCuit(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

function normalizeParty(value = {}) {
  return { name: cleanString(value.name), cuit: normalizeCuit(value.cuit) };
}

function normalizeItem(item = {}) {
  return {
    code: cleanString(item.code), description: cleanString(item.description),
    quantity: numberOrNull(item.quantity), unitPrice: numberOrNull(item.unitPrice),
    discount: numberOrNull(item.discount), ivaRate: numberOrNull(item.ivaRate),
    lineTotal: numberOrNull(item.lineTotal)
  };
}

function normalizeExtraction(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Gemini devolvió una extracción que no es un objeto JSON.');
  }

  return {
    documentType: cleanString(payload.documentType)?.toLowerCase() || 'otro',
    issuer: normalizeParty(payload.issuer), recipient: normalizeParty(payload.recipient),
    pointOfSale: cleanString(payload.pointOfSale), documentNumber: cleanString(payload.documentNumber),
    cae: cleanString(payload.cae), issueDate: cleanString(payload.issueDate),
    currency: cleanString(payload.currency)?.toUpperCase() || null,
    subtotal: numberOrNull(payload.subtotal), discountsTotal: numberOrNull(payload.discountsTotal),
    ivaTotal: numberOrNull(payload.ivaTotal), otherTaxesTotal: numberOrNull(payload.otherTaxesTotal),
    total: numberOrNull(payload.total), items: Array.isArray(payload.items) ? payload.items.map(normalizeItem) : [],
    suggestedCategory: cleanString(payload.suggestedCategory),
    suggestedTransactionType: cleanString(payload.suggestedTransactionType),
    description: cleanString(payload.description)
  };
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function fingerprintFor(extraction) {
  const issuerCuit = extraction.issuer.cuit;
  if (issuerCuit && extraction.pointOfSale && extraction.documentNumber) {
    return `fiscal:${issuerCuit}:${extraction.documentType}:${extraction.pointOfSale}:${extraction.documentNumber}`.toLowerCase();
  }
  const source = [
    extraction.issuer.name?.toLowerCase(), issuerCuit, extraction.issueDate,
    extraction.currency, extraction.total, extraction.documentType
  ].join('|');
  return `simple:${crypto.createHash('sha256').update(source).digest('hex')}`;
}

function validateExtraction(extraction, companyCuit) {
  const errors = [];
  const warnings = [];
  const ownCuit = normalizeCuit(companyCuit);

  // --- Validaciones bloqueantes ---
  if (!ownCuit) errors.push('COMPANY_CUIT no está configurado o no tiene 11 dígitos.');
  if (!extraction.issuer.name || !extraction.issuer.cuit) errors.push('No se pudo identificar correctamente al emisor y su CUIT.');
  if (!isIsoDate(extraction.issueDate)) errors.push('La fecha de emisión es obligatoria y debe tener formato YYYY-MM-DD.');
  if (!extraction.total || extraction.total <= 0) errors.push('El importe total debe ser mayor a cero.');
  if (extraction.currency !== 'ARS') errors.push('Solo se pueden registrar automáticamente comprobantes en ARS.');
  if (!Array.isArray(extraction.items) || extraction.items.length === 0) errors.push('El comprobante no contiene renglones extraíbles.');
  if (extraction.items.some(item => !item.description || item.lineTotal === null || item.lineTotal < 0)) {
    errors.push('Uno o más renglones del comprobante son incompletos.');
  }

  // --- Advertencias no bloqueantes ---
  if (!TIPOS_DOCUMENTO_VALIDOS.includes(extraction.documentType)) {
    warnings.push('Tipo de documento no estándar, revisar.');
  }

  let resolvedCategory = extraction.suggestedCategory;
  if (!CATEGORIAS_VALIDAS.includes(extraction.suggestedCategory)) {
    resolvedCategory = 'Otros';
    warnings.push('Categoría pendiente de revisión: se asignó "Otros" automáticamente.');
  }

  // --- Derivación de importes faltantes ---
  let derivedSubtotal = extraction.subtotal;
  let derivedIvaTotal = extraction.ivaTotal;
  const effectiveDiscounts = extraction.discountsTotal ?? 0;
  const effectiveOtherTaxes = extraction.otherTaxesTotal ?? 0;

  if (derivedSubtotal === null && Array.isArray(extraction.items) && extraction.items.length > 0) {
    derivedSubtotal = extraction.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  }
  if (derivedIvaTotal === null && derivedSubtotal !== null && extraction.total !== null) {
    const candidateIva = extraction.total - derivedSubtotal + effectiveDiscounts - effectiveOtherTaxes;
    derivedIvaTotal = candidateIva >= 0 ? candidateIva : derivedSubtotal * 0.21;
  } else if (derivedIvaTotal === null && derivedSubtotal !== null) {
    derivedIvaTotal = derivedSubtotal * 0.21;
  }

  // --- Conciliación de totales ---
  if (derivedSubtotal !== null && derivedIvaTotal !== null && extraction.total !== null) {
    const calculatedTotal = derivedSubtotal - effectiveDiscounts + derivedIvaTotal + effectiveOtherTaxes;
    if (Math.abs(calculatedTotal - extraction.total) > 1) {
      errors.push('El total no concilia con subtotal, descuentos e impuestos.');
    }
  } else if (extraction.total !== null) {
    errors.push('Faltan importes necesarios para conciliar el comprobante.');
  }

  // --- Conciliación de renglones contra subtotal (no contra total) ---
  if (extraction.subtotal !== null && Array.isArray(extraction.items) && extraction.items.length > 0) {
    const itemTotal = extraction.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
    const tolerance = Math.max(5, extraction.subtotal * 0.005);
    if (Math.abs(itemTotal - extraction.subtotal) > tolerance) {
      errors.push('La suma de renglones no concilia con el subtotal del comprobante.');
    }
  }

  // --- Determinación de tipo de movimiento ---
  let transactionType = null;
  if (ownCuit) {
    const isIssuer = extraction.issuer.cuit === ownCuit;
    const isRecipient = extraction.recipient.cuit === ownCuit;
    if (isIssuer === isRecipient) errors.push('El CUIT propio no permite determinar si el comprobante es un ingreso o gasto.');
    else transactionType = isIssuer ? 'Ingreso' : 'Gasto';
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    transactionType,
    fingerprint: fingerprintFor(extraction),
    movimiento: (errors.length === 0 && transactionType) ? {
      fecha: extraction.issueDate,
      descripcion: extraction.description || `${extraction.documentType.replace('_', ' ')} — ${extraction.issuer.name}`,
      categoria: resolvedCategory,
      tipo: transactionType,
      monto: extraction.total,
      proveedor_cliente: transactionType === 'Gasto' ? extraction.issuer.name : extraction.recipient.name,
      notas: [
        `Registro automático · ${extraction.documentType}${extraction.documentNumber ? ` ${extraction.documentNumber}` : ''}`,
        ...warnings
      ].join(' · ')
    } : null
  };
}

function hasAllowedSignature(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimetype === 'application/pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
  if (mimetype === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimetype === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return false;
}

module.exports = {
  CATEGORIAS_VALIDAS, EXTRACTION_JSON_SCHEMA, MIMES_PERMITIDOS, normalizeCuit,
  normalizeExtraction, validateExtraction, fingerprintFor, hasAllowedSignature
};
