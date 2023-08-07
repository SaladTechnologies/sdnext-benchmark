FROM node:18-slim as build

WORKDIR /app

# Build a static binary for the benchmark worker
COPY package*.json .
RUN npm install
COPY . .
RUN npm run build
RUN npx pkg -t node18-linux-x64 --out-path ./benchmark-worker .

# And then copy it into the inference image
FROM saladtechnologies/sdnext-sdxl10:latest

COPY --from=build /app/benchmark-worker ./benchmark-worker

# Override the entrypoint to run the benchmark worker
ENTRYPOINT []

# Start the inference server in the background and then run the benchmark worker
CMD [\
  "/bin/bash",\
  "-c",\
  "${INSTALLDIR}/entrypoint.sh \
  --listen \
  --no-download \
  --backend diffusers \
  --use-cuda \
  --ckpt ${CKPT} \
  --docs \
  & benchmark-worker/sdnext-benchmark"]