import knex from 'knex';
import dotenv from 'dotenv';

dotenv.config();

const db = knex({
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  }
});

// Проверка подключения
db.raw('SELECT 1')
  .then(() => console.log('✅ Connected to PostgreSQL with Knex'))
  .catch(err => console.error('❌ Database connection error:', err));

export default db;
