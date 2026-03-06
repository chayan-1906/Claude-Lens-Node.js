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
    APPNAME,
    TAGLINE,
} = process.env;
