import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import router from "./routes/index.js";

let __currentDir: string;
try {
  __currentDir = path.dirname(fileURLToPath(import.meta.url));
} catch {
  // CJS bundle: import.meta.url is undefined, but __dirname is available
  __currentDir = (typeof __dirname !== "undefined") ? __dirname : process.cwd();
}

const app: Express = express();

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", router);

const frontendDist = path.resolve(__currentDir, "../../../artifacts/opportunity-hub/dist/public");

app.use((req, res) => {
  const reqPath = req.path === "/" ? "/index.html" : req.path;
  const filePath = path.resolve(frontendDist, "." + reqPath);
  const indexPath = path.join(frontendDist, "index.html");
  if (!filePath.startsWith(frontendDist)) {
    res.status(403).send("Forbidden");
    return;
  }
  const targetPath = (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) ? filePath : indexPath;
  fs.readFile(targetPath, (err, data) => {
    if (err) {
      res.status(500).send("Server error");
      return;
    }
    const ext = path.extname(targetPath);
    const types: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json" };
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
    res.send(data);
  });
});

export default app;
