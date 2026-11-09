#!/bin/sh
set -eu

# LocalStack ready hook. Create FIFO DLQs before main queues, with redrive policies.
region="${AWS_DEFAULT_REGION:-us-east-1}"

dead_url=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true ContentBasedDeduplication=false MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)
dead_arn=$(awslocal sqs get-queue-attributes --queue-url "$dead_url" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

events_dead_url=$(awslocal sqs create-queue --queue-name wager-events-dlq.fifo \
  --attributes FifoQueue=true ContentBasedDeduplication=false MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)
events_dead_arn=$(awslocal sqs get-queue-attributes --queue-url "$events_dead_url" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true ContentBasedDeduplication=false VisibilityTimeout=60 ReceiveMessageWaitTimeSeconds=10 \
  RedrivePolicy="{\"deadLetterTargetArn\":\"${dead_arn}\",\"maxReceiveCount\":5}" >/dev/null
awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true ContentBasedDeduplication=false \
  RedrivePolicy="{\"deadLetterTargetArn\":\"${events_dead_arn}\",\"maxReceiveCount\":5}" >/dev/null

echo "SQS FIFO queues ready in $region"
