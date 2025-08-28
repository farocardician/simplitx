FROM node:20-alpine

# Install curl for health checks
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files and install all dependencies
COPY services/web/package*.json ./
RUN npm install

# Copy application code
COPY services/web/ ./

# Change ownership to node user and switch
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Use development mode for hot reload
CMD ["npm", "run", "dev"]