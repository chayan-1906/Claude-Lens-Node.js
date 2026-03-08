import "colors";
import cors from "cors";
import morgan from "morgan";
import express, {Express} from 'express';
import {PORT} from "./config/config";
import syncRoutes from "./routes/SyncRoutes";
import {connectDB} from "./config/connectDB";
import {getLocalIP} from "./utils/getLocalIP";
import taskRoutes from "./routes/TaskRoutes";
import setupRoutes from "./routes/SetupRoutes";
import memoryRoutes from "./routes/MemoryRoutes";
import projectRoutes from "./routes/ProjectRoutes";
import sessionRoutes from "./routes/SessionRoutes";

// rest object
const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// routes
app.use('/api/v1/setup', setupRoutes);
app.use('/api/v1/sync', syncRoutes);
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1/memories', memoryRoutes);
app.get('/', function (req, res) {
    return res.status(200).send('<h1>Welcome to Claude Lens Server</h1>');
});

const port: number = Number(PORT) || 20261;

const start = async () => {
    try {
        const connection = await connectDB();
        if (!connection) {
            console.log('Server starting in setup mode — visit /api/v1/setup/status'.yellow.bold);
        }

        app.listen(port, '0.0.0.0', () => {
            console.log(`Server started on ${port}`.blue.italic.bold);
            console.log(`\t- Local:        http://localhost:${port}`.green.bold);
            console.log(`\t- Network:      http://${getLocalIP()}:${port}`.green.bold);
        });
    } catch (error: any) {
        console.error('Service Error: Database connection failed during startup'.red.bold, error);
        console.log('Server starting without database — setup required'.yellow.bold);

        app.listen(port, '0.0.0.0', () => {
            console.log(`Server started on ${port} (setup mode)`.yellow.italic.bold);
            console.log(`\t- Local:        http://localhost:${port}`.green.bold);
            console.log(`\t- Network:      http://${getLocalIP()}:${port}`.green.bold);
        });
    }
}

start();
