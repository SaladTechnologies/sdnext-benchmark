FROM node:18-slim as build

WORKDIR /app

COPY package*.json .
RUN npm install
COPY . .
RUN npm run build
RUN npx pkg -t node18-linux-x64 --out-path ./benchmark-worker .

FROM saladtechnologies/sdnext-sdxl10:latest

COPY --from=build /app/benchmark-worker ./benchmark-worker

ENTRYPOINT []
CMD [\
  "/bin/bash",\
  "-c",\
  "${INSTALLDIR}/entrypoint.sh \
  --listen \
  --no-download \
  --skip-torch \
  --backend diffusers \
  --use-cuda \
  --skip-requirements \
  --skip-extensions \
  --skip-git \
  --ckpt model.safetensors \
  & benchmark-worker/sdnext-benchmark"]