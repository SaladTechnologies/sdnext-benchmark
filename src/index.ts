import { Text2ImageRequest, Text2ImageResponse, ServerStatus } from "./types";
import fs from "node:fs/promises";
import path from "node:path";

const { SDNEXT_URL = "http://localhost:7860", OUTPUT_DIR="images", BENCHMARK_SIZE = "10" } = process.env;



const benchmarkSize = parseInt(BENCHMARK_SIZE, 10);

const testJob = {
  prompt: "cat",
  steps: 35,
  width: 1216,
  height: 896,
  send_images: true,
  cfg_scale: .7
};

async function getJob(): Promise<Text2ImageRequest> {
  return testJob;
}

async function submitJob(job: Text2ImageRequest): Promise<Text2ImageResponse> {
  // POST to SDNEXT_URL
  const url = new URL("/sdapi/v1/txt2img", SDNEXT_URL);
  const response = await fetch(url.toString(), {
    method: "POST", 
    body: JSON.stringify(job),
    headers: {
      "Content-Type": "application/json"
    }
  });

  const json = await response.json();
  return json as Text2ImageResponse;
}

let numImages = 0;
async function uploadImage(image: string): Promise<string> {
  const filename = path.join(OUTPUT_DIR, `image-${numImages++}.jpg`);
  await fs.writeFile(filename, Buffer.from(image, "base64"));
  return filename;
}

async function getServerStatus(): Promise<ServerStatus> {
  const url = new URL("/sdapi/v1/system-info/status?state=true&memory=true&full=true&refresh=true", SDNEXT_URL);
  const response = await fetch(url.toString());
  const json = await response.json();
  return json as ServerStatus;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stayAlive = true;
process.on("SIGINT", () => {
  stayAlive = false;
});

async function waitForServerToStart(): Promise<void> {
  while (stayAlive) {
    try {
      await getServerStatus();
      return;
    } catch (e) {
      console.log("Waiting for server to start...");
      await sleep(1000);
    }
  }
}

const prettyPrint = (obj: any): void => console.log(JSON.stringify(obj, null, 2));

async function main(): Promise<void> {

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await waitForServerToStart();

  // This serves as the final pre-flight check
  let response = await submitJob(testJob);

  let numImages = 0;
  const start = Date.now();
  while (stayAlive && (benchmarkSize < 0 || numImages < benchmarkSize)) {
    const job = await getJob();
    response = await submitJob(job);
    numImages += response.images.length;

    Promise.all(response.images.map(uploadImage)).then((filenames) => {
      console.log(filenames);
    });
  }

  const end = Date.now();
  const elapsed = end - start;
  console.log(`Generated ${numImages} images in ${elapsed}ms`);
  console.log(`Average time per image: ${elapsed / numImages}ms`);
}

main();