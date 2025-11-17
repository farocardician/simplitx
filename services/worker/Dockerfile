# Base stage
FROM node:20-alpine AS base
WORKDIR /app

# Dependencies stage
FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Development stage
FROM base AS development
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
RUN chown -R node:node /app
# Run as root in development for file permissions
CMD ["npm", "run", "dev"]

# Production stage  
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN chown -R node:node /app
USER node
CMD ["node", "src/index.js"]