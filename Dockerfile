ARG NODE_IMAGE=node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY --chown=node:node prisma ./prisma
COPY prisma.config.ts ./
COPY --chown=node:node scripts/ci-migrate.cjs scripts/ci-upgrade.cjs scripts/load-env.cjs scripts/admin-operator.cjs scripts/admin-audit-maintain.cjs scripts/admin-data-scope.cjs ./scripts/
COPY --chown=node:node scripts/reviewer-bootstrap.cjs ./scripts/
RUN DATABASE_URL=postgresql://placeholder:placeholder@invalid:5432/homemind DIRECT_URL=postgresql://placeholder:placeholder@invalid:5432/homemind npm run prisma:generate

FROM dependencies AS build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY assets ./assets
RUN npm run typecheck && npm run build

FROM build AS test
COPY test ./test
COPY scripts/auth-secrets.cjs ./scripts/
CMD ["npm", "test"]

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && test -x node_modules/.bin/prisma

FROM dependencies AS runtime-dependencies
RUN npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS deployment-base
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app

FROM deployment-base AS migrator
ARG RELEASE_SHA=development
LABEL org.opencontainers.image.source="https://github.com/PRM392-HOMEMIND/homemind_backend" org.opencontainers.image.revision="${RELEASE_SHA}"
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node scripts/ci-migrate.cjs scripts/ci-upgrade.cjs scripts/load-env.cjs scripts/admin-operator.cjs scripts/admin-audit-maintain.cjs scripts/admin-data-scope.cjs ./scripts/
COPY --chown=node:node scripts/reviewer-bootstrap.cjs ./scripts/
COPY package.json prisma.config.ts ./
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

FROM deployment-base AS runtime
ARG RELEASE_SHA=development
LABEL org.opencontainers.image.source="https://github.com/PRM392-HOMEMIND/homemind_backend" org.opencontainers.image.revision="${RELEASE_SHA}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/assets ./assets
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/load-env.cjs ./scripts/
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

# Stage hardening and non-root security verified by Le Nguyen Quoc Hung
