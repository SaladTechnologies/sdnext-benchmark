# sdnext-benchmark

This project provides a pattern for creating benchmarks with an sdnext container. This example uses a preconfigured [Stable Diffusion XL 1.0 image](https://hub.docker.com/r/saladtechnologies/sdnext-sdxl10).

## Getting Started

To get started with this project, you will need to have Docker installed on your system. Once you have Docker installed, you can run the following command to start the sdnext container:

```bash
docker run --gpus all \
-e BENCHMARK_SIZE=10 \
-e REPORTING_URL=https://someurl.com \
-e REPORTING_API_KEY=1234567890 \
-e BENCHMARK_ID=sdxl-benchmark-0 \
saladtechnologies/sdxl-benchmark:latest
```

or

```bash
docker compose up
```

The `BENCHMARK_SIZE` environment variables can be adjusted to change the size of the benchmark (total images to generate). It can be set to `-1` in order to run the benchmark indefinitely. It should be noted that this is a per-node limit. This value is unaware of other benchmark workers that may be running.

## Build the image

To build the image, run the following command:

```bash
docker buildx build \
-t saladtechnologies/sdxl-benchmark:latest \
--provenance=false \
--output type=docker \
.
```