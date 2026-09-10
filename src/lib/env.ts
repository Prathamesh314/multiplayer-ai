import type EnvConfig from './env_config';

export const Env: EnvConfig = {
  POSTGRES_USER: process.env.POSTGRES_USER ?? 'postgres',
  POSTGRES_HOST: process.env.POSTGRES_HOST ?? 'localhost',
  POSTGRES_DB_NAME: process.env.POSTGRES_DB_NAME ?? 'postgres',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'postgres',
  POSTGRES_PORT: Number(process.env.POSTGRES_PORT ?? 5432),
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres',
};

export default Env;
