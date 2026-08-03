#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-sikka-bot-test:local}"

podman build -t "$IMAGE_NAME" .
podman run --rm "$IMAGE_NAME" npm run test:unit
