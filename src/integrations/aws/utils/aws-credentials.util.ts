import { CloudProviderConfig } from "../../../services/config-service";

export type AwsCredentialsProvider = () => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}>;

export interface AwsClientConfig {
    region: string;
    credentials?: AwsCredentialsProvider;
}

/**
 * Resolves an AWS SDK client region + credentials provider from a CloudProviderConfig.
 * - "profile" auth method uses fromIni({ profile }) (AWS CLI credentials/config files).
 * - "keys" auth method uses the explicit access key/secret (+ optional session token).
 * - Otherwise falls back to the SDK's default credential provider chain (credentials undefined).
 */
export async function resolveAwsClientConfig(cloudConfig: CloudProviderConfig): Promise<AwsClientConfig> {
    if (!cloudConfig.awsRegion) {
        throw new Error("AWS region is not configured. Run 'sat-cli init' and configure AWS cloud settings.");
    }
    const region = cloudConfig.awsRegion;

    if (cloudConfig.awsAuthMethod === "keys" && cloudConfig.awsAccessKeyId && cloudConfig.awsSecretAccessKey) {
        return {
            region,
            credentials: async () => ({
                accessKeyId: cloudConfig.awsAccessKeyId!,
                secretAccessKey: cloudConfig.awsSecretAccessKey!,
                sessionToken: cloudConfig.awsSessionToken,
            }),
        };
    }

    if (cloudConfig.awsProfile) {
        const { fromIni } = await import("@aws-sdk/credential-providers");
        return { region, credentials: fromIni({ profile: cloudConfig.awsProfile }) };
    }

    return { region };
}
