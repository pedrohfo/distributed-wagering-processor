#!/bin/sh
set -eu

echo "Creating SQS queue..."

awslocal sqs create-queue \
  --queue-name backend-events

echo "SQS queue initialized."