const supabase = require('../config/supabase');

async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado. Se requiere token de acceso.' });
  }

  const token = authHeader.replace('Bearer ', '').trim();

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('usuarios')
      .select('id, nombre, roles(nombre)')
      .eq('email', user.email)
      .eq('estado', 'Activo')
      .single();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Usuario no encontrado o inactivo en el sistema.' });
    }

    req.user = {
      id: profile.id,
      email: user.email,
      name: profile.nombre,
      role: profile.roles?.nombre ?? null,
    };

    next();
  } catch {
    return res.status(401).json({ error: 'Error al verificar el token.' });
  }
}

module.exports = { authenticate };
