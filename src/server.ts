import "colors";
import cors from "cors";
import morgan from "morgan";
import {createServer, Server as HttpServer} from "http";
import express, {Express, Request, Response} from 'express';
import {PORT} from "./config/config";
import {initR2Client} from "./utils/r2";
import syncRoutes from "./routes/SyncRoutes";
import {connectDB} from "./config/connectDB";
import {getLocalIP} from "./utils/getLocalIP";
import taskRoutes from "./routes/TaskRoutes";
import setupRoutes from "./routes/SetupRoutes";
import voiceRoutes from "./routes/VoiceRoutes";
import exportRoutes from "./routes/ExportRoutes";
import importRoutes from "./routes/ImportRoutes";
import memoryRoutes from "./routes/MemoryRoutes";
import projectRoutes from "./routes/ProjectRoutes";
import sessionRoutes from "./routes/SessionRoutes";
import {attachWebSocket} from "./ws/WebSocketHandler";
import filePickerRoutes from "./routes/FilePickerRoutes";
import toolApprovalRoutes from "./routes/ToolApprovalRoutes";

// rest object
const app: Express = express();
const httpServer: HttpServer = createServer(app);

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
app.use('/api/v1/export', exportRoutes);
app.use('/api/v1/import', importRoutes);
app.use('/api/v1/voice', voiceRoutes);
app.use('/api/v1/file-picker', filePickerRoutes);
app.use('/api/v1/tool-approval', toolApprovalRoutes);
app.get('/', function (req: Request, res: Response) {
    return res.status(200).send('<h1>Welcome to Claude Lens Server</h1>');
});

const port: number = Number(PORT) || 20261;

// attach WebSocket server at /ws
attachWebSocket(httpServer);

const start = async () => {
    // Initialize R2 client from ~/.claude-lens/config.json (if configured)
    initR2Client();

    try {
        const connection = await connectDB();
        if (!connection) {
            console.log('Server starting in setup mode — visit /api/v1/setup/status'.yellow.bold);
        }

        httpServer.listen(port, '0.0.0.0', () => {
            console.log(`Server started on ${port}`.blue.italic.bold);
            console.log(`\t- Local:        http://localhost:${port}`.green.bold);
            console.log(`\t- Network:      http://${getLocalIP()}:${port}`.green.bold);
            console.log(`\t- WebSocket:    ws://localhost:${port}/ws`.green.bold);
        });
    } catch (error: any) {
        console.error('Service Error: Database connection failed during startup'.red.bold, error);
        console.log('Server starting without database — setup required'.yellow.bold);

        httpServer.listen(port, '0.0.0.0', () => {
            console.log(`Server started on ${port} (setup mode)`.yellow.italic.bold);
            console.log(`\t- Local:        http://localhost:${port}`.green.bold);
            console.log(`\t- Network:      http://${getLocalIP()}:${port}`.green.bold);
            console.log(`\t- WebSocket:    ws://localhost:${port}/ws`.green.bold);
        });
    }
}

start();
