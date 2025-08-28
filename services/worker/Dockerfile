FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy application code
COPY . .

# Change ownership to node user and switch
RUN chown -R node:node /app
USER node

# Start the worker
CMD ["node", "src/index.js"]