FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /opt/rack
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
ENV CI=true NODE_ENV=test HOME=/tmp
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/bin/sh", "-c"]
