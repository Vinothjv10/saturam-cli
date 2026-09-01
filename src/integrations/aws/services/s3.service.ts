import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { resolveAwsClientConfig } from "../utils/aws-credentials.util";

const logger = getLogger("S3Service");

@Service()
export class S3Service {
    private client: import("@aws-sdk/client-s3").S3Client | undefined;

    constructor(private readonly config: ConfigService) {}

    private async getClient(): Promise<import("@aws-sdk/client-s3").S3Client> {
        if (this.client) return this.client;

        const { S3Client } = await import("@aws-sdk/client-s3");
        const cloudConfig = await this.config.getAWSCloudConfig();
        const clientConfig = await resolveAwsClientConfig(cloudConfig);

        this.client = new S3Client(clientConfig);
        return this.client;
    }

    private resolveKey(key: string, prefix?: string): string {
        if (!prefix) return key;
        const normalizedPrefix = prefix.replace(/\/+$/, "");
        return `${normalizedPrefix}/${key.replace(/^\/+/, "")}`;
    }

    /**
     * Fetches an object from the configured S3 bucket (key is relative to the configured prefix, if any).
     */
    public async getObject(key: string): Promise<Buffer> {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        const { bucket, prefix } = await this.config.getS3Config();
        const client = await this.getClient();
        const fullKey = this.resolveKey(key, prefix);

        logger.debug(`Fetching s3://${bucket}/${fullKey}`);

        try {
            const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey }));
            const body = await response.Body?.transformToByteArray();
            if (!body) {
                throw new Error("Empty response body");
            }
            return Buffer.from(body);
        } catch (err) {
            throw new Error(`Failed to get s3://${bucket}/${fullKey}: ${(err as Error).message}`);
        }
    }

    /**
     * Uploads an object to the configured S3 bucket (key is relative to the configured prefix, if any).
     */
    public async putObject(key: string, body: Buffer | string, contentType?: string): Promise<void> {
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        const { bucket, prefix } = await this.config.getS3Config();
        const client = await this.getClient();
        const fullKey = this.resolveKey(key, prefix);

        logger.debug(`Uploading s3://${bucket}/${fullKey}`);

        try {
            await client.send(
                new PutObjectCommand({ Bucket: bucket, Key: fullKey, Body: body, ContentType: contentType }),
            );
        } catch (err) {
            throw new Error(`Failed to put s3://${bucket}/${fullKey}: ${(err as Error).message}`);
        }
    }

    /**
     * Lists object keys in the configured bucket under an optional sub-prefix
     * (appended to the configured prefix, if any).
     */
    public async listObjects(subPrefix?: string): Promise<string[]> {
        const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
        const { bucket, prefix } = await this.config.getS3Config();
        const client = await this.getClient();
        const effectivePrefix = subPrefix ? this.resolveKey(subPrefix, prefix) : prefix;

        try {
            const keys: string[] = [];
            let continuationToken: string | undefined;
            do {
                const response = await client.send(
                    new ListObjectsV2Command({
                        Bucket: bucket,
                        Prefix: effectivePrefix,
                        ContinuationToken: continuationToken,
                    }),
                );
                for (const obj of response.Contents ?? []) {
                    if (obj.Key) keys.push(obj.Key);
                }
                continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (continuationToken);
            return keys;
        } catch (err) {
            throw new Error(`Failed to list s3://${bucket}/${effectivePrefix ?? ""}: ${(err as Error).message}`);
        }
    }
}
