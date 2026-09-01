#!/bin/bash
set -e

rm -rf ./.amplify-hosting
mkdir -p ./.amplify-hosting/compute/default ./.amplify-hosting/static

# Copy app files only — copying ./ recurses into .amplify-hosting itself
cp -r ./*.js ./package.json ./package-lock.json ./node_modules ./.amplify-hosting/compute/default/
[ -f ./.env ] && cp ./.env ./.amplify-hosting/compute/default/.env

# Optional: Static assets if you have any
if [ -d "./public" ]; then
  cp -r ./public/* ./.amplify-hosting/static/
fi

cp deploy-manifest.json ./.amplify-hosting/deploy-manifest.json
