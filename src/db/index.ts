import sqlite3 from 'sqlite3';
import {open, Database} from 'sqlite';
import {promises as fs} from 'fs';
import {join} from 'path';

let db: Database

export const initDb = async () => {
  db = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  const migrations = await fs.readdir(join(__dirname, 'migrations'));
  await Promise.all(migrations.map(async filename => {
    console.log(`Running migration ${filename}`)
    const query = await fs.readFile(join(__dirname, 'migrations', filename), 'utf8');
    await db.exec(query);
  }));
  console.log('Successfully run db migrations')
};

const getDb = () => db!

export default getDb
