# Base stage
FROM node:20-alpine AS base
RUN apk add --no-cache curl python3 py3-pip
RUN pip3 install --no-cache-dir pandas psycopg2-binary openpyxl fuzzywuzzy python-Levenshtein --break-system-packages
WORKDIR /app

# Dependencies stage
FROM base AS deps
COPY services/web/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Development stage
FROM base AS development
COPY services/web/package*.json ./
RUN npm install
RUN chown -R node:node /app
# Run as root in development for file permissions
EXPOSE 3000
CMD ["npm", "run", "dev"]

# Build stage
FROM base AS build
COPY services/web/package*.json ./
RUN npm install
COPY services/web/ ./
RUN npx prisma generate
RUN npm run build

# Production stage
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY services/web/package*.json ./
COPY services/web/prisma ./prisma
# Create public directory if it doesn't exist
RUN mkdir -p ./public
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]