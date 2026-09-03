import 'dotenv/config'
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
})

export async function query<T = any>(sql: string, params: any[] = []) {
  const res = await pool.query(sql, params)
  return res.rows as T[]
}
