FROM docker.io/cloudflare/sandbox:0.12.7@sha256:6d741713aef266e8ae0831a5709c6f2d7b77b4952ac79b549f4f4e380af86fbe
# The dev server the container runs: Vite with the Cloudflare plugin, so the
# app inside is itself a Worker served by workerd. Installed from the
# lockfile.
WORKDIR /opt/repro
COPY container/package.json container/package-lock.json ./
RUN npm ci --no-audit --no-fund
