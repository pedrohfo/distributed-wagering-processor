import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsSettings {
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** LocalStack accepts dummy credentials, AWS should use its normal credential chain. */
export function newSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    ...(settings.accessKeyId && settings.secretAccessKey ? {
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    } : {}),
  });
}

export function sqsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SqsSettings {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    ...(env.SQS_ENDPOINT ? { endpoint: env.SQS_ENDPOINT } : {}),
    ...(env.AWS_ACCESS_KEY_ID ? { accessKeyId: env.AWS_ACCESS_KEY_ID } : {}),
    ...(env.AWS_SECRET_ACCESS_KEY ? { secretAccessKey: env.AWS_SECRET_ACCESS_KEY } : {}),
  };
}
