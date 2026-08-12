// Valida y resuelve el par opcional (mes, anio) usado por los endpoints de métricas.
// Si no llega ninguno de los dos, cae en el mes/año actual (comportamiento previo de cada endpoint).
function resolverPeriodo(mesRaw, anioRaw) {
  const mesProvisto = mesRaw !== undefined && mesRaw !== null && mesRaw !== '';
  const anioProvisto = anioRaw !== undefined && anioRaw !== null && anioRaw !== '';

  if (!mesProvisto && !anioProvisto) {
    const now = new Date();
    return { mes: now.getMonth() + 1, anio: now.getFullYear() };
  }

  if (mesProvisto !== anioProvisto) {
    const faltante = mesProvisto ? 'anio' : 'mes';
    throw Object.assign(
      new Error(`Debe indicar "mes" y "anio" juntos. Falta el parámetro "${faltante}".`),
      { status: 400 }
    );
  }

  if (!/^\d+$/.test(String(mesRaw).trim())) {
    throw Object.assign(new Error('El parámetro "mes" debe ser un número entero entre 1 y 12.'), { status: 400 });
  }
  const mes = Number(mesRaw);
  if (mes < 1 || mes > 12) {
    throw Object.assign(new Error('El parámetro "mes" debe ser un número entero entre 1 y 12.'), { status: 400 });
  }

  if (!/^\d{4}$/.test(String(anioRaw).trim())) {
    throw Object.assign(new Error('El parámetro "anio" debe ser un número entero de 4 dígitos.'), { status: 400 });
  }
  const anio = Number(anioRaw);

  return { mes, anio };
}

// Rango [desde, hasta) del mes solicitado: inicio inclusivo del mes, inicio exclusivo del mes siguiente.
// Evita el bug clásico de "último día del mes" y no depende de zona horaria porque compara solo fechas (YYYY-MM-DD).
function rangoMes(mes, anio) {
  const desde = `${anio}-${String(mes).padStart(2, '0')}-01`;
  const mesSiguiente = mes === 12 ? 1 : mes + 1;
  const anioSiguiente = mes === 12 ? anio + 1 : anio;
  const hasta = `${anioSiguiente}-${String(mesSiguiente).padStart(2, '0')}-01`;
  return { desde, hasta };
}

function mesAnterior(mes, anio) {
  return mes === 1 ? { mes: 12, anio: anio - 1 } : { mes: mes - 1, anio };
}

module.exports = { resolverPeriodo, rangoMes, mesAnterior };
