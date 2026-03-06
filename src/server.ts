import "colors";
import cors from "cors";
import morgan from "morgan";
import express, {Express} from 'express';
import {PORT} from "./config/config";
import {connectDB} from "./config/connectDB";
import {getLocalIP} from "./utils/getLocalIP";
import taskRoutes from "./routes/TaskRoutes";
import memoryRoutes from "./routes/MemoryRoutes";
import sessionRoutes from "./routes/SessionRoutes";

// rest object
const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// routes
app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1/memories', memoryRoutes);
app.get('/', function (req, res) {
    return res.status(200).send('<h1>Welcome to Claude Lens Server</h1>');
});

const port: number = Number(PORT) || 20261;

const start = async () => {
    try {
        await connectDB();

        app.listen(port, '0.0.0.0', () => {
            console.log(`Server started on ${PORT}`.blue.italic.bold);
            console.log(`\t- Local:        http://localhost:${PORT}`.green.bold);
            console.log(`\t- Network:      http://${getLocalIP()}:${PORT}`.green.bold);
        });
    } catch (error: any) {
        console.error('Service Error: Server setup failed'.red.bold, error);
        console.error('Service Error: Database connection failed during startup'.red.bold);
        process.exit(1);
    }
}

start();
