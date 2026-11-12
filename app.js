const express = require('express');
const session = require('express-session');
const qrcode = require('qrcode');
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('view engine', 'pug');
app.set('views', './views');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'kreo_sena_rojo_cereza',
  resave: false,
  saveUninitialized: false
}));

const requireAuth = (req, res, next) => {
  if (!req.session.usuario) return res.redirect('/login');
  if (req.session.usuario.estado === 'inactivo') {
    req.session.destroy();
    return res.redirect('/login?error=Cuenta inactiva por seguridad.');
  }
  next();
};

// ==========================================
// RUTAS PÚBLICAS Y EXPERIENCIA (Landing / Beneficios)
// ==========================================
app.get('/', (req, res) => {
  if (req.session.usuario) return res.redirect('/dashboard');
  res.render('landing');
});

// Ruta para la mini-página pública de Beneficios
app.get('/beneficios', (req, res) => {
  res.render('beneficios');
});

app.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/dashboard');
  res.render('login', { error: req.query.error, mensaje: req.query.mensaje });
});

app.post('/login', async (req, res) => {
  try {
    const { identificacion, contrasena } = req.body;
    let query = contrasena 
      ? `SELECT u.*, r.nombre AS rol_nombre FROM usuarios u JOIN roles r ON u.rol_id = r.id WHERE u.correo = ? AND u.contrasena = ?`
      : `SELECT u.*, r.nombre AS rol_nombre FROM usuarios u JOIN roles r ON u.rol_id = r.id WHERE u.documento = ? AND u.rol_id = 3`;
    
    let params = contrasena ? [identificacion, contrasena] : [identificacion];
    const [usuarios] = await pool.query(query, params);

    if (usuarios.length === 0) return res.redirect('/login?error=Credenciales incorrectas.');
    if (usuarios[0].estado === 'inactivo') return res.redirect('/login?error=Cuenta bloqueada.');
    
    req.session.usuario = usuarios[0];
    res.redirect('/dashboard');
  } catch (error) {
    res.redirect('/login?error=Error de base de datos.');
  }
});

app.get('/test-role/:id', async (req, res) => {
  try {
    const [usuarios] = await pool.query(`SELECT u.*, r.nombre AS rol_nombre FROM usuarios u JOIN roles r ON u.rol_id = r.id WHERE u.rol_id = ? LIMIT 1`, [req.params.id]);
    if (usuarios.length > 0) {
      req.session.usuario = usuarios[0];
      return res.redirect('/dashboard');
    }
    res.redirect('/login?error=No hay usuarios con este rol.');
  } catch (err) {
    res.redirect('/login?error=Error en acceso directo.');
  }
});

app.get('/registro', (req, res) => {
  if (req.session.usuario) return res.redirect('/dashboard');
  res.render('registro', { error: req.query.error });
});

app.post('/registro', async (req, res) => {
  try {
    const { nombre, documento, correo } = req.body;
    await pool.query(
      `INSERT INTO usuarios (nombre, documento, correo, rol_id, estado) VALUES (?, ?, ?, 3, 'activo')`,
      [nombre, documento, correo]
    );
    res.redirect('/login?mensaje=¡Registro exitoso! Ya puedes ingresar.');
  } catch (error) {
    res.redirect('/registro?error=El documento o correo ya está registrado.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ==========================================
// MINI-PÁGINAS INTERNAS CON SIDEBAR FLUIDO
// ==========================================
app.get('/dashboard', requireAuth, (req, res) => {
  res.render('dashboard', { usuario: req.session.usuario, mensaje: req.query.mensaje });
});

// ROL 1: ADMINISTRADOR
app.get('/usuarios', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 1) return res.redirect('/dashboard');
  const [listaUsuarios] = await pool.query('SELECT u.*, r.nombre AS rol_nombre FROM usuarios u JOIN roles r ON u.rol_id = r.id');
  res.render('admin_usuarios', { usuario: req.session.usuario, listaUsuarios, mensaje: req.query.mensaje });
});

app.post('/usuarios/estado/:id', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 1) return res.redirect('/dashboard');
  await pool.query('UPDATE usuarios SET estado = ? WHERE id = ?', [req.body.estado, req.params.id]);
  res.redirect('/usuarios?mensaje=Estado actualizado (Kill Switch ejecutado).');
});

app.get('/finanzas', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 1) return res.redirect('/dashboard');
  const [tarifas] = await pool.query('SELECT * FROM tarifas');
  res.render('admin_finanzas', { usuario: req.session.usuario, tarifas, mensaje: req.query.mensaje });
});

app.post('/admin/tarifas', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 1) return res.redirect('/dashboard');
  const { precio_auto, precio_moto } = req.body;
  if (precio_auto) await pool.query('UPDATE tarifas SET precio = ? WHERE tipo_vehiculo = "Auto"', [precio_auto]);
  if (precio_moto) await pool.query('UPDATE tarifas SET precio = ? WHERE tipo_vehiculo = "Moto"', [precio_moto]);
  res.redirect('/finanzas?mensaje=Tarifas actualizadas correctamente.');
});

// ROL 2: OPERARIO
app.get('/operaciones', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 2) return res.redirect('/dashboard');
  const [vehiculos] = await pool.query(`
    SELECT i.id AS id_registro, v.placa, v.tipo, v.marca, i.hora_entrada 
    FROM ingresos_salidas i JOIN vehiculos v ON i.vehiculo_id = v.id 
    WHERE i.hora_salida IS NULL ORDER BY i.hora_entrada DESC
  `);
  const [clientes] = await pool.query('SELECT id, nombre, wallet_saldo FROM usuarios WHERE rol_id = 3 AND estado = "activo"');
  res.render('operario_control', { usuario: req.session.usuario, vehiculos, clientes, mensaje: req.query.mensaje });
});

app.post('/ingreso', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 2) return res.redirect('/dashboard');
  const { placa, tipo_vehiculo, marca, color } = req.body;
  const placaUp = placa.trim().toUpperCase();
  
  let [vehiculo] = await pool.query('SELECT id FROM vehiculos WHERE placa = ?', [placaUp]);
  let vId;
  
  if (vehiculo.length === 0) {
    const [nuevo] = await pool.query('INSERT INTO vehiculos (placa, tipo, marca, color) VALUES (?, ?, ?, ?)', 
      [placaUp, tipo_vehiculo, marca || 'N/A', color || 'N/A']);
    vId = nuevo.insertId;
  } else {
    vId = vehiculo[0].id;
  }
  await pool.query('INSERT INTO ingresos_salidas (vehiculo_id, operario_id, hora_entrada) VALUES (?, ?, NOW())', [vId, req.session.usuario.id]);
  res.redirect('/operaciones?mensaje=Vehículo ingresado con éxito.');
});

app.post('/salida/:id', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 2) return res.redirect('/dashboard');
  try {
    const idRegistro = req.params.id;
    const { cliente_id, usar_wallet, codigo_cupon } = req.body;
    
    const [ingresoData] = await pool.query(`
      SELECT i.*, v.tipo FROM ingresos_salidas i JOIN vehiculos v ON i.vehiculo_id = v.id WHERE i.id = ?
    `, [idRegistro]);

    if (ingresoData.length === 0) return res.redirect('/operaciones?error=Registro no encontrado.');
    const ingreso = ingresoData[0];
    
    const [tarifaData] = await pool.query('SELECT precio FROM tarifas WHERE tipo_vehiculo = ?', [ingreso.tipo]);
    const precioHora = tarifaData.length > 0 ? tarifaData[0].precio : 4500;

    const horas = Math.max(1, Math.ceil(Math.abs(new Date() - new Date(ingreso.hora_entrada)) / 36e5));
    let totalPagar = horas * precioHora;

    if (codigo_cupon && codigo_cupon.trim().toUpperCase() === 'KREO10') totalPagar *= 0.90;
    else if (codigo_cupon && codigo_cupon.trim().toUpperCase() === 'VIP20') totalPagar *= 0.80;

    if (usar_wallet && cliente_id) {
      const [clienteData] = await pool.query('SELECT wallet_saldo FROM usuarios WHERE id = ?', [cliente_id]);
      if (clienteData.length > 0 && Number(clienteData[0].wallet_saldo) >= totalPagar) {
        await pool.query('UPDATE usuarios SET wallet_saldo = wallet_saldo - ? WHERE id = ?', [totalPagar, cliente_id]);
        totalPagar = 0;
      }
    }

    await pool.query('UPDATE ingresos_salidas SET hora_salida = NOW() WHERE id = ?', [idRegistro]);
    const codigoQR = `KREO-FAC-${Date.now()}-${idRegistro}`;
    const qrImage = await qrcode.toDataURL(codigoQR);

    await pool.query(
      'INSERT INTO facturas (ingreso_salida_id, total, metodo_pago, operario_id, codigo_validacion, codigo_qr) VALUES (?, ?, ?, ?, ?, ?)',
      [idRegistro, totalPagar, usar_wallet ? 'Wallet' : 'Efectivo', req.session.usuario.id, codigoQR, qrImage]
    );

    res.redirect('/operaciones?mensaje=Salida procesada. Total cobrado: $' + totalPagar.toLocaleString('es-CO') + ' COP');
  } catch (error) {
    res.redirect('/operaciones?error=Error procesando la salida.');
  }
});

// ROL 3: CLIENTE
app.get('/perfil', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 3) return res.redirect('/dashboard');
  const [datos] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [req.session.usuario.id]);
  res.render('cliente_perfil', { usuario: req.session.usuario, datos: datos[0], mensaje: req.query.mensaje });
});

app.post('/perfil/actualizar', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 3) return res.redirect('/dashboard');
  const { nombre, correo } = req.body;
  await pool.query('UPDATE usuarios SET nombre = ?, correo = ? WHERE id = ?', [nombre, correo, req.session.usuario.id]);
  req.session.usuario.nombre = nombre;
  res.redirect('/perfil?mensaje=¡Perfil actualizado con éxito!');
});

app.get('/mis-vehiculos', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 3) return res.redirect('/dashboard');
  const [userData] = await pool.query('SELECT wallet_saldo FROM usuarios WHERE id = ?', [req.session.usuario.id]);
  const [vehiculoActivo] = await pool.query(`
    SELECT i.id, v.placa, v.tipo, v.marca, i.hora_entrada 
    FROM ingresos_salidas i JOIN vehiculos v ON i.vehiculo_id = v.id 
    WHERE i.hora_salida IS NULL ORDER BY i.hora_entrada DESC LIMIT 1
  `);
  res.render('cliente_vehiculos', { 
    usuario: req.session.usuario, 
    saldoWallet: userData[0].wallet_saldo, 
    vehiculoActivo: vehiculoActivo[0] || null,
    mensaje: req.query.mensaje 
  });
});

app.post('/wallet/recargar', requireAuth, async (req, res) => {
  if (req.session.usuario.rol_id !== 3) return res.redirect('/dashboard');
  await pool.query('UPDATE usuarios SET wallet_saldo = wallet_saldo + 20000 WHERE id = ?', [req.session.usuario.id]);
  res.redirect('/mis-vehiculos?mensaje=¡Recarga de $20.000 COP exitosa en tu Wallet!');
});

app.listen(PORT, () => console.log(`🚀 Kreo Cereza & Negro corriendo en http://localhost:${PORT}`));