const knex = require('knex');
require('dotenv').config();

const DB = knex({
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: false }
  },
  pool: { min: 0, max: 5 } 
});

// Проверка подключения
DB.raw('SELECT 1')
  .then(() => console.log('✅ Connected to PostgreSQL with Knex'))
  .catch(err => console.error('❌ Database connection error:', err));

module.exports = DB;
