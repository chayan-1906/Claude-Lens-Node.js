import path from "path";
import dotenv from "dotenv";

const isPkg: boolean = !!(process as any).pkg;

const envPath: string | undefined = isPkg
    ? path.join(path.dirname(process.execPath), '.env')
    : undefined;

dotenv.config({
    path: envPath,
    override: true,
});

/** Centralized app configuration from environment variables */
export const {NODE_ENV, PORT, APP_VERSION} = process.env;

/** Validate required env vars at startup — fail fast with clear error */
const REQUIRED_ENV_VARS: string[] = ['PORT'];
const missing: string[] = REQUIRED_ENV_VARS.filter((key: string) => !process.env[key]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}
