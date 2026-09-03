import { readFileSync } from 'node:fs'
import { pool } from './pool.js'

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
await pool.query(sql)
console.log('schema applied')
await pool.end()
