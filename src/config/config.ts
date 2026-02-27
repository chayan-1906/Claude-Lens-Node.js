import "dotenv/config";

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
