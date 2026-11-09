import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import 'dotenv/config';
import 'reflect-metadata';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5434),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  dbName: process.env.DB_NAME ?? 'backend',
  metadataProvider: ReflectMetadataProvider,

  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],

  extensions: [Migrator],

  migrations: {
    path: './dist/database/migrations',
    pathTs: './src/database/migrations',
    transactional: true,
    allOrNothing: true,
  },

  debug: process.env.NODE_ENV === 'development',
});