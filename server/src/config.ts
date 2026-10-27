import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  databaseUrl: string;
}

/**
 * Turns raw environment variables into a checked config, failing early with a
 * clear message instead of a confusing error later. Pure, so it's easy to test.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  }

  return { port, databaseUrl };
}

/**
 * Loads the project's .env file (if there is one) and then reads the config.
 * Real environment variables win over the file, which is how a deployed server
 * would be configured.
 */
export function loadConfig(): Config {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return parseConfig(process.env);
}
