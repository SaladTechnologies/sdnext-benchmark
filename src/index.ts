import { 
  Text2ImageRequest, 
  Text2ImageResponse, 
  ServerStatus, 
  SDJob, 
  GetJobFromQueueResponse, 
  DeleteQueueMessageResponse 
} from "./types";
import { exec } from "node:child_process";
import os from "node:os";

const {
  SDNEXT_URL = "http://127.0.0.1:7860", 
  BENCHMARK_SIZE = "10", 
  REPORTING_URL = "http://localhost:3000",
  REPORTING_AUTH_HEADER = "Benchmark-Api-Key",
  REPORTING_API_KEY = "abc1234567890",
  BENCHMARK_ID = "test",
  QUEUE_URL = "http://localhost:3001",
  QUEUE_NAME = "test",
} = process.env;

const benchmarkSize = parseInt(BENCHMARK_SIZE, 10);

/**
 * This is the job that will be submitted to the server,
 * set to the configured batch size.
 * 
 * You can change this to whatever you want, and there are a lot
 * of options. See the SDNext API docs for more info.
 */
const testJob: Text2ImageRequest = {
  prompt: "cat",

  // We want to run the base model for 20 steps
  steps: 20,
  width: 1216,
  height: 896,
  send_images: true,
  cfg_scale: 7,

  /**
   * We want to run the refiner for 15 steps, starting at step 20.
   * This requires enabling high resolution, but setting the upscaler to "None".
   *  */ 
  enable_hr: true,
  hr_upscaler: "None",
  
  /**
   * The number of steps run by the refiner is, for some reason,
   * equal to denoising_strength * hr_second_pass_steps.
   */
  refiner_start: 20,
  denoising_strength: 0.43,
  hr_second_pass_steps: 35,
};


/**
 * 
 * @returns The GPU type as reported by nvidia-smi
 */
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

/**
 * 
 * @returns The number of vCPUs and the total memory in GB
 */
function getSystemInfo() : { vCPU: number, MemGB: number } {
  const vCPU = os.cpus().length;
  const MemGB = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100; // Convert bytes to GB and round to 2 decimal places

  return { vCPU, MemGB };
}

/**
 * You can replace this function with your own implementation.
 * Could be submitting stats to a database, or to an api, or just
 * printing to the console.
 * 
 * In this case, we're sending the results to our reporting server.
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
 * This function gets a job from the queue, and returns it in a format that is usable
 * by the SDNext server, along with additional information needed to finish processing the job.
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
      /**
       * We need to return the jobId so we can send it to the reporting server
       * to identify the results of the job.
       */
      jobId: job.id,
      /**
       * We only take the prompt and batch size from the job.
       * The rest of the job is set to the default values.
       *  */ 
      request: {
        ...testJob,
        prompt: job.prompt,
        batch_size: job.batch_size,
      },

      /**
       * We need to return the messageId so we can delete the message
       * from the queue when we're done with it.
       */
      messageId: queueMessage.messages[0].messageId,

      /**
       * We need to return the signed upload urls so we can upload the images
       * to s3 when we're done with them.
       */
      uploadUrls: job.upload_url,
    };

  } else {
    return null;
  }
}

/**
 * Deletes a message from the queue, indicating it does not need to be processed again.
 * @param messageId The id of the message to delete from the queue
 * @returns 
 */
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
 * @param image The image to upload, base64 encoded
 * @param url The signed url to upload the image to
 * 
 * @returns The download url of the uploaded image
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
 * Uses the log endpoint to get the last 5 lines of the SDNext server logs.
 * This is used to determine when the model has finished loading.
 * @returns The last 5 lines of the SDNext server logs
 */
async function getSDNextLogs(): Promise<string[]> {
  const url = new URL("/sdapi/v1/log?lines=5&clear=true", SDNEXT_URL);
  const response = await fetch(url.toString());
  const json = await response.json();
  return json as string[];
}

/**
 * Enables the refiner model. This can take quite a while,
 * but must be done before inference can be run.
 */
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
  /**
   * We get the GPU type and system info before we start the benchmark.
   * We intentionally do not put this in a try/catch block, because if it fails,
   * it means there isn't a gpu available, and we want to fail fast.
   */
  const gpu = await getGpuType();
  const systemInfo = {...getSystemInfo(), gpu };
  console.log("System Info:", JSON.stringify(systemInfo));

  const loadStart = Date.now();

  /**
   * This is where we wait for the server to start and the model to load.
   * It can take several minutes.
   */
  await waitForServerToStart();
  await waitForModelToLoad();
  await enableRefiner();

  /**
   * We run a single job to verify that everything is working.
   */
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

    const { request, messageId, uploadUrls, jobId } = job;

    console.log("Submitting Job...");
    const jobStart = Date.now();
    response = await submitJob(request);
    const jobEnd = Date.now();
    const jobElapsed = jobEnd - jobStart;
    console.log(`${response.images.length} images generated in ${jobElapsed}ms`);
    
    numImages += response.images.length;

    /**
     * By not awaiting this, we can get started on the next job
     * while the images are uploading.
     */
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
      prettyPrint({prompt: request.prompt, inference_time: jobElapsed, output_urls: downloadUrls});
    });
  }

  const end = Date.now();
  const elapsed = end - start;
  if (benchmarkSize > 0) {
    console.log(`Generated ${numImages} images in ${elapsed}ms`);
    console.log(`Average time per image: ${elapsed / numImages}ms`);
  }
}

// Start the benchmark
main();