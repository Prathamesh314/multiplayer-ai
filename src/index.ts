import http from "node:http";

process.loadEnvFile();

const PORT = process.env.BACKEND_PORT ? parseInt(process.env.BACKEND_PORT) : 3000;

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  res.writeHead(200, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      message: "Hello World!",
    }),
  );
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});