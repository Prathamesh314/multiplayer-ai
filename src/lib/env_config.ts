export default interface EnvConfig {
  POSTGRES_USER: string;
  POSTGRES_HOST: string;
  POSTGRES_DB_NAME: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_PORT: number;
  DATABASE_URL: string;
};
