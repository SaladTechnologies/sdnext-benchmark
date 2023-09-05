import { Text2ImageRequest, Text2ImageResponse, ServerStatus, SDJob, GetJobFromQueueResponse, DeleteQueueMessageResponse } from "./types";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import os from "node:os";

const {
  SDNEXT_URL = "http://127.0.0.1:7860", 
  OUTPUT_DIR="images", 
  BENCHMARK_SIZE = "10", 
  // BATCH_SIZE="4",
  REPORTING_URL = "http://localhost:3000",
  REPORTING_AUTH_HEADER = "Benchmark-Api-Key",
  REPORTING_API_KEY = "abc1234567890",
  BENCHMARK_ID = "test",
  QUEUE_URL = "http://localhost:3001",
  QUEUE_NAME = "test",
} = process.env;

const benchmarkSize = parseInt(BENCHMARK_SIZE, 10);
// const batchSize = parseInt(BATCH_SIZE, 10);

/**
 * This is the job that will be submitted to the server,
 * set to the configured batch size.
 * 
 * You can change this to whatever you want, and there are a lot
 * of options. See the SDNext API docs for more info.
 */
const testJob: Text2ImageRequest = {
  prompt: "cat",
  steps: 35,
  refiner_start: 20,
  width: 1216,
  height: 896,
  send_images: true,
  cfg_scale: 7,
};

function getGpuType() : Promise<string> {
  return new Promise((resolve, reject) => {
    exec("nvidia-smi --query-gpu=name --format=csv,noheader,nounits", (error, stdout, stderr) => {
      if (error) {
        reject("Error fetching GPU info or nvidia-smi might not be installed");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function getSystemInfo() : { vCPU: number, MemGB: number } {
  const vCPU = os.cpus().length;
  const MemGB = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100; // Convert bytes to GB and round to 2 decimal places

  return { vCPU, MemGB };
}

/**
 * You can replace this function with your own implementation.
 * Could be submitting stats to a database, or to an api, or just
 * printing to the console.
 */
async function recordResult(result: {
  prompt: string, 
  id: string, 
  inference_time: number, 
  output_urls: string[], 
  system_info: {
    vCPU: number,
    MemGB: number,
    gpu: string
  }}): Promise<void> {
  const url = new URL("/" + BENCHMARK_ID, REPORTING_URL);
  await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify(result),
    headers: {
      "Content-Type": "application/json",
      [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
    },
  });
}


/**
 * You can replace this function with your own implementation.
 * 
 * @returns A job to submit to the server
 */
async function getJob(): Promise<{request: Text2ImageRequest, messageId: string, uploadUrls: string[], jobId: string } | null> {
  const url = new URL("/" + QUEUE_NAME, QUEUE_URL);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
    },
  });
  const queueMessage = await response.json() as GetJobFromQueueResponse;
  if (queueMessage.messages?.length) {
    const job = JSON.parse(queueMessage.messages[0].body) as SDJob;

    return {
      request: {
        prompt: job.prompt,
        steps: 35,
        refiner_start: 20,
        width: 1216,
        height: 896,
        send_images: true,
        cfg_scale: 7,
        batch_size: job.batch_size,
      },
      messageId: queueMessage.messages[0].messageId,
      uploadUrls: job.upload_url,
      jobId: job.id
    };

  } else {
    return null;
  }
}

async function markJobComplete(messageId: string): Promise<DeleteQueueMessageResponse> {
  const url = new URL(`/${QUEUE_NAME}/${encodeURIComponent(messageId)}`, QUEUE_URL);
  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: {
      [REPORTING_AUTH_HEADER]: REPORTING_API_KEY,
    },
  });
  const json = await response.json() as DeleteQueueMessageResponse;

  return json;
}

/**
 * Submits a job to the SDNext server and returns the response.
 * @param job The job to submit to the server
 * @returns The response from the server
 */
async function submitJob(job: Text2ImageRequest): Promise<Text2ImageResponse> {
  // POST to SDNEXT_URL
  const url = new URL("/sdapi/v1/txt2img", SDNEXT_URL);
  const response = await fetch(url.toString(), {
    method: "POST", 
    body: JSON.stringify(job),
    headers: {
      "Content-Type": "application/json"
    },
  });

  const json = await response.json();
  return json as Text2ImageResponse;
}

/**
 * Uploads an image to s3 using the signed url provided by the job
 */
async function uploadImage(image: string, url: string): Promise<string> {
  await fetch(url, {
    method: "PUT",
    body: Buffer.from(image, "base64"),
    headers: {
      "Content-Type": "image/jpeg",
    },
  });

  // Return the full url, minus the query string
  return url.split("?")[0];
}

/**
 * Uses the status endpoint to get the status of the SDNext server.
 * @returns The status of the SDNext server
 */
async function getServerStatus(): Promise<ServerStatus> {
  const url = new URL("/sdapi/v1/system-info/status?state=true&memory=true&full=true&refresh=true", SDNEXT_URL);
  const response = await fetch(url.toString());
  const json = await response.json();
  return json as ServerStatus;
}

/**
 * 
 * @returns The last 5 lines of the SDNext server logs
 */
async function getSDNextLogs(): Promise<string[]> {
  const url = new URL("/sdapi/v1/log?lines=5&clear=true", SDNEXT_URL);
  const response = await fetch(url.toString());
  const json = await response.json();
  return json as string[];
}

async function enableRefiner(): Promise<void> {
  console.log("Enabling refiner...");
  const url = new URL("/sdapi/v1/options", SDNEXT_URL);
  await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify({"sd_model_refiner": "refiner/sd_xl_refiner_1.0.safetensors"}),
    headers: {
      "Content-Type": "application/json"
    },
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stayAlive = true;
process.on("SIGINT", () => {
  stayAlive = false;
});

process.on("exit", () => {
  /**
   * This is where to put any cleanup code,
   * or a last chance to fire stats off to wherever they live.
   */
});


/**
 * Waits for the SDNext server to start listening at the configured URL.
 */
async function waitForServerToStart(): Promise<void> {
  const maxAttempts = 300;
  let attempts = 0;
  while (stayAlive && attempts++ < maxAttempts) {
    try {
      await getServerStatus();
      return;
    } catch (e) {
      console.log(`(${attempts}/${maxAttempts}) Waiting for server to start...`);
      await sleep(1000);
    }
  }
}

/**
 * Waits for the SDNext server to finish loading the model.
 * This is done by checking the logs for the "Startup time:" line.
 */
async function waitForModelToLoad(): Promise<void> {
  const maxAttempts = 300;
  const maxFailures = 10;
  let attempts = 0;
  let failures = 0;
  while (stayAlive && attempts++ < maxAttempts) {
    try {
      const logLines = await getSDNextLogs();
      if (logLines.some((line) => line.includes("Startup time:"))) {
        return;
      } else if (logLines.length > 0) {
        // prettyPrint(logLines);
      }
        
      console.log(`(${attempts}/${maxAttempts}) Waiting for model to load...`);
    } catch(e: any) {
      
      failures++;
      if (failures > maxFailures) {
        throw e;
      }
      console.log(`(${failures}/${maxFailures}) Request failed. Retrying...`);
    }
    
    await sleep(1000);
  }
  throw new Error("Timed out waiting for model to load");
}



/**
 * This is a helper function to pretty print an object,
 * useful for debugging.
 * @param obj The object to pretty print
 * @returns 
 */
const prettyPrint = (obj: any): void => console.log(JSON.stringify(obj, null, 2));

/**
 * This is the main function that runs the benchmark.
 */
async function main(): Promise<void> {
  const gpu = await getGpuType();
  const systemInfo = {...getSystemInfo(), gpu };
  console.log("System Info:", JSON.stringify(systemInfo));

  const loadStart = Date.now();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await waitForServerToStart();
  await waitForModelToLoad();
  await enableRefiner();

  // This serves as the final pre-flight check
  let response = await submitJob(testJob);

  const loadEnd = Date.now();
  const loadElapsed = loadEnd - loadStart;
  console.log(`Server fully warm in ${loadElapsed}ms`);

  let numImages = 0;
  const start = Date.now();
  while (stayAlive && (benchmarkSize < 0 || numImages < benchmarkSize)) {
    console.log("Fetching Job...");
    const job = await getJob();

    if (!job) {
      console.log("No jobs available. Waiting...");
      await sleep(1000);
      continue;
    }

    const {request, messageId, uploadUrls, jobId } = job;

    console.log("Submitting Job...");
    const jobStart = Date.now();
    response = await submitJob(request);
    const jobEnd = Date.now();
    const jobElapsed = jobEnd - jobStart;
    console.log(`${response.images.length} images generated in ${jobElapsed}ms`);
    // recordResult({numImages: response.images.length, time: jobElapsed, params: request});
    numImages += response.images.length;

    // Handle the image uploads asynchronously, so we can start the next job
    // while the images are uploading.
    Promise.all(response.images.map((image, i) => {
      return uploadImage(image, uploadUrls[i]);
    })).then(async (downloadUrls) => {
      await recordResult({
        id: jobId,
        prompt: request.prompt,
        inference_time: jobElapsed,
        output_urls: downloadUrls,
        system_info: systemInfo
      });
      return downloadUrls;
    }).then((downloadUrls) => {
      markJobComplete(messageId);
      prettyPrint({prompt: request.prompt, inference_time: jobElapsed, output_urls: downloadUrls})
    });
  }

  const end = Date.now();
  const elapsed = end - start;
  if (benchmarkSize > 0) {
    console.log(`Generated ${numImages} images in ${elapsed}ms`);
    console.log(`Average time per image: ${elapsed / numImages}ms`);
  }
}

main();