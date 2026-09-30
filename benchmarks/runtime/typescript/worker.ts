import { parentPort } from "node:worker_threads";
import { compute, type Job } from "./compute";
parentPort!.on("message", (job: Job) => parentPort!.postMessage(compute(job)));
