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
export const {
    NODE_ENV,
    PORT,
    MONGO_URI,
    BACKEND_URL,
    FRONTEND_URL,
    APP_VERSION,
    GROQ_API_KEY,
    CLOUDFLARE_TOKEN,
    CLOUDFLARE_ACCESS_KEY_ID,
    CLOUDFLARE_SECRET_ACCESS_KEY,
    CLOUDFLARE_R2_ENDPOINT,
    CLOUDFLARE_R2_PUBLIC_URL,
    CLOUDFLARE_R2_BUCKET_NAME,
} = process.env;

/** Validate required env vars at startup — fail fast with clear error */
const REQUIRED_ENV_VARS: string[] = ['PORT'];
const missing: string[] = REQUIRED_ENV_VARS.filter((key: string) => !process.env[key]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}
