import app from "./app";
import { startCollectorSchedule } from "./services/lead-collector.js";

const port = Number(process.env["PORT"] || 8080);

if (Number.isNaN(port) || port <= 0) {
  console.error(`Invalid PORT value: "${process.env["PORT"]}", defaulting to 8080`);
}

const finalPort = (Number.isNaN(port) || port <= 0) ? 8080 : port;

app.listen(finalPort, "0.0.0.0", () => {
  console.log(`Server listening on port ${finalPort}`);
  startCollectorSchedule();
});
