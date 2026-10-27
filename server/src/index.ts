import { createCollabServer } from "./server";

const port = Number(process.env.PORT ?? 8080);
const server = await createCollabServer(port);
console.log(`Collab server listening on ws://localhost:${server.port}`);
