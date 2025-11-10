# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install git, which is required for installing packages directly from GitHub.
RUN apt-get update && apt-get install -y git

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 8787

# Define the command to run your app
CMD [ "npm", "start" ]
