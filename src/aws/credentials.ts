import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';

// 로컬(.env)은 SARAMQUANT_IAM_KEY_* 인라인 키, Fargate는 태스크 롤 기본 체인
export function resolveCredentials(): AwsCredentialIdentityProvider {
  const accessKeyId = process.env.SARAMQUANT_IAM_KEY_ACCESS;
  const secretAccessKey = process.env.SARAMQUANT_IAM_KEY_SECRET;
  if (accessKeyId && secretAccessKey) {
    return async () => ({ accessKeyId, secretAccessKey });
  }
  return fromNodeProviderChain();
}
