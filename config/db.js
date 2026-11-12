const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'kreo_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Verificación de conexión tolerante a fallos (no apaga el proceso Node)
pool.getConnection()
  .then(conn => {
    console.log('✅ Base de datos "kreo_db" conectada exitosamente.');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Error conectando a la BD:', err.message);
    console.error('💡 REVISIÓN: Abre XAMPP Control Panel y haz clic en "Start" en MySQL.');
  });

module.exports = pool;